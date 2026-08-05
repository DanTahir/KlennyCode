import { describe, expect, test } from 'bun:test'
import { validateDomainFormat, validateDomainList, MAX_APPROVED_DOMAINS } from '../src/main/agent/pawprints/domains'

describe('pawprints domains — validateDomainFormat', () => {
  test('accepts a plain hostname', () => {
    const res = validateDomainFormat('api.weather.example.com')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.hostname).toBe('api.weather.example.com')
  })

  test('lowercases the hostname', () => {
    const res = validateDomainFormat('API.Example.COM')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.hostname).toBe('api.example.com')
  })

  test('rejects a scheme', () => {
    const res = validateDomainFormat('https://example.com')
    expect(res.ok).toBe(false)
  })

  test('rejects a port', () => {
    const res = validateDomainFormat('example.com:8080')
    expect(res.ok).toBe(false)
  })

  test('rejects a path', () => {
    const res = validateDomainFormat('example.com/api')
    expect(res.ok).toBe(false)
  })

  test('rejects a wildcard', () => {
    const res = validateDomainFormat('*.example.com')
    expect(res.ok).toBe(false)
  })

  test('rejects an IPv4 literal', () => {
    const res = validateDomainFormat('192.168.1.1')
    expect(res.ok).toBe(false)
  })

  test('rejects a bracketed IPv6 literal', () => {
    const res = validateDomainFormat('[::1]')
    expect(res.ok).toBe(false)
  })

  test('rejects an empty string', () => {
    const res = validateDomainFormat('   ')
    expect(res.ok).toBe(false)
  })

  test('rejects a malformed hostname', () => {
    const res = validateDomainFormat('not_a_valid_host!!')
    expect(res.ok).toBe(false)
  })
})

describe('pawprints domains — validateDomainList', () => {
  test('accepts a list under the cap and de-duplicates', () => {
    const res = validateDomainList(['a.example.com', 'A.EXAMPLE.COM', 'b.example.com'])
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.hostnames.length).toBe(2)
      expect(res.hostnames).toContain('a.example.com')
      expect(res.hostnames).toContain('b.example.com')
    }
  })

  test('rejects the 11th distinct domain (cap is 10)', () => {
    const domains = Array.from({ length: MAX_APPROVED_DOMAINS + 1 }, (_, i) => `host${i}.example.com`)
    const res = validateDomainList(domains)
    expect(res.ok).toBe(false)
  })

  test('accepts exactly the cap', () => {
    const domains = Array.from({ length: MAX_APPROVED_DOMAINS }, (_, i) => `host${i}.example.com`)
    const res = validateDomainList(domains)
    expect(res.ok).toBe(true)
  })

  test('propagates a format error from any single bad entry', () => {
    const res = validateDomainList(['good.example.com', '10.0.0.1'])
    expect(res.ok).toBe(false)
  })
})
