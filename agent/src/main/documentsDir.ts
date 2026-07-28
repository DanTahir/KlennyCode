// Resolves the sandbox root used by Assistant-tab file tools (read_file/write_file/edit_file/
// multi_edit/delete_file/grep/glob when they resolve a relative path or perform a mutation) —
// Assistant tabs have no project workspace, so this directory stands in for one. See
// AppSettings.documentsDirectory's doc comment in shared/types.ts.
import { app, dialog } from 'electron'
import { mkdir } from 'node:fs/promises'
import { loadSettings, saveSettings } from './settings'

/** The OS's default "Documents" folder for the current user (Electron's app.getPath('documents'),
 *  which resolves to e.g. `~/Documents` on macOS/Linux and `%USERPROFILE%\Documents` on Windows).
 *  Used whenever AppSettings.documentsDirectory is null (the default, unconfigured state). */
export function defaultDocumentsDirectory(): string {
  return app.getPath('documents')
}

/** The directory Assistant file tools should actually use right now: the user's configured
 *  override if set, otherwise the OS default. Ensures the directory exists (mkdir -p) before
 *  returning it, since a freshly-chosen or first-ever-used default folder may not exist yet. */
export async function resolveDocumentsDirectory(): Promise<string> {
  const settings = await loadSettings()
  const dir = settings.documentsDirectory || defaultDocumentsDirectory()
  await mkdir(dir, { recursive: true })
  return dir
}

/** Opens a native folder-picker dialog and, if the user confirms a selection, persists it as
 *  AppSettings.documentsDirectory. Returns the newly-picked path, or null if the user canceled. */
export async function pickDocumentsDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a folder for Assistant file access'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  await saveSettings({ documentsDirectory: path })
  return path
}
