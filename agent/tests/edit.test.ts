import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveEditMatch } from '../src/main/agent/tools/edit-match'
import { detectEol, fromLf, toLf } from '../src/main/agent/tools/eol'

// Inline edit logic test (mirrors edit_file uniqueness check)
function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll = false
): string | 'not_found' | 'ambiguous' {
  const count = content.split(oldStr).length - 1
  if (count === 0) return 'not_found'
  if (!replaceAll && count > 1) return 'ambiguous'
  return replaceAll ? content.replaceAll(oldStr, newStr) : content.replace(oldStr, newStr)
}

describe('edit_file semantics', () => {
  test('replaces unique string', () => {
    expect(applyEdit('hello world', 'world', 'there')).toBe('hello there')
  })

  test('rejects ambiguous replacement', () => {
    expect(applyEdit('foo foo', 'foo', 'bar')).toBe('ambiguous')
  })

  test('replace_all replaces every occurrence', () => {
    expect(applyEdit('foo foo', 'foo', 'bar', true)).toBe('bar bar')
  })

  test('rejects missing string', () => {
    expect(applyEdit('hello', 'xyz', 'bar')).toBe('not_found')
  })

  test('matches em dash when old_string uses hyphen', () => {
    const file = '"description": "Klenny — a desktop coding agent"'
    const old = '"description": "Klenny - a desktop coding agent"'
    const match = resolveEditMatch(file, old, '"description": "Klenny Code — a desktop coding agent"')
    expect(match?.oldString).toBe(file)
  })

  test('strips read_file line-number prefixes from old_string', () => {
    const file = '  "name": "klenny",'
    const old = '2|  "name": "klenny",'
    const match = resolveEditMatch(file, old, '  "name": "klennycode",')
    expect(match?.oldString).toBe(file)
  })

  test('unescapes literal \\n sequences in old_string', () => {
    const file = 'line one\nline two'
    const old = 'line one\\nline two'
    const match = resolveEditMatch(file, old, 'line one\nline three')
    expect(match?.oldString).toBe(file)
  })

  test('matches when old_string uses CRLF but content is LF-normalized', () => {
    // Simulates content already normalized to LF by the caller (see eol.ts), while the
    // model's old_string still contains CRLF sequences (e.g. copy-pasted from a CRLF file).
    const file = 'line one\nline two\nline three'
    const old = 'line one\r\nline two'
    const match = resolveEditMatch(file, old, 'line ONE\nline two')
    expect(match?.oldString).toBe('line one\nline two')
  })
})

describe('file roundtrip', () => {
  test('write and read', async () => {
    const dir = join(tmpdir(), `klenny-test-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'test.txt')
    await writeFile(path, 'content', 'utf8')
    const read = await readFile(path, 'utf8')
    expect(read).toBe('content')
    await rm(dir, { recursive: true, force: true })
  })
})

// Simulates the exact editFileTool logic (read -> detect EOL -> toLf -> match ->
// write back in original EOL) against a real CRLF file, reproducing the scenario
// where `core.autocrlf=true` checks files out as CRLF while the model's old_string
// (copied from a LF-normalized read_file view) is plain LF.
describe('editFileTool CRLF handling', () => {
  async function simulateEditFile(path: string, oldString: string, newString: string) {
    const raw = await readFile(path, 'utf8')
    const eol = detectEol(raw)
    const content = toLf(raw)
    const match = resolveEditMatch(content, oldString, newString)
    if (!match) return null
    const next = content.replace(match.oldString, match.newString)
    await writeFile(path, fromLf(next, eol), 'utf8')
    return next
  }

  test('edits a CRLF file using LF old_string without corrupting line endings', async () => {
    const dir = join(tmpdir(), `klenny-crlf-test-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'test.ts')
    const crlfContent = 'function foo() {\r\n  return 1\r\n}\r\n'
    await writeFile(path, crlfContent, 'utf8')

    const result = await simulateEditFile(path, '  return 1', '  return 2')
    expect(result).toBe('function foo() {\n  return 2\n}\n')

    const onDisk = await readFile(path, 'utf8')
    // File should remain CRLF on disk (we preserve the original EOL style).
    expect(onDisk).toBe('function foo() {\r\n  return 2\r\n}\r\n')
    expect(detectEol(onDisk)).toBe('\r\n')

    await rm(dir, { recursive: true, force: true })
  })

  test('edits an LF file using CRLF old_string (copy-pasted from a CRLF source)', async () => {
    const dir = join(tmpdir(), `klenny-lf-test-${Date.now()}`)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'test.ts')
    const lfContent = 'function foo() {\n  return 1\n}\n'
    await writeFile(path, lfContent, 'utf8')

    const result = await simulateEditFile(path, '  return 1\r\n}', '  return 2\n}')
    expect(result).toBe('function foo() {\n  return 2\n}\n')

    const onDisk = await readFile(path, 'utf8')
    expect(onDisk).toBe('function foo() {\n  return 2\n}\n')
    expect(detectEol(onDisk)).toBe('\n')

    await rm(dir, { recursive: true, force: true })
  })
})
