import { describe, expect, test } from 'bun:test'
import {
  makeDiff,
  joinDiffs,
  looksBinary,
  MAX_DIFF_OUTPUT_CHARS,
  MAX_DIFF_OUTPUT_LINES,
  MAX_COMBINED_DIFF_CHARS
} from '../src/main/agent/tools/diff'

// Regression tests for the "61 MB session log" incident. delete_file was called on a ~20 MB
// binary `.mov`; readFile(path, 'utf8') decoded it to mojibake, makeDiff turned that into a
// 20 MB unified diff, and the diff was stored in the tool result -> persisted into
// sessions/<workspace>.json. The app then froze on its loading screen, external editors froze
// opening the log, and a sibling delete_file died with "Maximum call stack size exceeded".
//
// makeDiff is therefore required to be TOTAL (never throws) and BOUNDED (never returns an
// unbounded string), because everything it returns gets persisted and shipped over IPC.

/** What readFile(binaryPath, 'utf8') actually yields: NULs, control bytes and U+FFFD. */
function fakeDecodedBinary(chars: number): string {
  const unit = '\u0000\u0000\u0000\u0014ftypqt\u0001\uFFFD\u0007\u001d\uFFFD'
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

const REAL_SOURCE = `import { join } from 'node:path'\n\nexport function f(a: number) {\n\treturn a + 1\n}\r\n`

describe('looksBinary', () => {
  test('detects decoded binary content', () => {
    expect(looksBinary(fakeDecodedBinary(4096))).toBe(true)
  })

  test('does not flag ordinary source text (tabs and CRLF are normal)', () => {
    expect(looksBinary(REAL_SOURCE)).toBe(false)
  })

  test('does not flag prose with accents/emoji, or empty content', () => {
    expect(looksBinary('héllo wörld — ok 🐕\n')).toBe(false)
    expect(looksBinary('')).toBe(false)
  })
})

describe('makeDiff safety limits', () => {
  test('omits the diff for binary content instead of emitting megabytes of mojibake', () => {
    const diff = makeDiff(fakeDecodedBinary(2_000_000), '', 'public/assets/video/clip.mov')
    expect(diff).toContain('diff omitted')
    expect(diff).toContain('binary file')
    expect(diff.length).toBeLessThan(500)
  })

  test('the exact incident shape (delete of a huge binary) yields a tiny diff', () => {
    // 20 MB of decoded binary, deleted -> the old code produced a ~20 MB diff.
    const diff = makeDiff(fakeDecodedBinary(20_000_000), '', 'clip.mov')
    expect(diff.length).toBeLessThan(500)
  })

  test('omits the diff for oversized text input', () => {
    const huge = 'a line of perfectly normal text\n'.repeat(60_000) // ~1.9M chars
    const diff = makeDiff(huge, '', 'big.txt')
    expect(diff).toContain('too large to diff')
    expect(diff.length).toBeLessThan(500)
  })

  test('clamps a diff with a huge line count, reporting the shortfall in band', () => {
    const old = Array.from({ length: 80_000 }, (_, i) => `line ${i}`).join('\n')
    const diff = makeDiff(old, '', 'many-lines.txt')
    const lines = diff.split('\n')
    expect(lines.length).toBeLessThanOrEqual(MAX_DIFF_OUTPUT_LINES + 2)
    expect(diff.length).toBeLessThanOrEqual(MAX_DIFF_OUTPUT_CHARS + 500)
    expect(diff).toContain('more diff lines omitted')
  })

  test('clamps a pathologically long single line (minified bundle)', () => {
    const diff = makeDiff(`${'x'.repeat(500_000)}\n`, 'y\n', 'bundle.min.js')
    expect(diff.length).toBeLessThanOrEqual(MAX_DIFF_OUTPUT_CHARS + 500)
    expect(diff).toContain('line truncated')
  })

  test('never throws on malformed (non-string) input', () => {
    expect(typeof makeDiff(undefined as unknown as string, null as unknown as string, 'f.txt')).toBe('string')
    expect(typeof makeDiff(42 as unknown as string, 'x', 'f.txt')).toBe('string')
  })

  test('ordinary diffs are untouched (no omission/truncation markers)', () => {
    const diff = makeDiff('a\nb\nc\n', 'a\nB\nc\n', 'file.txt')
    expect(diff).toContain('-b')
    expect(diff).toContain('+B')
    expect(diff).not.toContain('omitted')
    expect(diff).not.toContain('truncated')
  })
})

describe('joinDiffs (batch tools)', () => {
  test('caps a combined multi-file diff and says how many files were dropped', () => {
    const one = makeDiff(Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join('\n'), '', 'f.txt')
    const combined = joinDiffs(Array.from({ length: 200 }, () => one))
    expect(combined.length).toBeLessThanOrEqual(MAX_COMBINED_DIFF_CHARS + 500)
    expect(combined).toContain('more file diffs omitted')
  })

  test('passes a small batch through unchanged and skips empty entries', () => {
    const a = makeDiff('a\n', 'b\n', 'a.txt')
    const b = makeDiff('c\n', 'd\n', 'b.txt')
    expect(joinDiffs([a, '', b])).toBe(`${a}\n${b}`)
  })
})
