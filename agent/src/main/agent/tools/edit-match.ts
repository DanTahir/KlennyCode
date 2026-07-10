export function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0
  return content.split(needle).length - 1
}

function stripLineNumberPrefixes(s: string): string {
  return s.replace(/^\d+\|/gm, '')
}

export function resolveEditMatch(
  content: string,
  oldString: string,
  newString: string
): { oldString: string; newString: string } | null {
  const seen = new Set<string>()
  const variants: Array<{ oldString: string; newString: string }> = []

  const add = (old: string, next: string) => {
    if (!old || seen.has(old)) return
    seen.add(old)
    variants.push({ oldString: old, newString: next })
  }

  // `content` passed in here is always LF-normalized by the caller (see ./eol.ts), so
  // normalizing old_string/new_string to LF too is what lets matching succeed
  // regardless of whether the model produced LF or CRLF text.
  const transforms = [
    (s: string) => s,
    (s: string) => s.replace(/\r\n/g, '\n'),
    (s: string) => stripLineNumberPrefixes(s),
    (s: string) => stripLineNumberPrefixes(s.replace(/\r\n/g, '\n')),
    (s: string) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'")
  ]

  const dashPairs: Array<[string, string]> = [
    [oldString, newString],
    [oldString.replace(/-/g, '\u2014'), newString.replace(/-/g, '\u2014')],
    [oldString.replace(/\u2014/g, '-'), newString]
  ]

  for (const [old, next] of dashPairs) {
    for (const t of transforms) {
      add(t(old), t(next))
    }
  }

  for (const v of variants) {
    if (countOccurrences(content, v.oldString) > 0) return v
  }
  return null
}

export function buildEditNotFoundHelp(content: string, oldString: string): Record<string, unknown> {
  const hint =
    'old_string must match file contents exactly. Call read_file first and copy text verbatim — do not include line numbers (1|), and watch for em dashes (—) vs hyphens (-).'

  const probe = stripLineNumberPrefixes(oldString.replace(/\\n/g, '\n')).split('\n')[0]?.trim()
  if (!probe || probe.length < 6) return { hint }

  const lines = content.split(/\r?\n/)
  const frag = probe.slice(0, Math.min(probe.length, 48))
  let idx = lines.findIndex((l) => l.includes(frag))
  if (idx < 0) {
    const quoted = probe.match(/"([^"]{4,})"/)?.[1]
    if (quoted) idx = lines.findIndex((l) => l.includes(quoted))
  }
  if (idx < 0) return { hint }

  const start = Math.max(0, idx - 1)
  const nearbyContent = lines
    .slice(start, start + 5)
    .map((l, i) => `${start + i + 1}|${l}`)
    .join('\n')
  return { hint, nearbyContent }
}
