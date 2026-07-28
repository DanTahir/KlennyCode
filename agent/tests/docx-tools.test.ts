// Smoke coverage for the docx module (write_docx/read_docx/edit_docx) — verifies the
// write -> read -> edit -> read roundtrip produces a valid, re-openable .docx with the expected
// structure and formatting, and that edit_docx's stale-read guard actually fires.
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-docx-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-docx-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('docx tools', () => {
  test('write_docx creates a document with paragraphs, formatted runs, and a table', async () => {
    const { writeDocxTool } = await import('../src/main/agent/docx/index')
    const result = await writeDocxTool({
      path: 'report.docx',
      children: [
        { type: 'paragraph', text: 'Quarterly Report', heading: 1 },
        { type: 'paragraph', runs: [{ text: 'Revenue is ' }, { text: 'up', bold: true }, { text: ' this quarter.' }] },
        {
          type: 'table',
          headerRow: true,
          rows: [
            [{ text: 'Metric' }, { text: 'Value' }],
            [{ text: 'Revenue' }, { text: '$1M' }]
          ]
        }
      ]
    })
    expect(result.ok).toBe(true)
  })

  test('read_docx projects the written document back into structured JSON', async () => {
    const { readDocxTool } = await import('../src/main/agent/docx/index')
    const result = await readDocxTool({ path: 'report.docx' })
    expect(result.ok).toBe(true)
    const model = result.data as any
    expect(model.paragraphs.length).toBeGreaterThanOrEqual(2)
    expect(model.paragraphs[0].text).toBe('Quarterly Report')
    const secondParaRuns = model.paragraphs[1].runs
    const boldRun = secondParaRuns.find((r: any) => r.text === 'up')
    expect(boldRun?.format?.bold).toBe(true)
    expect(model.tables.length).toBe(1)
    expect(model.tables[0].rows[1].cells[1].text).toBe('$1M')
  })

  test('edit_docx patches run text and formatting while preserving everything else', async () => {
    const { editDocxTool, readDocxTool } = await import('../src/main/agent/docx/index')
    const editResult = await editDocxTool({
      path: 'report.docx',
      ops: [
        { op: 'setRunText', paraIndex: 0, runIndex: 0, text: 'Annual Report' },
        { op: 'setRunFormat', paraIndex: 1, runIndex: 1, format: { italic: true, color: 'FF0000' } }
      ]
    })
    expect(editResult.ok).toBe(true)

    const reread = await readDocxTool({ path: 'report.docx' })
    expect(reread.ok).toBe(true)
    const model = reread.data as any
    expect(model.paragraphs[0].text).toBe('Annual Report')
    const editedRun = model.paragraphs[1].runs.find((r: any) => r.text === 'up')
    expect(editedRun?.format?.italic).toBe(true)
    expect(editedRun?.format?.color).toBe('FF0000')
    // The table from the original write survives untouched by an edit that never targeted it.
    expect(model.tables.length).toBe(1)
    expect(model.tables[0].rows[1].cells[1].text).toBe('$1M')
  })

  test('edit_docx inserts a new paragraph and can delete one', async () => {
    const { editDocxTool, readDocxTool } = await import('../src/main/agent/docx/index')
    const before = await readDocxTool({ path: 'report.docx' })
    const beforeCount = (before.data as any).paragraphs.length

    const result = await editDocxTool({
      path: 'report.docx',
      ops: [{ op: 'insertParagraph', afterParaIndex: 0, text: 'Inserted line', alignment: 'center' }]
    })
    expect(result.ok).toBe(true)

    const after = await readDocxTool({ path: 'report.docx' })
    const afterModel = after.data as any
    expect(afterModel.paragraphs.length).toBe(beforeCount + 1)
    expect(afterModel.paragraphs[1].text).toBe('Inserted line')
    expect(afterModel.paragraphs[1].alignment).toBe('center')
  })

  test('edit_docx rejects a nonexistent op target cleanly instead of corrupting the file', async () => {
    const { editDocxTool, readDocxTool } = await import('../src/main/agent/docx/index')
    const before = await readDocxTool({ path: 'report.docx' })

    const result = await editDocxTool({
      path: 'report.docx',
      ops: [{ op: 'setRunText', paraIndex: 999, runIndex: 0, text: 'nope' }]
    })
    expect(result.ok).toBe(false)

    // File on disk must be untouched by the failed op.
    const after = await readDocxTool({ path: 'report.docx' })
    expect(after.data).toEqual(before.data)
  })

  test('edit_docx fails with a stale error if the file changed on disk since the last read_docx', async () => {
    const { writeDocxTool, readDocxTool, editDocxTool } = await import('../src/main/agent/docx/index')
    await writeDocxTool({ path: 'stale.docx', children: [{ type: 'paragraph', text: 'v1' }] })
    await readDocxTool({ path: 'stale.docx' })

    // Simulate a concurrent external change by rewriting the file without going through
    // read_docx's mtime bookkeeping again.
    await new Promise((r) => setTimeout(r, 20))
    await writeDocxTool({ path: 'stale.docx', children: [{ type: 'paragraph', text: 'v2 (external change)' }] })

    const result = await editDocxTool({
      path: 'stale.docx',
      ops: [{ op: 'setRunText', paraIndex: 0, runIndex: 0, text: 'v3' }]
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('stale')
  })

  test('write_docx rejects a path outside the workspace', async () => {
    const { writeDocxTool } = await import('../src/main/agent/docx/index')
    const result = await writeDocxTool({ path: '../outside.docx', children: [{ type: 'paragraph', text: 'x' }] })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('sandbox')
  })

  test('read_docx reports a clean not_found error for a missing file', async () => {
    const { readDocxTool } = await import('../src/main/agent/docx/index')
    const result = await readDocxTool({ path: 'does-not-exist.docx' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_found')
  })
})
