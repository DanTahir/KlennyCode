import { protocol } from 'electron'

/** Custom scheme used to serve a Pawprint's bundled JS + HTML shell entirely from memory — no
 *  filesystem/HTTP access is ever exposed to the sandboxed renderer itself. URLs look like
 *  `pawprint://<instanceId>/index.html` and `pawprint://<instanceId>/bundle.js`. Must be
 *  registered via `protocol.registerSchemesAsPrivileged` before `app.whenReady()`. */
export const PAWPRINT_SCHEME = 'pawprint'

/** In-memory registry of what each currently-open instance should serve, keyed by instanceId.
 *  Populated by windowManager.ts right before creating/reloading a window, read by the
 *  protocol handler on every request — never touches disk. `approvedDomains` is threaded through
 *  so `htmlShell()` can bake the real per-Pawprint `connect-src` into its own `<meta>` CSP tag
 *  (see the CSP intersection note on `htmlShell` below for why this field must not be dropped). */
interface ServedContent {
  bundleJs: string
  themeJson: string
  approvedDomains: string[]
}

/** Builds the CSP connect-src value for a given approved-domain list — 'none' when empty, or
 *  the exact https:// hostnames otherwise. Mirrors the webRequest allowlist exactly; webRequest
 *  remains the primary hard gate regardless of what this string says. Lives here (not
 *  windowManager.ts) so htmlShell() below can call it directly without a circular import;
 *  re-exported from windowManager.ts for backward compatibility with existing callers/tests. */
export function buildConnectSrc(approvedDomains: string[]): string {
  if (approvedDomains.length === 0) return "'none'"
  return approvedDomains.map((d) => `https://${d}`).join(' ')
}

const servedByInstance = new Map<string, ServedContent>()

export function setServedContent(instanceId: string, content: ServedContent): void {
  servedByInstance.set(instanceId, content)
}

export function clearServedContent(instanceId: string): void {
  servedByInstance.delete(instanceId)
}

/** NOTE on CSP double-enforcement: this document has TWO Content-Security-Policy sources — this
 *  `<meta>` tag, and the HTTP response header windowManager.ts injects via `onHeadersReceived`.
 *  Per the CSP spec, when both a meta CSP and a header CSP apply to the same document, browsers
 *  enforce the INTERSECTION (most-restrictive-wins per directive), not just the header. This
 *  previously hardcoded `connect-src 'none'` here unconditionally, which silently overrode
 *  whatever domains a Pawprint had actually been approved for — every network-enabled Pawprint's
 *  `fetch()` calls failed with a generic "Failed to fetch" (found via a real weather Pawprint;
 *  the domain allowlist/CSP header were both correctly configured, this tag was the only actual
 *  blocker). Fix: build the same real connect-src here from `approvedDomains`, so the two CSP
 *  sources agree instead of the meta tag silently re-narrowing to 'none'. Do not hardcode 'none'
 *  here again — it must always reflect the actual per-Pawprint approved-domain list. */
function htmlShell(instanceId: string, approvedDomains: string[]): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${buildConnectSrc(approvedDomains)}" />
    <style>html,body,#root{margin:0;padding:0;width:100%;height:100%;overflow:auto}</style>
  </head>
  <body>
    <div id="root"></div>
    <script src="pawprint://${instanceId}/bundle.js"></script>
  </body>
</html>`
}

/** Registers the custom-scheme protocol privileges. Must run before app.whenReady() — Electron
 *  requires registerSchemesAsPrivileged to happen at module load time, prior to app ready. */
export function registerPawprintSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PAWPRINT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: false
      }
    }
  ])
}

/** Installs the request handler for the pawprint:// scheme on a given session. Called once per
 *  per-instance session (windowManager.ts creates one session per instance) so each instance's
 *  handler only ever serves that instance's own content, keyed by the instanceId in the host
 *  portion of the URL (e.g. `pawprint://abc123/bundle.js`).
 *
 *  Idempotent by design: `session.fromPartition()` returns the SAME cached Electron `Session`
 *  object for a repeated partition string (windowManager.ts's partition is `pawprint-<instanceId>`,
 *  so this recurs whenever the same instance is closed and reopened) — Electron sessions aren't
 *  necessarily torn down just because the BrowserWindow that used them was. Calling
 *  `session.protocol.handle()` a second time on a scheme that's already handled throws
 *  ("Failed to register protocol: pawprint"), which previously surfaced as an uncaught error
 *  from the `pawprint:open` IPC handler on a second open of the same instance. Guarding with
 *  `isProtocolHandled()` is safe here specifically because this handler is entirely stateless
 *  (it only reads the module-level `servedByInstance` map by instanceId at request time, never
 *  closes over anything instance-specific at install time) — skipping a redundant re-install
 *  changes no runtime behavior. */
export function installPawprintProtocolHandler(session: Electron.Session): void {
  if (session.protocol.isProtocolHandled(PAWPRINT_SCHEME)) return
  session.protocol.handle(PAWPRINT_SCHEME, (request) => {
    const url = new URL(request.url)
    const instanceId = url.hostname
    const content = servedByInstance.get(instanceId)
    if (!content) {
      return new Response('Not found', { status: 404 })
    }
    if (url.pathname === '/bundle.js' || url.pathname === '') {
      return new Response(content.bundleJs, { headers: { 'Content-Type': 'text/javascript' } })
    }
    return new Response(htmlShell(instanceId, content.approvedDomains), { headers: { 'Content-Type': 'text/html' } })
  })
}

export function pawprintEntryUrl(instanceId: string): string {
  return `${PAWPRINT_SCHEME}://${instanceId}/index.html`
}
