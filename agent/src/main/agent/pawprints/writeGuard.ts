import { relative, resolve, sep } from 'node:path'
import { pawprintsRootDir } from './paths'

/** Max size (bytes) for a direct state/*.json write via the generic file tools — the same
 *  numeric cap the setState IPC handler enforces (see manager.ts), so both write paths agree.
 *  Chosen generously for a JSON state blob; a Pawprint needing more should use a separate
 *  sidecar location rather than this cap being raised ad hoc (see plan risks). */
export const MAX_PAWPRINT_STATE_BYTES = 1 * 1024 * 1024 // 1 MB

export interface WriteGuardResult {
  allowed: boolean
  reason?: string
}

/**
 * Narrows the agent's existing blanket userData file-tool write access for the
 * `userData/pawprints/<id>/**` subtree: free writes are only permitted under `state/**`.
 * Writes targeting `source/**` or `manifest.json` must go through the approval-gated
 * create_pawprint/update_pawprint tools instead — otherwise the agent could bypass that
 * approval flow entirely via a raw write_file/edit_file/multi_edit call. Path is normalized
 * (resolve + relative) before the check, not string-prefix-matched, so a `state/../source/...`
 * traversal cannot escape the allowed subtree.
 *
 * Returns `{ allowed: true }` immediately (no-op) for any path outside the pawprints root at
 * all — this guard only ever narrows pawprints paths, never affects any other write.
 */
export function checkPawprintWriteGuard(absoluteTargetPath: string): WriteGuardResult {
  const normalizedRoot = resolve(pawprintsRootDir())
  const normalizedTarget = resolve(absoluteTargetPath)

  // Not under the pawprints root at all — not our concern, always allowed (this guard only
  // ever narrows pawprints paths, never affects any other write).
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + sep)) {
    return { allowed: true }
  }

  const rel = relative(normalizedRoot, normalizedTarget)
  const segments = rel.split(sep).filter(Boolean)
  // segments[0] is the pawprint id; segments[1] (if present) is 'state' | 'source' |
  // 'manifest.json' | 'node_modules' | ... A path traversal like `state/../source/App.tsx`
  // is resolved away by resolve()/relative() before we ever get here, so segments already
  // reflect the real, normalized destination — no string-prefix matching involved.
  if (segments.length <= 1) {
    // The pawprints root itself, or a bare `<id>` directory/file with no subpath — nothing
    // agent-writable lives at this level in practice, so treat as not-our-concern.
    return { allowed: true }
  }

  const [, second] = segments
  if (second === 'state') return { allowed: true }
  if (second === 'source') {
    return {
      allowed: false,
      reason: "Direct writes to a Pawprint's source/** are not allowed — use update_pawprint to change its code (it goes through AST validation and human approval)."
    }
  }
  if (second === 'manifest.json') {
    return {
      allowed: false,
      reason: "Direct writes to a Pawprint's manifest.json are not allowed — use update_pawprint to change packages, domains, or metadata."
    }
  }
  // node_modules/** or any other subdir: also main-process-managed, not agent-writable directly.
  return {
    allowed: false,
    reason: "Direct writes here are not allowed — only a Pawprint's state/** files can be edited directly; use update_pawprint for anything else."
  }
}

/** Oversized-state-write check, applied only once checkPawprintWriteGuard has already allowed
 *  the path (i.e. only for state/** paths). Rejects rather than truncates — see plan section 15. */
export function checkPawprintStateSize(byteLength: number): WriteGuardResult {
  if (byteLength > MAX_PAWPRINT_STATE_BYTES) {
    return {
      allowed: false,
      reason: `Pawprint state write of ${byteLength} bytes exceeds the ${MAX_PAWPRINT_STATE_BYTES} byte cap for state files.`
    }
  }
  return { allowed: true }
}
