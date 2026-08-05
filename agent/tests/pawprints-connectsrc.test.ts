import { describe, expect, test } from 'bun:test'
import './testElectronMock'

const { buildConnectSrc } = await import('../src/main/agent/pawprints/windowManager')

describe('buildConnectSrc', () => {
  test("returns 'none' when no domains are approved (default, no-network case)", () => {
    expect(buildConnectSrc([])).toBe("'none'")
  })

  test('returns a single https:// hostname for one approved domain', () => {
    expect(buildConnectSrc(['api.weather.example.com'])).toBe('https://api.weather.example.com')
  })

  test('returns a space-separated list of https:// hostnames for multiple approved domains, preserving order', () => {
    expect(buildConnectSrc(['a.example.com', 'b.example.com'])).toBe('https://a.example.com https://b.example.com')
  })

  test('mirrors exactly the approved-domain list with no wildcard/port added, matching the webRequest allowlist format', () => {
    const domains = ['one.example.com', 'two.example.com', 'three.example.com']
    const connectSrc = buildConnectSrc(domains)
    for (const d of domains) {
      expect(connectSrc).toContain(`https://${d}`)
    }
    expect(connectSrc.split(' ').length).toBe(domains.length)
  })
})
