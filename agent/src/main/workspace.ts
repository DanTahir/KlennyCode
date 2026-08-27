import { app, dialog } from 'electron'
import { globalKlennyDir } from './dataDir'

let workspaceRoot: string | null = null

export function getWorkspace(): string | null {
  return workspaceRoot
}

export function setWorkspace(path: string | null): void {
  workspaceRoot = path
}

export async function pickWorkspace(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Open project folder'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  workspaceRoot = result.filePaths[0]
  return workspaceRoot
}

export function assertInWorkspace(absPath: string): boolean {
  if (!workspaceRoot) return false
  return isInsideDirectory(absPath, workspaceRoot)
}

/** Generic version of assertInWorkspace's containment check against an arbitrary root, rather
 *  than the open-project workspace singleton — used to sandbox Assistant-tab file mutations
 *  under AppSettings.documentsDirectory instead (see documentsDir.ts). */
export function isInsideDirectory(absPath: string, root: string): boolean {
  const normalized = absPath.replace(/\\/g, '/').toLowerCase()
  const normalizedRoot = root.replace(/\\/g, '/').toLowerCase()
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/')
}

/** Roots the agent may always mutate (write_file/edit_file/multi_edit/multi_write/delete_file/write_docx/
 *  edit_docx), regardless of the open project workspace or Assistant-tab documentsDirectory:
 *  the global `~/.klenny` config dir (SOUL.md, global skills/subagents/memory) and the Electron
 *  `userData` dir (settings.json, sessions, plans, per-project data, branding assets, etc). This
 *  lets the agent maintain its own config/state directly through the normal file tools instead
 *  of hacky terminal workarounds, without widening the sandbox for ordinary project/Assistant
 *  file mutations. Computed fresh each call since `app.getPath('userData')` can differ between
 *  test runs (see testElectronMock.ts) and there's no meaningful caching win here. */
export function alwaysAllowedMutationRoots(): string[] {
  return [globalKlennyDir(), app.getPath('userData')]
}

/** Shared sandbox check for every mutating file tool (write_file/edit_file/multi_edit/multi_write/
 *  delete_file/write_docx/edit_docx): allowed when the path is inside `root` (Assistant-tab
 *  documentsDirectory) or the open project workspace — exactly like before this existed — OR
 *  inside one of `alwaysAllowedMutationRoots()`, which is always checked regardless of `root`/
 *  workspace state so the agent can edit its own global config/data even with no workspace open. */
export function assertMutationAllowed(abs: string, root?: string): boolean {
  if (alwaysAllowedMutationRoots().some((allowed) => isInsideDirectory(abs, allowed))) return true
  return root ? isInsideDirectory(abs, root) : assertInWorkspace(abs)
}
