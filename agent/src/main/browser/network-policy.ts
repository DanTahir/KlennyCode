/**
 * SSRF / private-network policy for browser-automation sessions (see the Browser Automation
 * plan's "Network/SSRF Policy" section). Enforced via Playwright request-interception
 * (`page.route()`), applied once per page right after creation, before any navigation happens.
 *
 * Interactive (chat-tab-owned) sessions default to allowing localhost/private-range navigation
 * (`allowPrivateNetwork`) since local dev-server access is a core coding use case. Subagent- and
 * scheduler-owned ("unattended") sessions use the separate, stricter `allowPrivateNetworkUnattended`
 * default instead — the highest-risk surface for SSRF/LAN-scanning via a compromised or
 * prompt-injected page. The cloud metadata endpoint is blocked unconditionally in every context,
 * regardless of settings, since there is never a legitimate reason for the agent to reach it.
 */
import { isIP } from 'node:net'

/** Cloud metadata endpoints — always blocked, no setting can re-enable these. */
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.google.internal.'])

/** RFC 1918 / loopback / link-local ranges treated as "private network" for policy purposes. */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true

  const ipVersion = isIP(h)
  if (ipVersion === 4) {
    const parts = h.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false
    const [a, b] = parts
    if (a === 127) return true // loopback
    if (a === 10) return true // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // link-local (includes cloud metadata range)
    if (a === 0) return true // 0.0.0.0/8
    return false
  }
  if (ipVersion === 6) {
    if (h === '::1') return true // loopback
    if (h.startsWith('fc') || h.startsWith('fd')) return true // unique local fc00::/7
    if (h.startsWith('fe80')) return true // link-local
    return false
  }
  return false
}

export interface NetworkPolicyOptions {
  /** true for subagent/scheduled-task-owned sessions; picks the stricter unattended default. */
  unattended: boolean
  allowPrivateNetwork: boolean
  allowPrivateNetworkUnattended: boolean
}

export interface NetworkDecision {
  allowed: boolean
  reason?: string
}

/** Pure decision function (kept separate from Playwright wiring below so it's directly
 *  unit-testable without spinning up a browser). */
export function evaluateNavigation(rawUrl: string, opts: NetworkPolicyOptions): NetworkDecision {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: `Invalid URL: ${rawUrl}` }
  }

  // Only http/https/about(blank)/data navigations are meaningful for this tool; file:// and
  // other schemes could read local disk or trigger OS handlers — block by default.
  if (!['http:', 'https:', 'about:', 'data:'].includes(url.protocol)) {
    return { allowed: false, reason: `Blocked scheme: ${url.protocol}` }
  }
  if (url.protocol === 'about:' || url.protocol === 'data:') return { allowed: true }

  const hostname = url.hostname
  if (METADATA_HOSTS.has(hostname.toLowerCase())) {
    return { allowed: false, reason: 'Blocked: cloud metadata endpoint is never reachable, regardless of settings.' }
  }

  if (isPrivateHostname(hostname)) {
    const allowed = opts.unattended ? opts.allowPrivateNetworkUnattended : opts.allowPrivateNetwork
    if (!allowed) {
      return {
        allowed: false,
        reason: opts.unattended
          ? `Blocked: "${hostname}" is a private/local address, and private-network access is disabled for unattended (subagent/scheduled) browser sessions. Enable "Allow private network (unattended)" in Settings → Automation if this is expected.`
          : `Blocked: "${hostname}" is a private/local address, and private-network access is disabled in Settings → Automation → Browser automation.`
      }
    }
  }

  return { allowed: true }
}
