/**
 * Pure menu-template builders. Only `import type` from electron, so these can be unit-tested
 * without an Electron runtime. The Electron wiring lives in menus.ts.
 */
import type { MenuItemConstructorOptions } from 'electron'

/** macOS menu bar. On macOS the standard clipboard/undo shortcuts (Cmd+C/V/X/A/Z) are dispatched
 *  through the application menu's Edit roles. With no menu (setApplicationMenu(null), which this
 *  app used on every platform) they silently do nothing in text fields. Windows/Linux Chromium
 *  handles Ctrl+C/V/X/A/Z natively, so those platforms keep no menu bar. */
export function buildMacAppMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' }, // About, Services, Hide (Cmd+H), Hide Others, Show All, Quit (Cmd+Q)
    { role: 'editMenu' }, // Undo/Redo, Cut/Copy/Paste, Paste and Match Style, Delete, Select All, Speech
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // On macOS this is Minimize, Zoom, Bring All to Front: no Cmd+W, so the renderer's own
    // Cmd+W (close chat tab) keeps working.
    { role: 'windowMenu' }
  ]
}

/** The subset of Electron's ContextMenuParams the edit menu depends on. */
export interface EditContextParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

export interface EditContextActions {
  replaceMisspelling: (word: string) => void
  copyText: (text: string) => void
}

const MAX_SPELLING_SUGGESTIONS = 5

function trimSeparators(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of items) {
    if (item.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue
    out.push(item)
  }
  while (out.length > 0 && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/** Right-click menu for text: spelling suggestions and Undo/Redo/Cut/Copy/Paste/Select All in
 *  editable fields, Copy for selected read-only text (chat messages), Copy Link on links. Returns
 *  [] when there is nothing useful to show, and the caller then shows no menu at all. */
export function buildEditContextMenuTemplate(p: EditContextParams, actions: EditContextActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const hasSelection = p.selectionText.trim().length > 0

  if (p.isEditable && p.misspelledWord) {
    const suggestions = p.dictionarySuggestions.slice(0, MAX_SPELLING_SUGGESTIONS)
    if (suggestions.length === 0) items.push({ label: 'No Guesses Found', enabled: false })
    for (const s of suggestions) items.push({ label: s, click: () => actions.replaceMisspelling(s) })
    items.push({ type: 'separator' })
  }

  if (p.linkURL) {
    items.push({ label: 'Copy Link', click: () => actions.copyText(p.linkURL) })
    items.push({ type: 'separator' })
  }

  if (p.isEditable) {
    items.push(
      { role: 'undo', enabled: p.editFlags.canUndo },
      { role: 'redo', enabled: p.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: p.editFlags.canSelectAll }
    )
  } else if (hasSelection) {
    items.push({ role: 'copy', enabled: p.editFlags.canCopy })
  }

  return trimSeparators(items)
}

export type TerminalContextAction = 'copy' | 'paste' | 'selectAll' | 'clear'

/** Right-click menu for the xterm terminal panel. xterm draws its selection itself rather than
 *  using a DOM selection, so the generic edit menu can't see it; the renderer passes the
 *  selection explicitly and handles paste/select-all/clear through xterm's own API. */
export function buildTerminalContextMenuTemplate(
  hasSelection: boolean,
  choose: (action: TerminalContextAction) => void
): MenuItemConstructorOptions[] {
  return [
    { label: 'Copy', enabled: hasSelection, click: () => choose('copy') },
    { label: 'Paste', click: () => choose('paste') },
    { type: 'separator' },
    { label: 'Select All', click: () => choose('selectAll') },
    { label: 'Clear', click: () => choose('clear') }
  ]
}
