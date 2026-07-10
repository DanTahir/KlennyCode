import { describe, expect, test } from 'bun:test'
import { detectEol, fromLf, toLf } from '../src/main/agent/tools/eol'

describe('eol utils', () => {
  test('detectEol identifies CRLF files', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('\r\n')
  })

  test('detectEol identifies LF files', () => {
    expect(detectEol('a\nb\nc\n')).toBe('\n')
  })

  test('detectEol defaults to LF for content with no newlines', () => {
    expect(detectEol('no newlines here')).toBe('\n')
  })

  test('detectEol uses majority vote for mixed content', () => {
    // mostly CRLF with one stray LF should still detect as CRLF
    expect(detectEol('a\r\nb\r\nc\r\nd\n')).toBe('\r\n')
  })

  test('toLf strips carriage returns', () => {
    expect(toLf('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  test('toLf is a no-op on already-LF content', () => {
    expect(toLf('a\nb\nc')).toBe('a\nb\nc')
  })

  test('fromLf converts to CRLF', () => {
    expect(fromLf('a\nb\nc', '\r\n')).toBe('a\r\nb\r\nc')
  })

  test('fromLf is a no-op when target is LF', () => {
    expect(fromLf('a\nb\nc', '\n')).toBe('a\nb\nc')
  })

  test('roundtrip preserves content through toLf/fromLf', () => {
    const original = 'a\r\nb\r\nc\r\n'
    const eol = detectEol(original)
    expect(fromLf(toLf(original), eol)).toBe(original)
  })
})
