export const MAX_APPROVED_DOMAINS = 10

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

/**
 * Validates one requested domain string for the Pawprint network allowlist. Format rules
 * (v3/plan section 4): hostname only — no scheme, no port, no path, no wildcard, no IP literal
 * in any form (IPv4, bracketed/unbracketed IPv6). Matching semantics elsewhere are exact-hostname
 * only; this function only validates *format*, not membership in any existing list.
 */
export function validateDomainFormat(input: string): { ok: true; hostname: string } | { ok: false; error: string } {
  const raw = input.trim()
  if (raw.length === 0) return { ok: false, error: 'Domain cannot be empty.' }
  if (/[:/]/.test(raw)) {
    return { ok: false, error: `Domain "${raw}" must be a bare hostname — no scheme, port, or path.` }
  }
  if (raw.includes('*')) return { ok: false, error: `Domain "${raw}" cannot contain a wildcard.` }
  if (IPV4_RE.test(raw)) return { ok: false, error: `Domain "${raw}" is an IP literal; only hostnames are allowed.` }
  // Any remaining colon (already rejected above) would catch IPv6; bracketed IPv6 `[::1]`
  // contains both `[` and `:` and is also rejected by the scheme/port/path check above.
  const lower = raw.toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(lower)) {
    return { ok: false, error: `Domain "${raw}" is not a valid hostname.` }
  }
  return { ok: true, hostname: lower }
}

/** Validates a full requested-domain list: per-item format, count cap, de-duplication. */
export function validateDomainList(domains: string[]): { ok: true; hostnames: string[] } | { ok: false; error: string } {
  const unique = new Set<string>()
  for (const d of domains) {
    const res = validateDomainFormat(d)
    if (!res.ok) return res
    unique.add(res.hostname)
  }
  if (unique.size > MAX_APPROVED_DOMAINS) {
    return { ok: false, error: `Too many domains requested (${unique.size}); the cap is ${MAX_APPROVED_DOMAINS} per Pawprint.` }
  }
  return { ok: true, hostnames: [...unique] }
}
