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
  const normalized = absPath.replace(/\\/g, '/').toLowerCase()
  const root = workspaceRoot.replace(/\\/g, '/').toLowerCase()
  return normalized === root || normalized.startsWith(root + '/')
}
