import { describe, expect, test } from 'bun:test'
import './testElectronMock'

const { session: electronSession } = await import('electron')
const {
  installPawprintProtocolHandler,
  setServedContent,
  buildConnectSrc,
  PAWPRINT_SCHEME
} = await import('../src/main/agent/pawprints/protocol')

/** Regression coverage for a real bug found running an agent-generated weather Pawprint: every
 *  fetch() call failed with "Failed to fetch" even though both the webRequest domain allowlist
 *  and the HTTP-header CSP correctly approved the requested domains. Root cause was the served
 *  HTML shell's own <meta> CSP tag hardcoding `connect-src 'none'` unconditionally — per the CSP
 *  spec, a meta CSP and a header CSP on the same document are enforced as an INTERSECTION
 *  (most-restrictive-wins per directive), so the meta tag silently re-narrowed every Pawprint's
 *  effective connect-src to nothing, no matter what the header said. */
describe('installPawprintProtocolHandler — served HTML shell CSP reflects approvedDomains', () => {
  test('index.html response embeds the real connect-src for the approved domains, not a hardcoded none', async () => {
    const partition = `pawprint-protocol-test-${Math.random()}`
    const sess = electronSession.fromPartition(partition) as unknown as {
      protocol: { __getHandler: (scheme: string) => (request: Request) => Response | Promise<Response> }
    }

    installPawprintProtocolHandler(electronSession.fromPartition(partition) as unknown as Electron.Session)

    const instanceId = 'inst-1'
    const approvedDomains = ['api.zippopotam.us', 'geocoding-api.open-meteo.com', 'api.open-meteo.com']
    setServedContent(instanceId, { bundleJs: 'console.log(1)', themeJson: '{}', approvedDomains })

    const handler = sess.protocol.__getHandler(PAWPRINT_SCHEME)
    expect(handler).toBeDefined()

    const response = await handler(new Request(`pawprint://${instanceId}/index.html`))
    const html = await response.text()

    const expectedConnectSrc = buildConnectSrc(approvedDomains)
    expect(html).toContain(`connect-src ${expectedConnectSrc}`)
    expect(html).not.toContain("connect-src 'none'")
    for (const domain of approvedDomains) {
      expect(html).toContain(`https://${domain}`)
    }
  })

  test('index.html response falls back to connect-src none when no domains are approved', async () => {
    const partition = `pawprint-protocol-test-nonetwork-${Math.random()}`
    const sess = electronSession.fromPartition(partition) as unknown as {
      protocol: { __getHandler: (scheme: string) => (request: Request) => Response | Promise<Response> }
    }

    installPawprintProtocolHandler(electronSession.fromPartition(partition) as unknown as Electron.Session)

    const instanceId = 'inst-2'
    setServedContent(instanceId, { bundleJs: 'console.log(1)', themeJson: '{}', approvedDomains: [] })

    const handler = sess.protocol.__getHandler(PAWPRINT_SCHEME)
    const response = await handler(new Request(`pawprint://${instanceId}/index.html`))
    const html = await response.text()

    expect(html).toContain("connect-src 'none'")
  })
})
