/**
 * Application menu + right-click context menus (Electron wiring; templates in menuTemplates.ts).
 */
import { BrowserWindow, clipboard, Menu, type WebContents } from 'electron'
import { buildEditContextMenuTemplate, buildMacAppMenuTemplate, buildTerminalContextMenuTemplate } from './menuTemplates'

/** Channel the main process uses to tell the renderer which terminal context-menu item was
 *  picked (paste/selectAll/clear need xterm's own API, so they run in the renderer). */
export const TERMINAL_CONTEXT_ACTION_CHANNEL = 'terminal:context-action'

/** macOS gets a real menu bar (needed for Cmd+C/V/X/A/Z, and it provides Cmd+Q/Cmd+H).
 *  Windows/Linux keep no menu bar, as before. */
export function installApplicationMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacAppMenuTemplate()))
  } else {
    Menu.setApplicationMenu(null)
  }
}

/** Adds a native Cut/Copy/Paste right-click menu to a window's web contents. The DOM decides
 *  first: a renderer contextmenu handler that calls preventDefault() (e.g. the terminal panel's
 *  own menu) suppresses this event entirely, so the two never both appear. */
export function attachEditContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_e, params) => {
    const template = buildEditContextMenuTemplate(
      {
        isEditable: params.isEditable,
        selectionText: params.selectionText ?? '',
        linkURL: params.linkURL ?? '',
        misspelledWord: params.misspelledWord ?? '',
        dictionarySuggestions: params.dictionarySuggestions ?? [],
        editFlags: params.editFlags
      },
      {
        replaceMisspelling: (word) => wc.replaceMisspelling(word),
        copyText: (text) => clipboard.writeText(text)
      }
    )
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(wc) ?? undefined })
  })
}

/** Pops the terminal panel's context menu. Copy is done here (the renderer passes xterm's
 *  selection); the other actions go back to the renderer as a TERMINAL_CONTEXT_ACTION_CHANNEL
 *  event. Paste carries the clipboard text so the renderer can use xterm's paste(), which honours
 *  bracketed-paste mode. Writing it straight into the PTY would not, and multi-line pastes
 *  would then run line by line. */
export function showTerminalContextMenu(wc: WebContents, selection: string): void {
  const template = buildTerminalContextMenuTemplate(selection.length > 0, (action) => {
    if (wc.isDestroyed()) return
    if (action === 'copy') {
      clipboard.writeText(selection)
      return
    }
    wc.send(TERMINAL_CONTEXT_ACTION_CHANNEL, action === 'paste' ? { action, text: clipboard.readText() } : { action })
  })
  Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(wc) ?? undefined })
}
