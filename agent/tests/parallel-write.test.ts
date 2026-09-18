import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

import {
  makeNonce,
  parseWorkerOutput,
  buildWorkerSystemPrompt,
  buildWorkerUserContent,
  buildTruncationRetryNote
} from '../src/main/agent/tools/parallel-write-protocol'

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-parallelwrite-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-parallelwrite-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

// ---------- helpers ----------

/** The tool generates its own nonce internally, so a stub worker has to read it back out of the
 *  system prompt it was handed — exactly as a real worker would. */
function nonceFrom(systemPrompt: string): string {
  const m = /<<<KLENNY-FILE:([0-9a-f]+) path=/.exec(systemPrompt)
  if (!m) throw new Error('no nonce found in worker system prompt')
  return m[1]
}

function fileBlock(nonce: string, path: string, content: string): string {
  return `<<<KLENNY-FILE:${nonce} path=${path}>>>\n${content}\n<<<KLENNY-END:${nonce}>>>`
}

function editBlock(nonce: string, path: string, oldString: string, newString: string): string {
  return `<<<KLENNY-EDIT:${nonce} path=${path}>>>\n<<<OLD:${nonce}>>>\n${oldString}\n<<<NEW:${nonce}>>>\n${newString}\n<<<KLENNY-END:${nonce}>>>`
}

// ---------- protocol: parsing ----------

describe('parseWorkerOutput', () => {
  const nonce = 'abc123abc123'

  test('parses a single complete file block, preserving the trailing newline', () => {
    const out = parseWorkerOutput(fileBlock(nonce, 'src/a.ts', 'export const a = 1\n'), nonce)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.blocks).toEqual([{ kind: 'file', path: 'src/a.ts', content: 'export const a = 1\n' }])
  })

  test('parses several file blocks from one reply', () => {
    const raw = [fileBlock(nonce, 'a.ts', 'a\n'), fileBlock(nonce, 'b.ts', 'b\n')].join('\n')
    const out = parseWorkerOutput(raw, nonce)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.blocks.map((b) => b.path)).toEqual(['a.ts', 'b.ts'])
  })

  test('parses an edit block into old/new strings', () => {
    const out = parseWorkerOutput(editBlock(nonce, 'a.ts', 'const x = 1', 'const x = 2'), nonce)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.blocks).toEqual([{ kind: 'edit', path: 'a.ts', oldString: 'const x = 1', newString: 'const x = 2' }])
  })

  test('a block whose closing sentinel never arrived is truncation, not partial content', () => {
    const raw = `<<<KLENNY-FILE:${nonce} path=a.ts>>>\nexport const a = 1\n`
    const out = parseWorkerOutput(raw, nonce)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('truncated')
    // The message must say nothing was applied — it's shown to the model on the retry.
    expect(out.summary).toContain('Nothing was applied')
  })

  // The whole reason for a per-call nonce: this repo's own agent writes code ABOUT this protocol.
  test('content containing a foreign-nonce sentinel and a bare sentinel prefix is preserved verbatim', () => {
    const body = [
      'const FILE_OPEN = /^<<<KLENNY-FILE:(.+) path=(.+)>>>$/',
      `<<<KLENNY-FILE:deadbeefdead path=evil.ts>>>`,
      `<<<KLENNY-END:deadbeefdead>>>`,
      '<<<KLENNY-FILE',
      ''
    ].join('\n')
    const out = parseWorkerOutput(fileBlock(nonce, 'parser.ts', body), nonce)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.blocks.length).toBe(1)
    expect(out.blocks[0].path).toBe('parser.ts')
    expect((out.blocks[0] as { content: string }).content).toBe(body)
  })

  test('CRLF worker output parses identically to LF', () => {
    const lf = parseWorkerOutput(fileBlock(nonce, 'a.ts', 'line1\nline2\n'), nonce)
    const crlf = parseWorkerOutput(fileBlock(nonce, 'a.ts', 'line1\nline2\n').replace(/\n/g, '\r\n'), nonce)
    expect(crlf).toEqual(lf)
  })

  test('a BOM before the first sentinel does not hide the block', () => {
    const out = parseWorkerOutput(`\ufeff${fileBlock(nonce, 'a.ts', 'x\n')}`, nonce)
    expect(out.ok).toBe(true)
  })

  test('an ERROR: line with no blocks is a considered refusal, not an empty reply', () => {
    const out = parseWorkerOutput('ERROR: I was never shown the Foo interface.', nonce)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('worker_error')
    expect(out.summary).toContain('Foo interface')
  })

  test('an ERROR-looking line INSIDE file content is content, not a refusal', () => {
    const out = parseWorkerOutput(fileBlock(nonce, 'a.ts', 'ERROR: this is a log message\n'), nonce)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect((out.blocks[0] as { content: string }).content).toBe('ERROR: this is a log message\n')
  })

  test('no blocks and no error is empty', () => {
    const out = parseWorkerOutput('Sure! I can help with that.', nonce)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('empty')
  })

  test('a closing sentinel with no open block is malformed', () => {
    const out = parseWorkerOutput(`<<<KLENNY-END:${nonce}>>>`, nonce)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('malformed')
  })

  test('an edit block that ends without a NEW section is malformed, never applied as-is', () => {
    const raw = `<<<KLENNY-EDIT:${nonce} path=a.ts>>>\n<<<OLD:${nonce}>>>\nsomething\n<<<KLENNY-END:${nonce}>>>`
    const out = parseWorkerOutput(raw, nonce)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('malformed')
  })

  test('a stray markdown fence between blocks is ignored', () => {
    const raw = `\`\`\`ts\n${fileBlock(nonce, 'a.ts', 'x\n')}\n\`\`\``
    const out = parseWorkerOutput(raw, nonce)
    expect(out.ok).toBe(true)
  })

  test('a missing OLD marker is tolerated as "old text starts here" rather than corrupting the edit', () => {
    const raw = `<<<KLENNY-EDIT:${nonce} path=a.ts>>>\nconst x = 1\n<<<NEW:${nonce}>>>\nconst x = 2\n<<<KLENNY-END:${nonce}>>>`
    const out = parseWorkerOutput(raw, nonce)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.blocks[0]).toEqual({ kind: 'edit', path: 'a.ts', oldString: 'const x = 1', newString: 'const x = 2' })
  })

  test('makeNonce produces distinct hex nonces', () => {
    expect(makeNonce()).not.toBe(makeNonce())
    expect(makeNonce()).toMatch(/^[0-9a-f]{12}$/)
  })
})

// ---------- protocol: prompt shape (cache safety) ----------

describe('worker prompt split', () => {
  test('the system prompt is byte-identical across jobs of a batch; per-job detail lives only in user content', () => {
    const nonce = makeNonce()
    const shared = { nonce, sharedContext: 'Use tabs.', contextFiles: [{ path: 'types.ts', content: 'export type A = 1\n' }] }
    // Built independently, as the tool does once per batch — must be byte-identical either way.
    expect(buildWorkerSystemPrompt(shared)).toBe(buildWorkerSystemPrompt({ ...shared }))

    const sys = buildWorkerSystemPrompt(shared)
    const jobA = buildWorkerUserContent({ kind: 'write', paths: ['a.ts'], instructions: 'Make A.' }, nonce)
    const jobB = buildWorkerUserContent({ kind: 'write', paths: ['b.ts'], instructions: 'Make B.' }, nonce)
    expect(jobA).not.toBe(jobB)
    // No job-specific token may leak into the shared prefix, or cache reuse silently dies.
    expect(sys).not.toContain('a.ts')
    expect(sys).not.toContain('Make A.')
    expect(sys).toContain('Use tabs.')
    expect(sys).toContain('export type A = 1')
  })

  test('an edit job ships its target contents in the user message, not the shared prefix', () => {
    const nonce = makeNonce()
    const user = buildWorkerUserContent(
      { kind: 'edit', paths: ['a.ts'], instructions: 'Rename x to y.', targets: [{ path: 'a.ts', content: 'const x = 1\n' }] },
      nonce
    )
    expect(user).toContain('const x = 1')
    expect(buildWorkerSystemPrompt({ nonce, contextFiles: [] })).not.toContain('const x = 1')
  })

  test('the truncation retry note states that nothing was applied and points at cheaper edit blocks', () => {
    const note = buildTruncationRetryNote('abc123abc123')
    expect(note).toContain('NOTHING was applied')
    expect(note).toContain('KLENNY-EDIT')
  })
})

// ---------- argument tolerance ----------

describe('normalizeJobsArg', () => {
  test('accepts a real array', async () => {
    const { normalizeJobsArg } = await import('../src/main/agent/tools/parallel-write')
    const out = normalizeJobsArg([{ kind: 'write', paths: ['a.ts'], instructions: 'do it' }])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.jobs.length).toBe(1)
    expect(out.jobs[0].label).toBe('a.ts') // falls back to the first path
  })

  test('accepts a JSON-encoded array string', async () => {
    const { normalizeJobsArg } = await import('../src/main/agent/tools/parallel-write')
    const out = normalizeJobsArg(JSON.stringify([{ kind: 'write', paths: ['a.ts'], instructions: 'do it' }]))
    expect(out.ok).toBe(true)
  })

  test('accepts a single unwrapped job object', async () => {
    const { normalizeJobsArg } = await import('../src/main/agent/tools/parallel-write')
    const out = normalizeJobsArg({ kind: 'write', paths: 'a.ts', instructions: 'do it' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.jobs[0].paths).toEqual(['a.ts'])
  })

  test('accepts per-entry key aliases', async () => {
    const { normalizeJobsArg } = await import('../src/main/agent/tools/parallel-write')
    const out = normalizeJobsArg([{ type: 'modify', file: 'a.ts', task: 'tweak it', name: 'tweak' }])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.jobs[0]).toMatchObject({ kind: 'edit', paths: ['a.ts'], instructions: 'tweak it', label: 'tweak' })
  })

  // kind is the one field never guessed at: inferring 'write' for an intended edit would replace
  // a whole existing file with a from-scratch reconstruction.
  test('a missing or unrecognized kind is a hard error, never defaulted', async () => {
    const { normalizeJobsArg } = await import('../src/main/agent/tools/parallel-write')
    for (const bad of [{ paths: ['a.ts'], instructions: 'x' }, { kind: 'append', paths: ['a.ts'], instructions: 'x' }]) {
      const out = normalizeJobsArg([bad])
      expect(out.ok).toBe(false)
      if (out.ok) continue
      expect(out.summary).toContain('kind')
    }
  })

  test('missing instructions or paths is rejected', async () => {
    const { normalizeJobsArg } = await import('../src/main/agent/tools/parallel-write')
    expect(normalizeJobsArg([{ kind: 'write', paths: ['a.ts'] }]).ok).toBe(false)
    expect(normalizeJobsArg([{ kind: 'write', instructions: 'x' }]).ok).toBe(false)
    expect(normalizeJobsArg([]).ok).toBe(false)
  })
})

// ---------- pipeline ----------

interface StubCall {
  systemPrompt: string
  userContent: string
}

/** Records every worker request and replies with whatever the per-test responder returns. */
function stubDeps(
  respond: (call: StubCall, nonce: string) => string,
  extra: { approve?: (req: { jobIndex: number }) => Promise<'approve' | 'reject'> | 'approve' | 'reject' } = {}
): {
  deps: Record<string, unknown>
  calls: StubCall[]
} {
  const calls: StubCall[] = []
  return {
    calls,
    deps: {
      generate: async (req: StubCall) => {
        calls.push({ systemPrompt: req.systemPrompt, userContent: req.userContent })
        return { text: respond(req, nonceFrom(req.systemPrompt)), cachedTokens: 0 }
      },
      approve: async (req: { jobIndex: number }) => (extra.approve ? await extra.approve(req) : 'approve')
    }
  }
}

describe('parallelWriteTool — validation before any spend', () => {
  test('two jobs claiming the same path is rejected and no worker runs', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const { deps, calls } = stubDeps(() => '')
    const res = await parallelWriteTool(
      {
        jobs: [
          { kind: 'write', paths: ['overlap/a.ts'], instructions: 'x' },
          { kind: 'write', paths: ['overlap/a.ts'], instructions: 'y' }
        ]
      },
      deps as never
    )
    expect(res.ok).toBe(false)
    expect(res.error).toBe('overlapping_paths')
    expect(calls.length).toBe(0) // the whole point: an invalid call costs zero
  })

  test('a path outside the sandbox is rejected before spending', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const { deps, calls } = stubDeps(() => '')
    const res = await parallelWriteTool({ jobs: [{ kind: 'write', paths: ['../escape.ts'], instructions: 'x' }] }, deps as never)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('path_not_allowed')
    expect(calls.length).toBe(0)
  })

  test('an edit job whose target does not exist is rejected before spending', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const { deps, calls } = stubDeps(() => '')
    const res = await parallelWriteTool({ jobs: [{ kind: 'edit', paths: ['nope/missing.ts'], instructions: 'x' }] }, deps as never)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('edit_target_missing')
    expect(calls.length).toBe(0)
  })

  test('more jobs than the cap is rejected before spending', async () => {
    const { parallelWriteTool, MAX_PARALLEL_JOBS } = await import('../src/main/agent/tools/index')
    const { deps, calls } = stubDeps(() => '')
    const jobs = Array.from({ length: MAX_PARALLEL_JOBS + 1 }, (_, i) => ({
      kind: 'write' as const,
      paths: [`cap/f${i}.ts`],
      instructions: 'x'
    }))
    const res = await parallelWriteTool({ jobs }, deps as never)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('too_many_jobs')
    expect(calls.length).toBe(0)
  })
})

describe('parallelWriteTool — generation, approval and application', () => {
  test('applies several independent write jobs concurrently', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const { deps, calls } = stubDeps((call, nonce) =>
      call.userContent.includes('fan/a.ts') ? fileBlock(nonce, 'fan/a.ts', 'A\n') : fileBlock(nonce, 'fan/b.ts', 'B\n')
    )
    const res = await parallelWriteTool(
      {
        jobs: [
          { label: 'job A', kind: 'write', paths: ['fan/a.ts'], instructions: 'make A' },
          { label: 'job B', kind: 'write', paths: ['fan/b.ts'], instructions: 'make B' }
        ]
      },
      deps as never
    )
    expect(res.ok).toBe(true)
    expect(calls.length).toBe(2)
    // One shared prefix, byte-identical across both workers — the caching contract.
    expect(calls[0].systemPrompt).toBe(calls[1].systemPrompt)
    expect(await readFile(join(workspaceDir, 'fan/a.ts'), 'utf8')).toBe('A\n')
    expect(await readFile(join(workspaceDir, 'fan/b.ts'), 'utf8')).toBe('B\n')
  })

  test('one job failing does not stop its siblings (per-job isolation)', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    // The 'bad' job is truncated on both its attempts; the 'good' job is fine.
    const { deps } = stubDeps((call, nonce) =>
      call.userContent.includes('iso/good.ts')
        ? fileBlock(nonce, 'iso/good.ts', 'good\n')
        : `<<<KLENNY-FILE:${nonce} path=iso/bad.ts>>>\nhalf a file`
    )
    const res = await parallelWriteTool(
      {
        jobs: [
          { label: 'good', kind: 'write', paths: ['iso/good.ts'], instructions: 'x' },
          { label: 'bad', kind: 'write', paths: ['iso/bad.ts'], instructions: 'y' }
        ]
      },
      deps as never
    )
    const jobs = (res.data as { jobs: { label: string; status: string }[] }).jobs
    expect(jobs.find((j) => j.label === 'good')?.status).toBe('applied')
    expect(jobs.find((j) => j.label === 'bad')?.status).toBe('failed')
    expect(await readFile(join(workspaceDir, 'iso/good.ts'), 'utf8')).toBe('good\n')
    await expect(stat(join(workspaceDir, 'iso/bad.ts'))).rejects.toThrow()
  })

  test('a truncated first attempt is retried exactly once with an informed note', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    let attempt = 0
    const { deps, calls } = stubDeps((_call, nonce) => {
      attempt++
      return attempt === 1
        ? `<<<KLENNY-FILE:${nonce} path=retry/a.ts>>>\ncut off`
        : fileBlock(nonce, 'retry/a.ts', 'recovered\n')
    })
    const res = await parallelWriteTool({ jobs: [{ kind: 'write', paths: ['retry/a.ts'], instructions: 'x' }] }, deps as never)
    expect(res.ok).toBe(true)
    expect(calls.length).toBe(2)
    expect(calls[1].userContent).toContain('NOTHING was applied')
    expect(await readFile(join(workspaceDir, 'retry/a.ts'), 'utf8')).toBe('recovered\n')
  })

  test('a worker emitting a block for a file outside its job writes nothing for that job', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const { deps } = stubDeps((_call, nonce) => fileBlock(nonce, 'stray/elsewhere.ts', 'nope\n'))
    const res = await parallelWriteTool({ jobs: [{ kind: 'write', paths: ['stray/mine.ts'], instructions: 'x' }] }, deps as never)
    expect(res.ok).toBe(false)
    const jobs = (res.data as { jobs: { status: string; error?: string }[] }).jobs
    expect(jobs[0].status).toBe('failed')
    expect(jobs[0].error).toContain('outside its job')
    await expect(stat(join(workspaceDir, 'stray/elsewhere.ts'))).rejects.toThrow()
  })

  test('rejecting one job of three writes nothing for it and everything for the others', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const decisions: number[] = []
    const { deps } = stubDeps(
      (call, nonce) => {
        const which = /rej\/(\w+)\.ts/.exec(call.userContent)![1]
        return fileBlock(nonce, `rej/${which}.ts`, `${which}\n`)
      },
      {
        approve: (req) => {
          decisions.push(req.jobIndex)
          return req.jobIndex === 1 ? 'reject' : 'approve'
        }
      }
    )
    const res = await parallelWriteTool(
      {
        jobs: [
          { label: 'one', kind: 'write', paths: ['rej/one.ts'], instructions: 'x' },
          { label: 'two', kind: 'write', paths: ['rej/two.ts'], instructions: 'y' },
          { label: 'three', kind: 'write', paths: ['rej/three.ts'], instructions: 'z' }
        ]
      },
      deps as never
    )
    // Every job awaited its own decision before the call could resolve.
    expect(decisions.sort()).toEqual([0, 1, 2])
    const jobs = (res.data as { jobs: { label: string; status: string }[] }).jobs
    expect(jobs.find((j) => j.label === 'two')?.status).toBe('rejected')
    expect(await readFile(join(workspaceDir, 'rej/one.ts'), 'utf8')).toBe('one\n')
    await expect(stat(join(workspaceDir, 'rej/two.ts'))).rejects.toThrow()
    expect(await readFile(join(workspaceDir, 'rej/three.ts'), 'utf8')).toBe('three\n')
  })

  test('a target changed between the context read and the write fails as stale, writing nothing', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const target = join(workspaceDir, 'stale/a.ts')
    await mkdir(join(workspaceDir, 'stale'), { recursive: true })
    await writeFile(target, 'const x = 1\n', 'utf8')

    const { deps } = stubDeps((_call, nonce) => editBlock(nonce, 'stale/a.ts', 'const x = 1', 'const x = 2'), {
      // Simulates a concurrent external edit landing while the human was reviewing.
      approve: async () => {
        await writeFile(target, 'someone else got here first\n', 'utf8')
        const future = new Date(Date.now() + 10_000)
        await utimes(target, future, future)
        return 'approve'
      }
    })
    const res = await parallelWriteTool({ jobs: [{ kind: 'edit', paths: ['stale/a.ts'], instructions: 'bump x' }] }, deps as never)
    const jobs = (res.data as { jobs: { status: string; error?: string }[] }).jobs
    expect(jobs[0].status).toBe('failed')
    expect(jobs[0].error).toContain('stale')
    // The concurrent writer's content must survive untouched.
    expect(await readFile(target, 'utf8')).toBe('someone else got here first\n')
  })

  test('an edit job matches LF-only worker output against a CRLF file and keeps CRLF', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const target = join(workspaceDir, 'crlf/a.ts')
    await mkdir(join(workspaceDir, 'crlf'), { recursive: true })
    await writeFile(target, 'const x = 1\r\nconst y = 2\r\n', 'utf8')

    const { deps } = stubDeps((_call, nonce) => editBlock(nonce, 'crlf/a.ts', 'const x = 1', 'const x = 99'))
    const res = await parallelWriteTool({ jobs: [{ kind: 'edit', paths: ['crlf/a.ts'], instructions: 'bump x' }] }, deps as never)
    expect(res.ok).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('const x = 99\r\nconst y = 2\r\n')
  })

  // The cache-coherence regression the plan calls out: reusing only the PLANNERS would leave
  // fileReadCache holding pre-write content, so the NEXT turn's edit would fail with a spurious
  // 'stale'. applyPlannedFile refreshes the cache, so this must succeed.
  test('a following edit_file on a just-written path does not fail as stale', async () => {
    const { parallelWriteTool, editFileTool } = await import('../src/main/agent/tools/index')
    const { deps } = stubDeps((_call, nonce) => fileBlock(nonce, 'coh/app.ts', 'export const v = 1\n'))
    const wrote = await parallelWriteTool({ jobs: [{ kind: 'write', paths: ['coh/app.ts'], instructions: 'x' }] }, deps as never)
    expect(wrote.ok).toBe(true)

    const edited = await editFileTool({ path: 'coh/app.ts', old_string: 'v = 1', new_string: 'v = 2' })
    expect(edited.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'coh/app.ts'), 'utf8')).toBe('export const v = 2\n')
  })

  test('the result payload carries bounded diffs and per-job status, never raw worker output', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const marker = 'UNIQUE_RAW_WORKER_MARKER_9f3a'
    const { deps } = stubDeps((_call, nonce) => `${marker}\n${fileBlock(nonce, 'payload/a.ts', 'x\n')}`)
    const res = await parallelWriteTool({ jobs: [{ kind: 'write', paths: ['payload/a.ts'], instructions: 'x' }] }, deps as never)
    expect(res.ok).toBe(true)
    // The worker's chatter (and any raw reply text) must not be persisted in the result.
    expect(JSON.stringify(res)).not.toContain(marker)
    expect((res.data as { paths: string[] }).paths).toEqual(['payload/a.ts'])
  })
})

describe('parallelWriteTool — cache priming hook', () => {
  test('primes once for the batch with the shared prefix, then reports worker cache reads', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const primedWith: { prompt: string; jobCount: number }[] = []
    let reported: number[] | null = null
    const { deps, calls } = stubDeps((call, nonce) =>
      fileBlock(nonce, call.userContent.includes('prime/a.ts') ? 'prime/a.ts' : 'prime/b.ts', 'x\n')
    )
    const res = await parallelWriteTool(
      {
        jobs: [
          { kind: 'write', paths: ['prime/a.ts'], instructions: 'x' },
          { kind: 'write', paths: ['prime/b.ts'], instructions: 'y' }
        ]
      },
      {
        ...deps,
        prime: async (systemPrompt: string, jobCount: number) => {
          primedWith.push({ prompt: systemPrompt, jobCount })
          return true
        },
        onPrimingUsage: (perWorker: number[]) => {
          reported = perWorker
        }
      } as never
    )
    expect(res.ok).toBe(true)
    expect(primedWith.length).toBe(1) // once per batch, not once per job
    expect(primedWith[0].jobCount).toBe(2)
    expect(primedWith[0].prompt).toBe(calls[0].systemPrompt) // exactly the prefix the workers send
    expect(reported).toEqual([0, 0])
  })

  test('a priming failure degrades to a cold fan-out instead of failing the call', async () => {
    const { parallelWriteTool } = await import('../src/main/agent/tools/index')
    const { deps } = stubDeps((_call, nonce) => fileBlock(nonce, 'primefail/a.ts', 'x\n'))
    const res = await parallelWriteTool(
      { jobs: [{ kind: 'write', paths: ['primefail/a.ts'], instructions: 'x' }] },
      {
        ...deps,
        prime: async () => {
          throw new Error('provider exploded')
        }
      } as never
    )
    expect(res.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'primefail/a.ts'), 'utf8')).toBe('x\n')
  })
})
