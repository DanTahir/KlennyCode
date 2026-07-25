import type { ToolResultPayload } from '@shared/types'

/** DuckDuckGo's HTML result links are redirects (`//duckduckgo.com/l/?uddg=<encoded-target>&rut=...`),
 *  not the real target — unwrap the `uddg` param to get the actual URL the model can fetch. */
function decodeDdgRedirect(href: string): string | null {
  try {
    const normalized = href.replace(/&amp;/g, '&')
    const withProtocol = normalized.startsWith('//') ? `https:${normalized}` : normalized
    const parsed = new URL(withProtocol)
    return parsed.searchParams.get('uddg') || withProtocol
  } catch {
    return null
  }
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

export async function webSearchTool(args: { query: string }): Promise<ToolResultPayload> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'KlennyCode/0.1' } })
  const html = await res.text()
  const results: Array<{ title: string; url: string }> = []
  // Match the whole <a ... class="result__a" ...>Title</a> tag so href can be pulled out
  // regardless of attribute order (href appears before class in DuckDuckGo's markup).
  const anchorRe = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) && results.length < 8) {
    const hrefMatch = m[0].match(/href="([^"]*)"/)
    const targetUrl = hrefMatch && decodeDdgRedirect(hrefMatch[1])
    if (!targetUrl) continue
    const title = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).trim()
    results.push({ title, url: targetUrl })
  }
  return { ok: true, summary: `Search: ${args.query}`, data: { query: args.query, results } }
}

export async function fetchUrlTool(args: { url: string }): Promise<ToolResultPayload> {
  const res = await fetch(args.url, { headers: { 'User-Agent': 'KlennyCode/0.1' } })
  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok) {
    return {
      ok: false,
      summary: `Fetch failed: HTTP ${res.status}`,
      error: 'http_error',
      data: { url: args.url, status: res.status }
    }
  }
  if (!/text|html|json|xml/i.test(contentType)) {
    return {
      ok: false,
      summary: `Fetch failed: unsupported content-type "${contentType || 'unknown'}"`,
      error: 'unsupported_content_type',
      data: { url: args.url, contentType }
    }
  }
  const text = await res.text()
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return { ok: true, summary: `Fetched ${args.url}`, data: { url: args.url, content: stripped.slice(0, 12_000) } }
}
