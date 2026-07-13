import { describe, expect, test } from 'bun:test'
import { chunkFile, hashChunkText } from '../src/main/agent/codeindex/chunker'

describe('hashChunkText', () => {
  test('same input produces the same hash', () => {
    const a = hashChunkText('function foo() { return 1 }')
    const b = hashChunkText('function foo() { return 1 }')
    expect(a).toBe(b)
  })

  test('changed input produces a different hash', () => {
    const a = hashChunkText('function foo() { return 1 }')
    const b = hashChunkText('function foo() { return 2 }')
    expect(a).not.toBe(b)
  })
})

describe('chunkFile', () => {
  test('empty content produces no chunks', () => {
    expect(chunkFile('')).toEqual([])
  })

  test('small file produces a single chunk covering all lines', () => {
    const content = 'line1\nline2\nline3'
    const chunks = chunkFile(content)
    expect(chunks.length).toBe(1)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[0].endLine).toBe(3)
    expect(chunks[0].text).toBe(content)
  })

  test('chunks are contiguous and cover the whole file with 1-indexed line numbers', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`)
    const content = lines.join('\n')
    const chunks = chunkFile(content)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].startLine).toBe(1)
    expect(chunks[chunks.length - 1].endLine).toBe(lines.length)
    // every chunk's line range should be valid and non-empty
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(1)
      expect(c.endLine).toBeGreaterThanOrEqual(c.startLine)
    }
  })

  test('adjacent chunks overlap in content near the boundary (context preserved across cuts)', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`)
    const content = lines.join('\n')
    const chunks = chunkFile(content)
    if (chunks.length < 2) return // guard in case chunk sizing changes; overlap only applies across multiple chunks
    const firstChunkLastLine = chunks[0].text.split('\n').at(-1)
    const secondChunkLines = chunks[1].text.split('\n')
    expect(secondChunkLines).toContain(firstChunkLastLine)
  })

  test('each chunk has a stable hash matching hashChunkText of its own text', () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const chunks = chunkFile(content)
    for (const c of chunks) {
      expect(c.hash).toBe(hashChunkText(c.text))
    }
  })

  test('re-chunking identical content yields identical hashes in the same order (stable across re-scans)', () => {
    const content = Array.from({ length: 120 }, (_, i) => `def fn_${i}(): pass`).join('\n')
    const first = chunkFile(content).map((c) => c.hash)
    const second = chunkFile(content).map((c) => c.hash)
    expect(first).toEqual(second)
  })

  test('a single-line change only changes the hash of the chunk(s) containing that line', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `value_${i} = ${i}`)
    const before = chunkFile(lines.join('\n'))
    const mutatedLines = [...lines]
    mutatedLines[150] = 'value_150 = CHANGED'
    const after = chunkFile(mutatedLines.join('\n'))

    // Chunks far from the mutation (near the start) should be byte-identical and thus hash-identical.
    expect(before[0].hash).toBe(after[0].hash)

    // At least one chunk's hash must differ since content changed somewhere.
    const beforeHashes = before.map((c) => c.hash)
    const afterHashes = after.map((c) => c.hash)
    expect(beforeHashes).not.toEqual(afterHashes)
  })

  test('handles a single very long line without infinite-looping (fixed-size fallback)', () => {
    const longLine = 'x'.repeat(5000)
    const content = [longLine, 'short line after'].join('\n')
    const chunks = chunkFile(content)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    // Must terminate and cover the file (this test times out / hangs if there's a forward-progress bug).
    expect(chunks[chunks.length - 1].endLine).toBe(2)
  })
})
