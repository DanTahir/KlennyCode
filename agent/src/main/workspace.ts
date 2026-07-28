import { dialog } from 'electron'

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
