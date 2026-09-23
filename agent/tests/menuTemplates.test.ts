import { describe, expect, test } from 'bun:test'
import {
  buildEditContextMenuTemplate,
  buildMacAppMenuTemplate,
  buildTerminalContextMenuTemplate,
  type EditContextParams,
  type TerminalContextAction
} from '../src/main/menuTemplates'

const ALL_FLAGS = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const NO_FLAGS = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false }

function params(overrides: Partial<EditContextParams>): EditContextParams {
  return {
    isEditable: false,
    selectionText: '',
    linkURL: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: NO_FLAGS,
    ...overrides
  }
}

const noopActions = { replaceMisspelling: () => {}, copyText: () => {} }
const roles = (items: ReturnType<typeof buildEditContextMenuTemplate>) => items.map((i) => i.role ?? i.type ?? i.label)

describe('buildMacAppMenuTemplate', () => {
  test('includes the Edit menu (required for Cmd+C/V on macOS) and the app menu (Cmd+Q)', () => {
    const roleList = buildMacAppMenuTemplate().map((m) => m.role)
    expect(roleList).toContain('editMenu')
    expect(roleList).toContain('appMenu')
  })
})

describe('buildEditContextMenuTemplate', () => {
  test('editable field: undo/redo/cut/copy/paste/selectAll with enabled state from editFlags', () => {
    const items = buildEditContextMenuTemplate(params({ isEditable: true, editFlags: { ...ALL_FLAGS, canUndo: false } }), noopActions)
    expect(roles(items)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
    expect(items[0].enabled).toBe(false)
    expect(items.find((i) => i.role === 'paste')?.enabled).toBe(true)
  })

  test('read-only text with a selection: Copy only', () => {
    const items = buildEditContextMenuTemplate(params({ selectionText: 'hello', editFlags: { ...NO_FLAGS, canCopy: true } }), noopActions)
    expect(roles(items)).toEqual(['copy'])
  })

  test('nothing selected, not editable, no link: empty (no menu shown)', () => {
    expect(buildEditContextMenuTemplate(params({}), noopActions)).toEqual([])
    expect(buildEditContextMenuTemplate(params({ selectionText: '   ' }), noopActions)).toEqual([])
  })

  test('link: Copy Link copies the URL, with no dangling separator', () => {
    const copied: string[] = []
    const items = buildEditContextMenuTemplate(params({ linkURL: 'https://x.test' }), { ...noopActions, copyText: (t) => copied.push(t) })
    expect(items.map((i) => i.label)).toEqual(['Copy Link'])
    ;(items[0].click as () => void)()
    expect(copied).toEqual(['https://x.test'])
  })

  test('misspelling: suggestions first (capped at 5), each replacing the word', () => {
    const replaced: string[] = []
    const items = buildEditContextMenuTemplate(
      params({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea', 'tee', 'teh2', 'extra'], editFlags: ALL_FLAGS }),
      { ...noopActions, replaceMisspelling: (w) => replaced.push(w) }
    )
    expect(items.slice(0, 5).map((i) => i.label)).toEqual(['the', 'ten', 'tea', 'tee', 'teh2'])
    expect(items[5].type).toBe('separator')
    ;(items[0].click as () => void)()
    expect(replaced).toEqual(['the'])
  })

  test('misspelling with no suggestions shows a disabled placeholder', () => {
    const items = buildEditContextMenuTemplate(params({ isEditable: true, misspelledWord: 'zzzq', editFlags: ALL_FLAGS }), noopActions)
    expect(items[0]).toMatchObject({ label: 'No Guesses Found', enabled: false })
  })
})

describe('buildTerminalContextMenuTemplate', () => {
  test('Copy is disabled without a selection; each item reports its action', () => {
    const picked: TerminalContextAction[] = []
    const items = buildTerminalContextMenuTemplate(false, (a) => picked.push(a))
    expect(items.map((i) => i.label ?? i.type)).toEqual(['Copy', 'Paste', 'separator', 'Select All', 'Clear'])
    expect(items[0].enabled).toBe(false)
    for (const i of items) (i.click as (() => void) | undefined)?.()
    expect(picked).toEqual(['copy', 'paste', 'selectAll', 'clear'])
  })

  test('Copy is enabled with a selection', () => {
    expect(buildTerminalContextMenuTemplate(true, () => {})[0].enabled).toBe(true)
  })
})
