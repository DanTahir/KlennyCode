import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Inline edit logic test (mirrors edit_file uniqueness check)
function applyEdit(content: string, oldStr: string, newStr: string): string | 'not_found' | 'ambiguous' {
  const count = content.split(oldStr).length - 1
  if (count === 0) return 'not_found'
  if (count > 1) return 'ambiguous'
  return content.replace(oldStr, newStr)
}

describe('edit_file semantics', () => {
  test('replaces unique string', () => {
    expect(applyEdit('hello world', 'world', 'there')).toBe('hello there')
  })

  test('rejects ambiguous replacement', () => {
    expect(applyEdit('foo foo', 'foo', 'bar')).toBe('ambiguous')
  })

  test('rejects missing string', () => {
    expect(applyEdit('hello', 'xyz', 'bar')).toBe('not_found')
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
