import { describe, expect, test } from 'bun:test'
import matter from 'gray-matter'

describe('skills frontmatter', () => {
  test('parses name and description', () => {
    const raw = `---\nname: test-skill\ndescription: Does a thing\n---\n\nBody here`
    const { data, content } = matter(raw)
    expect(data.name).toBe('test-skill')
    expect(data.description).toBe('Does a thing')
    expect(content.trim()).toBe('Body here')
  })
})

describe('subagent frontmatter', () => {
  test('parses tools list', () => {
    const raw = `---\nname: explorer\ndescription: Explore code\ntools: [read_file, grep]\n---\n\nPrompt`
    const { data } = matter(raw)
    expect(data.name).toBe('explorer')
    expect(data.tools).toEqual(['read_file', 'grep'])
  })
})
