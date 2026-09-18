/**
 * parallel_write — generates the contents of several INDEPENDENT file-writing jobs concurrently.
 *
 * Tool *dispatch* has always been parallel (loop.ts fans a step's calls through Promise.all). What
 * is serial is token *generation*: inside one assistant message the model emits three write_file
 * bodies one after another in a single autoregressive stream. The only way to produce several file
 * bodies at once is several concurrent generations, which is what this tool does.
 *
 * It also makes the main model's output *smaller*, not just its wall-clock faster. The caller emits
 * a short spec per job (paths + instructions); all bulk content — existing file bodies, shared
 * context — is read from disk here, named by path. Context travels by reference, never through the
 * caller's output-token budget, which removes the dominant cause of truncated tool-call arguments
 * on large batches.
 *
 * LAYERING
 * --------
 * This module imports nothing from the orchestrator. Provider calls and approval both arrive as
 * injected callbacks (ParallelWriteDeps), so `tools/` never depends on the approval manager or the
 * OpenRouter client, and the whole pipeline is unit-testable with stubs that spend no money.
 *
 * ORDERING INVARIANT
 * ------------------
 * Validation that can fail is done BEFORE any provider call, because every worker request costs
 * real money. An overlapping path, a sandbox escape or a missing edit target must cost zero. This
 * mirrors generate_image, which checks the spend cap before its paid call.
 */

import type { ToolResultPayload } from '@shared/types'
import { assertMutationAllowed } from '../../workspace'
import { joinDiffs, makeDiff } from './diff'
import {
  applyPlannedFile,
  currentMtimeMs,
  planMultiEdit,
  planMultiWrite,
  readWithMtime,
  resolveWorkspacePath,
  type MultiEditOp,
  type MultiWriteOp
} from './file-ops'
import {
  buildTruncationRetryNote,
  buildWorkerSystemPrompt,
  buildWorkerUserContent,
  makeNonce,
  parseWorkerOutput,
  type ParsedBlock,
  type WorkerContextFile
} from './parallel-write-protocol'

/** Hard ceiling on concurrent jobs. Each one is a full provider request, so this bounds both the
 *  spend and the connection fan-out of a single tool call. */
export const MAX_PARALLEL_JOBS = 6

/** Ceiling on the total context we'll read and ship to workers. Without it a careless
 *  shared_context_files entry (say, a whole vendored directory) is multiplied by N workers, so one
 *  tool call could quietly cost many times what the caller expected. */
export const MAX_TOTAL_CONTEXT_CHARS = 600_000

/** Per-job deadline. The OpenRouter client has no request timeout of its own, so without this one
 *  wedged provider connection would hang the entire turn indefinitely. */
export const PARALLEL_JOB_TIMEOUT_MS = 180_000

export interface ParallelWriteJob {
  label?: string
  kind: 'write' | 'edit'
  paths: string[]
  context_files?: string[]
  instructions: string
}

export interface WorkerRequest {
  /** byte-identical across every job in a batch — the cacheable prefix */
  systemPrompt: string
  userContent: string
  signal: AbortSignal
}

export interface WorkerResult {
  text: string
  /** prompt tokens the provider reported as cache reads; feeds priming-effectiveness learning */
  cachedTokens?: number
}

export interface JobApprovalRequest {
  jobIndex: number
  label: string
  kind: 'write' | 'edit'
  paths: string[]
  /** bounded unified diff of exactly what this job would write */
  diff: string
}

export interface ParallelWriteDeps {
  /** Runs one worker generation. Injected so this module never imports the OpenRouter client. */
  generate: (req: WorkerRequest) => Promise<WorkerResult>
  /** Queues one approval card for one job and resolves with the human's decision. */
  approve: (req: JobApprovalRequest) => Promise<'approve' | 'reject'>
  /** Optional cache-priming hook, gated by shouldPrimeCache() in openrouter/caching.ts. Resolves
   *  true if it actually sent a priming request, so effectiveness can be judged afterwards. */
  prime?: (systemPrompt: string, jobCount: number) => Promise<boolean>
  /** Reports each worker's cachedTokens after a primed batch, so an ineffective model can be
   *  learned and never primed again this process. */
  onPrimingUsage?: (cachedTokensPerWorker: number[]) => void
  onProgress?: (message: string) => void
  signal?: AbortSignal
  /** Sandbox root for file resolution; undefined means the open project workspace. */
  root?: string
}

type JobStatus = 'applied' | 'rejected' | 'failed'

interface JobOutcome {
  label: string
  kind: 'write' | 'edit'
  paths: string[]
  status: JobStatus
  error?: string
  filesWritten?: string[]
}

// ---------- argument normalization ----------
//
// Deliberately tolerant, for the same reason multi_write is (see normalizeFilesArg): the weak link
// in a batch tool is the shape the model actually sends, and a rejected call wastes a whole turn.
// The one thing NOT guessed at is `kind` — see normalizeKind.

function firstString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function normalizePaths(raw: unknown): string[] {
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return []
    // A JSON-encoded array arrives as a string surprisingly often.
    if (t.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(t)
        if (Array.isArray(parsed)) return normalizePaths(parsed)
      } catch {
        /* fall through to treating it as a single literal path */
      }
    }
    return [t]
  }
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (const v of raw) {
      if (typeof v === 'string' && v.trim()) out.push(v.trim())
      else if (v && typeof v === 'object') {
        const p = firstString(v as Record<string, unknown>, ['path', 'file', 'file_path', 'filePath', 'name'])
        if (p) out.push(p)
      }
    }
    return out
  }
  return []
}

/**
 * `kind` is the one field that is never inferred.
 *
 * Synonyms are accepted, but a missing or unrecognized kind is a hard error rather than a default,
 * because the two values have asymmetric blast radius: guessing 'write' for what was meant as an
 * edit silently replaces an entire existing file with a worker's from-scratch reconstruction of
 * it. There is no cheap way to detect that afterwards, so the call fails loudly instead.
 */
function normalizeKind(raw: unknown): 'write' | 'edit' | null {
  if (typeof raw !== 'string') return null
  switch (raw.trim().toLowerCase()) {
    case 'write':
    case 'create':
    case 'new':
    case 'overwrite':
    case 'replace':
      return 'write'
    case 'edit':
    case 'modify':
    case 'patch':
    case 'update':
    case 'change':
      return 'edit'
    default:
      return null
  }
}

export function normalizeJobsArg(raw: unknown): { ok: true; jobs: ParallelWriteJob[] } | { ok: false; summary: string } {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, summary: 'parallel_write "jobs" was a string that is not valid JSON.' }
    }
  }

  // A single unwrapped job object is accepted as the degenerate one-job form.
  const list: unknown[] = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
  if (list.length === 0) {
    return { ok: false, summary: 'parallel_write requires a non-empty "jobs" array, each entry {kind, paths, instructions}.' }
  }

  const jobs: ParallelWriteJob[] = []
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (!entry || typeof entry !== 'object') {
      return { ok: false, summary: `parallel_write job ${i + 1} is not an object.` }
    }
    const rec = entry as Record<string, unknown>
    const kind = normalizeKind(rec.kind ?? rec.type ?? rec.mode ?? rec.action)
    if (!kind) {
      return {
        ok: false,
        summary: `parallel_write job ${i + 1} needs an explicit "kind" of "write" (produce a file's full contents) or "edit" (change part of an existing file). It is never inferred, because guessing "write" for an intended edit would overwrite the whole file.`
      }
    }
    const paths = normalizePaths(rec.paths ?? rec.path ?? rec.files ?? rec.file)
    if (paths.length === 0) {
      return { ok: false, summary: `parallel_write job ${i + 1} ("${String(rec.label ?? kind)}") lists no paths.` }
    }
    const instructions = firstString(rec, ['instructions', 'instruction', 'task', 'prompt', 'description', 'detail'])
    if (!instructions) {
      return {
        ok: false,
        summary: `parallel_write job ${i + 1} (${paths.join(', ')}) has no "instructions". A worker sees only what you write here plus the context files you name — it cannot see this conversation.`
      }
    }
    const label = firstString(rec, ['label', 'name', 'title']) ?? paths[0]
    jobs.push({
      label,
      kind,
      paths,
      context_files: normalizePaths(rec.context_files ?? rec.contextFiles ?? rec.context),
      instructions
    })
  }
  return { ok: true, jobs }
}

// ---------- per-job deadline ----------

/** Chains a per-job deadline onto the turn's abort signal. Both sources abort the job; nothing
 *  else can outlive PARALLEL_JOB_TIMEOUT_MS. */
function jobSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`job exceeded ${Math.round(timeoutMs / 1000)}s deadline`)), timeoutMs)
  const onParentAbort = (): void => ac.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) ac.abort(parent.reason)
    else parent.addEventListener('abort', onParentAbort, { once: true })
  }
  return {
    signal: ac.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    }
  }
}

// ---------- main ----------

export async function parallelWriteTool(
  rawArgs: Record<string, unknown>,
  deps: ParallelWriteDeps
): Promise<ToolResultPayload> {
  const root = deps.root

  // ----- Phase 1: validate everything that can fail, before spending a cent -----
  const norm = normalizeJobsArg(rawArgs.jobs ?? rawArgs.job ?? rawArgs)
  if (!norm.ok) return { ok: false, summary: norm.summary, error: 'invalid_args' }
  const jobs = norm.jobs

  if (jobs.length > MAX_PARALLEL_JOBS) {
    return {
      ok: false,
      summary: `parallel_write accepts at most ${MAX_PARALLEL_JOBS} jobs per call (got ${jobs.length}). Group related files into fewer jobs, or make a second call.`,
      error: 'too_many_jobs'
    }
  }

  // Resolve + sandbox-check every path, and reject any path claimed by two jobs. The
  // no-overlap rule is what makes "independent" structurally true rather than a convention:
  // with it, two concurrent jobs cannot race on one file, so no intra-call write race exists.
  const absByJob: string[][] = []
  const claimedBy = new Map<string, number>()
  for (let j = 0; j < jobs.length; j++) {
    const abs: string[] = []
    for (const p of jobs[j].paths) {
      let resolved: string
      try {
        resolved = resolveWorkspacePath(p, root)
      } catch (e) {
        // Only thrown for a structurally invalid path (empty/non-string, or relative with no
        // workspace open) — never for a sandbox violation.
        return {
          ok: false,
          summary: `parallel_write job ${j + 1} ("${jobs[j].label}") cannot write ${p}: ${(e as Error).message}`,
          error: 'path_not_allowed'
        }
      }
      // assertMutationAllowed RETURNS false for an out-of-sandbox path, it does not throw (see
      // writeFileTool, which branches on its return value). Calling it bare inside the try/catch
      // above therefore accepted `../escape.ts` silently — a real sandbox escape, caught by
      // parallel-write.test.ts's out-of-sandbox case. The return value must be checked.
      if (!assertMutationAllowed(resolved, root)) {
        return {
          ok: false,
          summary: `parallel_write job ${j + 1} ("${jobs[j].label}") cannot write ${p}: that path is outside the allowed sandbox (${root ? 'the Documents directory' : 'the open workspace'}, plus ~/.klenny and Klenny's own userData).`,
          error: 'path_not_allowed'
        }
      }
      const prior = claimedBy.get(resolved)
      if (prior !== undefined) {
        return {
          ok: false,
          summary: `parallel_write jobs ${prior + 1} and ${j + 1} both target ${p}. Jobs must be independent — no file may appear in two jobs. Put dependent changes to one file in a single job, or use multi_edit.`,
          error: 'overlapping_paths'
        }
      }
      claimedBy.set(resolved, j)
      abs.push(resolved)
    }
    absByJob.push(abs)
  }

  // ----- Phase 2: read all context once, snapshotting mtimes -----
  // The snapshot (not fileReadCache) is the authority for the pre-write staleness check in
  // Phase 7: generation plus human approval can take minutes, and a file edited in that window
  // must not be silently clobbered with content derived from its older self.
  const mtimeSnapshot = new Map<string, number | null>()
  const contentCache = new Map<string, string | null>()
  let contextChars = 0

  const readOnce = async (abs: string): Promise<string | null> => {
    if (contentCache.has(abs)) return contentCache.get(abs) ?? null
    const got = await readWithMtime(abs)
    contentCache.set(abs, got?.content ?? null)
    mtimeSnapshot.set(abs, got?.mtimeMs ?? null)
    if (got) contextChars += got.content.length
    return got?.content ?? null
  }

  // Every target gets an mtime snapshot, including not-yet-existing files for write jobs: if such
  // a file appears between now and the write, something else created it and blindly overwriting
  // would destroy that work.
  for (const abs of absByJob.flat()) {
    if (!mtimeSnapshot.has(abs)) mtimeSnapshot.set(abs, await currentMtimeMs(abs))
  }

  // Edit targets must already exist — an edit job has nothing to patch otherwise, and this is far
  // cheaper to catch now than after paying for a generation.
  for (let j = 0; j < jobs.length; j++) {
    if (jobs[j].kind !== 'edit') continue
    for (let i = 0; i < absByJob[j].length; i++) {
      const content = await readOnce(absByJob[j][i])
      if (content === null) {
        return {
          ok: false,
          summary: `parallel_write job ${j + 1} ("${jobs[j].label}") is an edit job but ${jobs[j].paths[i]} does not exist. Use kind "write" to create it.`,
          error: 'edit_target_missing'
        }
      }
    }
  }

  const sharedContextFiles: WorkerContextFile[] = []
  for (const p of normalizePaths(rawArgs.shared_context_files ?? rawArgs.sharedContextFiles)) {
    let abs: string
    try {
      abs = resolveWorkspacePath(p, root)
    } catch (e) {
      return { ok: false, summary: `parallel_write shared_context_files: ${(e as Error).message}`, error: 'invalid_args' }
    }
    const content = await readOnce(abs)
    if (content === null) {
      return { ok: false, summary: `parallel_write shared_context_files: ${p} could not be read.`, error: 'context_unreadable' }
    }
    sharedContextFiles.push({ path: p, content })
  }

  const perJobContext: WorkerContextFile[][] = []
  for (const job of jobs) {
    const files: WorkerContextFile[] = []
    for (const p of job.context_files ?? []) {
      let abs: string
      try {
        abs = resolveWorkspacePath(p, root)
      } catch {
        continue
      }
      const content = await readOnce(abs)
      // A missing per-job context file is a soft miss: the job may still be well-specified, and
      // the worker's ERROR escape hatch will refuse loudly if it genuinely needed that file.
      if (content !== null) files.push({ path: p, content })
    }
    perJobContext.push(files)
  }

  if (contextChars > MAX_TOTAL_CONTEXT_CHARS) {
    return {
      ok: false,
      summary: `parallel_write would ship ~${Math.round(contextChars / 1000)}k characters of context to each of ${jobs.length} workers, over the ${Math.round(MAX_TOTAL_CONTEXT_CHARS / 1000)}k cap. Name fewer/smaller context files.`,
      error: 'context_too_large'
    }
  }

  // ----- Phase 3: build the shared prefix, optionally prime, then fan out -----
  const nonce = makeNonce()
  const systemPrompt = buildWorkerSystemPrompt({
    nonce,
    sharedContext: typeof rawArgs.shared_context === 'string' ? rawArgs.shared_context : undefined,
    contextFiles: sharedContextFiles
  })

  let primed = false
  if (deps.prime) {
    try {
      primed = await deps.prime(systemPrompt, jobs.length)
    } catch {
      // Priming is a pure optimization; never let it fail the real work.
      primed = false
    }
  }

  deps.onProgress?.(
    `Generating ${absByJob.flat().length} file(s) across ${jobs.length} concurrent job(s)${primed ? ' (cache primed)' : ''}…`
  )

  const cachedTokensPerWorker: number[] = []

  const runJob = async (jobIndex: number): Promise<JobOutcome> => {
    const job = jobs[jobIndex]
    const abs = absByJob[jobIndex]
    const base: Omit<JobOutcome, 'status'> = { label: job.label ?? job.paths[0], kind: job.kind, paths: job.paths }
    const fail = (error: string): JobOutcome => ({ ...base, status: 'failed', error })

    const targets: WorkerContextFile[] =
      job.kind === 'edit'
        ? job.paths.map((p, i) => ({ path: p, content: contentCache.get(abs[i]) ?? '' }))
        : []

    let userContent = buildWorkerUserContent(
      { kind: job.kind, paths: job.paths, instructions: job.instructions, targets },
      nonce
    )
    // Per-job context rides the user message, never the shared system prompt — putting it in the
    // prefix would make the prefix differ per job and silently destroy cache reuse for the batch.
    if (perJobContext[jobIndex].length > 0) {
      const extra = perJobContext[jobIndex].map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n')
      userContent += `\n\nAdditional reference files for this job only:\n\n${extra}`
    }

    // ----- Phase 4: generate + parse, with one informed retry on truncation -----
    let blocks: ParsedBlock[] | null = null
    let lastError = ''
    for (let attempt = 0; attempt < 2 && blocks === null; attempt++) {
      if (deps.signal?.aborted) return fail('aborted before generation')
      const { signal, dispose } = jobSignal(deps.signal, PARALLEL_JOB_TIMEOUT_MS)
      let result: WorkerResult
      try {
        result = await deps.generate({
          systemPrompt,
          userContent: attempt === 0 ? userContent : `${userContent}\n\n${buildTruncationRetryNote(nonce)}`,
          signal
        })
      } catch (e) {
        return fail(`worker request failed: ${(e as Error).message}`)
      } finally {
        dispose()
      }
      if (typeof result.cachedTokens === 'number') cachedTokensPerWorker.push(result.cachedTokens)

      const parsed = parseWorkerOutput(result.text, nonce)
      if (parsed.ok) {
        blocks = parsed.blocks
        break
      }
      lastError = parsed.summary
      // Only truncation is worth paying for again: a worker_error is a considered refusal, and
      // empty/malformed output would very likely repeat identically.
      if (parsed.reason !== 'truncated') return fail(parsed.summary)
    }
    if (blocks === null) return fail(lastError || 'worker produced no usable output')

    // A worker must not touch files outside its own job — that would break the no-overlap
    // guarantee that makes concurrency safe in the first place.
    const allowed = new Set(job.paths)
    const stray = blocks.filter((b) => !allowed.has(b.path))
    if (stray.length > 0) {
      return fail(`worker emitted blocks for files outside its job: ${[...new Set(stray.map((s) => s.path))].join(', ')}`)
    }

    // ----- Phase 5: stage in memory via the existing planners (no writes yet) -----
    // Reusing planMultiWrite/planMultiEdit inherits fuzzy matching, EOL preservation, sandbox
    // re-checks and all-or-nothing semantics rather than reimplementing any of it.
    let planned: { path: string; abs: string; eol: import('./eol').Eol; oldContent: string; newContent: string }[]
    if (job.kind === 'write') {
      const ops: MultiWriteOp[] = blocks
        .filter((b): b is Extract<ParsedBlock, { kind: 'file' }> => b.kind === 'file')
        .map((b) => ({ path: b.path, content: b.content }))
      if (ops.length === 0) return fail('worker emitted no KLENNY-FILE blocks for a write job')
      const plan = await planMultiWrite(ops, root)
      if (!plan.ok) return fail(plan.summary)
      planned = plan.files
    } else {
      const ops: MultiEditOp[] = blocks
        .filter((b): b is Extract<ParsedBlock, { kind: 'edit' }> => b.kind === 'edit')
        .map((b) => ({ path: b.path, old_string: b.oldString, new_string: b.newString }))
      if (ops.length === 0) return fail('worker emitted no KLENNY-EDIT blocks for an edit job')
      // checkStale: false — our Phase 2 mtime snapshot is the authority here, and it is stricter.
      // fileReadCache may hold an entry from a much earlier read of this path (or none at all),
      // which would produce a spurious 'stale' failure for content we just read ourselves.
      const plan = await planMultiEdit(ops, false, root)
      if (!plan.ok) return fail(plan.summary)
      planned = plan.files
    }

    // ----- Phase 6: one approval card per job, carrying this job's own bounded diff -----
    const diff = joinDiffs(planned.map((f) => makeDiff(f.oldContent, f.newContent, f.path)))
    const decision = await deps.approve({
      jobIndex,
      label: job.label ?? job.paths[0],
      kind: job.kind,
      paths: job.paths,
      diff
    })
    if (decision === 'reject') return { ...base, status: 'rejected' }

    // ----- Phase 7: re-verify against the snapshot, then apply -----
    for (const f of planned) {
      const before = mtimeSnapshot.get(f.abs)
      const now = await currentMtimeMs(f.abs)
      if (before !== undefined && now !== before) {
        return fail(
          `${f.path} changed on disk after parallel_write read it (stale), so nothing was written for this job. Re-read the file and retry.`
        )
      }
    }
    if (deps.signal?.aborted) return fail('aborted before writing')
    for (const f of planned) {
      // applyPlannedFile also refreshes fileReadCache, without which the NEXT turn's edit_file on
      // this path would fail with a spurious 'stale' error.
      await applyPlannedFile(f, { mkdirs: job.kind === 'write' })
    }
    return { ...base, status: 'applied', filesWritten: planned.map((f) => f.path) }
  }

  // Each job runs its own generate → stage → approve → apply pipeline, so a fast job's approval
  // card appears while slower jobs are still generating. Promise.all means the tool call cannot
  // resolve — and therefore the model's next step cannot start — until every job has been
  // approved or rejected and applied or failed.
  const settled = await Promise.all(
    jobs.map((_, i) =>
      runJob(i).catch(
        (e: unknown): JobOutcome => ({
          label: jobs[i].label ?? jobs[i].paths[0],
          kind: jobs[i].kind,
          paths: jobs[i].paths,
          status: 'failed',
          error: (e as Error).message
        })
      )
    )
  )

  if (primed) deps.onPrimingUsage?.(cachedTokensPerWorker)

  // ----- Phase 8: one bounded payload -----
  // Raw worker output is deliberately never stored, only bounded diffs — see the 61 MB
  // session-log incident behind tools/diff.ts's clamping.
  const applied = settled.filter((o) => o.status === 'applied')
  const rejected = settled.filter((o) => o.status === 'rejected')
  const failed = settled.filter((o) => o.status === 'failed')
  const writtenPaths = applied.flatMap((o) => o.filesWritten ?? [])

  const parts = [`${applied.length}/${settled.length} job(s) applied`]
  if (writtenPaths.length > 0) parts.push(`wrote ${writtenPaths.join(', ')}`)
  if (rejected.length > 0) parts.push(`${rejected.length} rejected`)
  if (failed.length > 0) parts.push(`${failed.length} failed`)

  return {
    ok: applied.length > 0 || settled.length === rejected.length,
    summary: parts.join('; '),
    ...(failed.length > 0 && applied.length === 0 ? { error: 'all_jobs_failed' } : {}),
    data: {
      jobs: settled.map((o) => ({
        label: o.label,
        kind: o.kind,
        paths: o.paths,
        status: o.status,
        ...(o.error ? { error: o.error } : {})
      })),
      paths: writtenPaths
    }
  }
}
