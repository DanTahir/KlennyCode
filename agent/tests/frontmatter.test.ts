import { describe, expect, test } from 'bun:test'
import matter from 'gray-matter'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { parseFrontmatterSafe, stringifyFrontmatter } from '../src/main/agent/frontmatter'

/** Regression coverage for the unescaped-YAML-frontmatter bug: `write_skill`/`write_subagent`
 *  built frontmatter by string interpolation, so a model-supplied `description` containing YAML
 *  syntax produced a file that couldn't be parsed back. gray-matter then threw on every read path,
 *  and each one swallowed it — so the skill vanished from the catalog, `read_skill` couldn't read
 *  it, and it showed an empty description. Found in the wild on a description containing
 *  "TRIGGER: read this ...". */

const HOSTILE_DESCRIPTIONS: Array<[string, string]> = [
  ['colon-space (the real-world trigger)', 'Build a replica. TRIGGER: read this when the user says website_url: something'],
  ['leading hash', '#1 tool for replicas'],
  ['leading dash', '- a dash-led description'],
  ['leading bracket', '[bracketed] description'],
  ['leading asterisk', '*starred description'],
  ['leading ampersand', '&anchor-looking description'],
  ['leading exclamation', '!bang description'],
  ['leading at-sign', '@mention-looking description'],
  ['embedded newline', 'first line\nsecond line'],
  ['embedded double quote', 'a "quoted" description'],
  ['embedded single quote', "the user's own description"],
  ['bare yes (YAML bool)', 'yes'],
  ['bare number', '123'],
  ['bare null', 'null'],
  ['trailing colon', 'ends with a colon:'],
  ['tab character', 'has\ttab'],
  ['curly braces', '{flow: mapping}'],
  ['percent sign', '%directive-looking']
]

describe('stringifyFrontmatter escapes anything YAML would choke on', () => {
  for (const [label, description] of HOSTILE_DESCRIPTIONS) {
    test(`round-trips a description with ${label}`, () => {
      const raw = stringifyFrontmatter({ name: 'a-skill', description }, '## Body\n\nSome instructions.')

      // Parses with plain gray-matter (i.e. it's genuinely valid YAML, not just salvageable).
      const parsed = matter(raw)
      expect(parsed.data.name).toBe('a-skill')
      expect(parsed.data.description).toBe(description)
      expect(parsed.content.trim()).toBe('## Body\n\nSome instructions.')

      // And the safe reader agrees, without needing the salvage path.
      const safe = parseFrontmatterSafe(raw)
      expect(safe.malformed).toBe(false)
      expect(safe.data.description).toBe(description)
    })
  }

  test('description stays a string even when it looks like a bool/number to YAML', () => {
    for (const description of ['yes', 'no', 'true', 'false', '123', '1.5', 'null', '~']) {
      const parsed = matter(stringifyFrontmatter({ name: 'n', description }, 'b'))
      expect(typeof parsed.data.description).toBe('string')
      expect(parsed.data.description).toBe(description)
    }
  })

  test('omits undefined keys rather than emitting an empty value', () => {
    const raw = stringifyFrontmatter({ name: 'n', description: 'd', model: undefined }, 'body')
    expect(raw).not.toContain('model')
    expect(matter(raw).data.model).toBeUndefined()
  })

  test('preserves a tools array and the literal string "all" (subagent frontmatter)', () => {
    const arr = matter(stringifyFrontmatter({ name: 'n', description: 'd', tools: ['read_file', 'grep'] }, 'b'))
    expect(arr.data.tools).toEqual(['read_file', 'grep'])

    const all = matter(stringifyFrontmatter({ name: 'n', description: 'd', tools: 'all' }, 'b'))
    expect(all.data.tools).toBe('all')
  })
})

describe('parseFrontmatterSafe never throws on files written by the old buggy writer', () => {
  // Exactly what the old interpolating writer emitted for a description containing ": ".
  const LEGACY_BROKEN = `---\nname: website-replica\ndescription: Build a replica. TRIGGER: read this whenever the user says website_url:\n---\n\n## When this applies\n\nBody text.\n`

  test('plain gray-matter really does throw on it (guards the premise of this fix)', () => {
    expect(() => matter(LEGACY_BROKEN)).toThrow()
  })

  test('salvages name, description and body instead of throwing', () => {
    const { data, content, malformed } = parseFrontmatterSafe(LEGACY_BROKEN)
    expect(malformed).toBe(true)
    expect(data.name).toBe('website-replica')
    // The full intended text is recovered, colons and all.
    expect(data.description).toBe('Build a replica. TRIGGER: read this whenever the user says website_url:')
    expect(content.trim()).toBe('## When this applies\n\nBody text.')
  })

  test('salvages a broken subagent definition, including tools', () => {
    const broken = `---\nname: my-agent\ndescription: Does things. NOTE: carefully\ntools: ["read_file", "grep"]\nmodel: some/model\n---\n\nPrompt body.\n`
    expect(() => matter(broken)).toThrow()

    const { data, content, malformed } = parseFrontmatterSafe(broken)
    expect(malformed).toBe(true)
    expect(data.name).toBe('my-agent')
    expect(data.description).toBe('Does things. NOTE: carefully')
    expect(data.tools).toEqual(['read_file', 'grep'])
    expect(data.model).toBe('some/model')
    expect(content.trim()).toBe('Prompt body.')
  })

  test('salvages tools: all', () => {
    const broken = `---\nname: a\ndescription: bad: value\ntools: all\n---\n\nBody\n`
    const { data } = parseFrontmatterSafe(broken)
    expect(data.tools).toBe('all')
  })

  test('a file with no frontmatter at all is treated as pure body', () => {
    const { data, content } = parseFrontmatterSafe('# Just markdown\n\nNo frontmatter here.\n')
    expect(data).toEqual({})
    expect(content).toContain('Just markdown')
  })

  test('handles CRLF line endings in a broken block', () => {
    const broken = '---\r\nname: crlf-skill\r\ndescription: has: a colon\r\n---\r\n\r\nBody here.\r\n'
    const { data, content } = parseFrontmatterSafe(broken)
    expect(data.name).toBe('crlf-skill')
    expect(data.description).toBe('has: a colon')
    expect(content.trim()).toBe('Body here.')
  })

  test('an unterminated frontmatter block falls back to whole-file body', () => {
    const { data, content } = parseFrontmatterSafe('---\nname: x\ndescription: bad: y\n\nnever closed\n')
    expect(data).toEqual({})
    expect(content).toContain('never closed')
  })
})

describe('every bundled SKILL.md has valid, parseable frontmatter', () => {
  // A bundled skill with broken frontmatter is invisible to the catalog, so this guards the whole
  // shipped set rather than just the one skill that regressed.
  const bundledDir = join(import.meta.dir, '..', 'src', 'main', 'agent', 'skills', 'bundled')

  test('parses with plain gray-matter and exposes a non-empty name + description', () => {
    const files = readdirSync(bundledDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const raw = readFileSync(join(bundledDir, file), 'utf8')
      // Must not throw — this is exactly what scanSkillsDir used to choke on.
      const parsed = matter(raw)
      expect(typeof parsed.data.name).toBe('string')
      expect(String(parsed.data.name).length).toBeGreaterThan(0)
      expect(typeof parsed.data.description).toBe('string')
      expect(String(parsed.data.description).length).toBeGreaterThan(0)
      expect(parsed.content.trim().length).toBeGreaterThan(0)
    }
  })
})
