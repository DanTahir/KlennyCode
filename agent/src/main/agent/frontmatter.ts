/** Safe YAML frontmatter read/write for the `.md` files the agent authors itself — SKILL.md files
 *  (skills/manager.ts) and subagent type definitions (subagents/manager.ts).
 *
 *  Why this exists
 *  ---------------
 *  Both writers used to build frontmatter by raw string interpolation:
 *
 *      const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n\n`
 *
 *  `description` is a free-text string supplied by the model, so anything YAML treats as syntax
 *  silently produced an unparseable file. The trigger found in the wild was a description
 *  containing `"TRIGGER: read this..."`: a colon-space inside an unquoted plain scalar is a YAML
 *  error ("incomplete explicit mapping pair"), so gray-matter threw, and *every* read path
 *  swallowed that throw — the skill was dropped from the catalog, `read_skill` couldn't read it,
 *  and it appeared with an empty description. A skill that silently doesn't exist is far worse
 *  than a loud failure, and the same hazard applied to `#`, `[`, `*`, `&`, a leading `-`, an
 *  embedded newline, or a description that's just `yes`/`123` (which YAML would coerce to a
 *  bool/number rather than a string).
 *
 *  So: write through `stringifyFrontmatter` (gray-matter/js-yaml does the escaping and quoting),
 *  and read through `parseFrontmatterSafe`, which degrades to line-wise salvage rather than
 *  throwing — because files written by older builds are already on users' disks and must keep
 *  working after an update. */

import matter from 'gray-matter'

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  content: string
  /** True when the YAML failed to parse and `data` was salvaged line-wise rather than parsed.
   *  Callers can use this to decide whether to re-write the file in canonical form; nothing
   *  currently has to, since the salvaged fields are enough to list and read the file. */
  malformed: boolean
}

/** Splits a raw `---`-delimited frontmatter block from the body without any YAML parsing, for use
 *  when the YAML itself is invalid. Returns null when there's no complete delimited block. */
function splitRawFrontmatter(raw: string): { block: string; body: string } | null {
  if (!/^---\r?\n/.test(raw)) return null
  const lines = raw.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { block: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') }
    }
  }
  return null
}

/** Recovers a single `key: value` scalar from a malformed block. Takes the remainder of the line
 *  verbatim (minus one matching quote pair) — which is exactly what the old unescaped writer
 *  emitted, so this recovers the intended text even when it contains colons. */
function salvageScalar(block: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block)
  if (!m) return undefined
  let v = m[1].trim()
  if (!v) return undefined
  const q = v[0]
  if ((q === '"' || q === "'") && v.length > 1 && v[v.length - 1] === q) v = v.slice(1, -1)
  return v
}

/** True when gray-matter returned "successfully" but clearly didn't parse the block: the file
 *  opens with a frontmatter delimiter, yet no keys came back and the delimiters are still sitting
 *  in the body. See parseFrontmatterSafe for why that happens. */
function silentlyUnparsed(raw: string, data: Record<string, unknown>, content: string): boolean {
  return /^---\r?\n/.test(raw) && Object.keys(data).length === 0 && /^---\r?\n/.test(content)
}

export function parseFrontmatterSafe(raw: string): ParsedFrontmatter {
  try {
    // The `{}` second argument is load-bearing, not decoration. gray-matter memoizes results in a
    // module-level cache keyed by the file's content string, and that cache is only read/written
    // when called with NO options argument. A malformed file therefore throws on the first
    // `matter(raw)` call, but a second call with byte-identical content returns a *cached
    // half-built* result — `data: {}` with the frontmatter still embedded in `content` — instead
    // of throwing again. That's what made the original bug present as a skill with an EMPTY
    // description (name falling back to the directory name) rather than a skill that failed
    // loudly. Passing an options object bypasses the cache, so behavior is deterministic.
    const { data, content } = matter(raw, {})
    const obj = (data ?? {}) as Record<string, unknown>
    // Defence in depth: if some other code path (or a future gray-matter version) still hands
    // back the silently-unparsed shape, treat it as malformed and salvage rather than reporting
    // an empty-but-"valid" parse.
    if (silentlyUnparsed(raw, obj, content)) throw new Error('frontmatter present but unparsed')
    return { data: obj, content, malformed: false }
  } catch {
    const split = splitRawFrontmatter(raw)
    // No delimited block at all — treat the whole file as body, which is what a frontmatter-less
    // .md file means anyway.
    if (!split) return { data: {}, content: raw, malformed: true }

    const data: Record<string, unknown> = {}
    for (const key of ['name', 'description', 'model']) {
      const v = salvageScalar(split.block, key)
      if (v !== undefined) data[key] = v
    }
    // `tools` is the one non-scalar field either writer emits, and only ever as `all` or a flow
    // sequence on one line, so it can be recovered without a YAML parser too.
    const toolsRaw = salvageScalar(split.block, 'tools')
    if (toolsRaw !== undefined) {
      data.tools =
        toolsRaw === 'all'
          ? 'all'
          : toolsRaw
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean)
    }
    return { data, content: split.body, malformed: true }
  }
}

/** Serializes frontmatter + body with all YAML escaping handled. Keys with `undefined` values are
 *  omitted entirely rather than emitted as an empty value. */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = v
  // Leading newline keeps the blank-line-after-frontmatter shape these files have always had.
  return matter.stringify(`\n${body.trim()}\n`, clean)
}
