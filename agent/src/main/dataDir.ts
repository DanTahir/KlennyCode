import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Global (cross-project) Klenny config directory — `~/.klenny`. Holds global skills, global
 * custom subagents, and global memory (`KLENNY.md` + auto-memory notes). This lives outside
 * any git repo already, so it needs no gitignore handling.
 */
export function globalKlennyDir(): string {
  return join(homedir(), '.klenny')
}

/**
 * Per-project data directory for generated/local state — plans, auto-memory notes, and the
 * codebase semantic-search index — that must NOT live inside the project tree. Keeping this
 * out of the project's `.klenny/` means users never need to .gitignore anything for it, and
 * `.klenny/` itself stays purely source-controlled (skills, custom subagents).
 *
 * Keyed by a base64url encoding of the absolute workspace path, mirroring the scheme already
 * used for shadow-git checkpoints in approval/manager.ts.
 */
export function projectDataDir(workspace: string): string {
  const id = Buffer.from(workspace).toString('base64url')
  return join(app.getPath('userData'), 'projects', id)
}
