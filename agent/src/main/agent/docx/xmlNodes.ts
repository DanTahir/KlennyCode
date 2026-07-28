// Low-level helpers for walking/mutating fast-xml-parser's `preserveOrder: true` node shape,
// used throughout the docx module so read_docx/edit_docx operate on the *real* OOXML tree
// instead of a lossy intermediate model. In this shape, parsed XML is an array of nodes; each
// non-text node is an object with exactly one "tag" key holding an array of child nodes, plus an
// optional `:@` key holding that element's attributes (each attribute key prefixed `@_`). Text
// nodes are `{ '#text': string }`. See fast-xml-parser docs / the confirmed shape in this
// module's accompanying investigation — preserveOrder round-trips byte-identical for untouched
// nodes, which is the whole point: edit_docx only ever touches the specific nodes it targets.
import { XMLParser, XMLBuilder } from 'fast-xml-parser'

export type XmlNode = Record<string, unknown>

const ATTR_KEY = ':@'
const TEXT_KEY = '#text'

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false
})

const builder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  suppressEmptyNode: true,
  suppressBooleanAttributes: false
})

/** Parses one XML part's raw text into the preserveOrder node array (always an array at the
 *  top level — typically one root element plus, for parts with an XML declaration, a
 *  `?xml` processing-instruction node before it). */
export function parseXml(xml: string): XmlNode[] {
  return parser.parse(xml) as XmlNode[]
}

/** Serializes a preserveOrder node array back to an XML string, byte-faithful for any subtree
 *  that wasn't mutated. Always prepends the standard OOXML XML declaration since Word requires
 *  it and fast-xml-parser's builder doesn't add one automatically for a hand-built declaration
 *  node unless it was present in the parsed input (Word's own parts always have it, but we
 *  re-assert it defensively for any part we might construct from scratch, e.g. a brand-new
 *  comments.xml). */
export function buildXml(nodes: XmlNode[]): string {
  const hasDecl = nodes.some((n) => '?xml' in n)
  const body = builder.build(nodes) as string
  return hasDecl ? body : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n${body}`
}

/** Returns the element tag name of a node (e.g. "w:p"), or undefined for a text node or the
 *  `?xml` declaration pseudo-node. */
export function tagOf(node: XmlNode): string | undefined {
  const key = Object.keys(node).find((k) => k !== ATTR_KEY)
  return key
}

export function isTextNode(node: XmlNode): boolean {
  return TEXT_KEY in node
}

export function textOf(node: XmlNode): string {
  return typeof node[TEXT_KEY] === 'string' ? (node[TEXT_KEY] as string) : ''
}

export function childrenOf(node: XmlNode): XmlNode[] {
  const tag = tagOf(node)
  if (!tag) return []
  const kids = node[tag]
  return Array.isArray(kids) ? (kids as XmlNode[]) : []
}

export function attrsOf(node: XmlNode): Record<string, string> {
  const a = node[ATTR_KEY]
  return (a as Record<string, string>) ?? {}
}

export function getAttr(node: XmlNode, name: string): string | undefined {
  return attrsOf(node)[`@_${name}`]
}

export function setAttr(node: XmlNode, name: string, value: string): void {
  const a = (node[ATTR_KEY] as Record<string, string>) ?? {}
  a[`@_${name}`] = value
  node[ATTR_KEY] = a
}

/** All direct children whose tag matches (namespace-prefixed, e.g. "w:r"). */
export function findAll(node: XmlNode, tag: string): XmlNode[] {
  return childrenOf(node).filter((c) => tagOf(c) === tag)
}

export function findFirst(node: XmlNode, tag: string): XmlNode | undefined {
  return childrenOf(node).find((c) => tagOf(c) === tag)
}

/** Recursively collects every descendant with the given tag (depth-first), useful for things
 *  like finding all `w:t` under a run regardless of nesting, or all `a:blip` under a drawing. */
export function findAllDeep(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = []
  const walk = (n: XmlNode) => {
    for (const c of childrenOf(n)) {
      if (tagOf(c) === tag) out.push(c)
      walk(c)
    }
  }
  walk(node)
  return out
}

/** Concatenates all `w:t`/`w:delText`/`#text` content under a node, depth-first — used to get a
 *  run or paragraph's plain-text content regardless of how deeply nested (hyperlinks, smart
 *  tags, etc. can wrap runs without changing their visible text). */
export function plainTextOf(node: XmlNode): string {
  let out = ''
  const walk = (n: XmlNode) => {
    if (isTextNode(n)) {
      out += textOf(n)
      return
    }
    const tag = tagOf(n)
    if (tag === 'w:tab') out += '\t'
    if (tag === 'w:br' || tag === 'w:cr') out += '\n'
    for (const c of childrenOf(n)) walk(c)
  }
  walk(node)
  return out
}

/** Builds a `w:t` node with the given text, adding `xml:space="preserve"` whenever the text has
 *  leading/trailing whitespace (Word/OOXML drops it on load otherwise). */
export function makeTextNode(text: string): XmlNode {
  const node: XmlNode = { 'w:t': [{ '#text': text }] }
  if (/^\s|\s$/.test(text) || text === '') {
    node[ATTR_KEY] = { '@_xml:space': 'preserve' }
  }
  return node
}

/** Creates a minimal `w:r` (run) node, optionally cloning an existing run's `w:rPr` so the new
 *  run inherits the same formatting (used by edit ops that split/insert text next to a run). */
export function makeRun(text: string, rPr?: XmlNode): XmlNode {
  const children: XmlNode[] = []
  if (rPr) children.push(cloneNode(rPr))
  children.push(makeTextNode(text))
  return { 'w:r': children }
}

export function cloneNode<T>(node: T): T {
  return JSON.parse(JSON.stringify(node))
}
