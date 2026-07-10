import { describe, expect, test } from 'bun:test'
import { makeDiff } from '../src/main/agent/tools/diff'

describe('makeDiff', () => {
  test('produces a minimal diff for a single inserted line (not a full-file rewrite)', () => {
    const oldText = 'a\nb\nc\nd\ne'
    const newText = 'a\nb\nNEW\nc\nd\ne'
    const diff = makeDiff(oldText, newText, 'file.txt')

    // A naive index-by-index comparison would misalign every line after the insertion
    // point, marking c/d/e as both removed and re-added. A correct LCS-based diff only
    // reports the single actually-changed line.
    const removedLines = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
    const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    expect(removedLines).toEqual([])
    expect(addedLines).toEqual(['+NEW'])
  })

  test('produces a minimal diff for a single deleted line', () => {
    const oldText = 'a\nb\nc\nd\ne'
    const newText = 'a\nb\nd\ne'
    const diff = makeDiff(oldText, newText, 'file.txt')
    const removedLines = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
    const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    expect(removedLines).toEqual(['-c'])
    expect(addedLines).toEqual([])
  })

  test('includes standard unified diff file headers', () => {
    const diff = makeDiff('a\n', 'b\n', 'src/foo.ts')
    const lines = diff.split('\n')
    expect(lines[0]).toBe('--- a/src/foo.ts')
    expect(lines[1]).toBe('+++ b/src/foo.ts')
  })

  test('includes a hunk header with line numbers', () => {
    const diff = makeDiff('a\nb\nc\n', 'a\nX\nc\n', 'file.txt')
    expect(diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m)
  })

  test('a single-line change in a large file only touches one hunk', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`)
    const oldText = lines.join('\n')
    const changed = [...lines]
    changed[50] = 'CHANGED'
    const newText = changed.join('\n')
    const diff = makeDiff(oldText, newText, 'big.txt')
    const hunkHeaders = diff.split('\n').filter((l) => l.startsWith('@@'))
    expect(hunkHeaders.length).toBe(1)
  })
})
