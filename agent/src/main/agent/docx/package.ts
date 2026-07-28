// Thin OPC (Office Open XML package = zip) layer shared by read_docx and edit_docx. Loads a
// .docx into memory as a map of part path -> content, exposes the small set of "sidecar" parts
// every part-mutating operation needs (content types + per-part relationships), and re-zips on
// save. write_docx (brand-new files) doesn't use this — it hands off entirely to the `docx`
// package, which manages its own OPC internals.
import JSZip from 'jszip'
import { parseXml, buildXml, findAll, getAttr, setAttr, type XmlNode } from './xmlNodes'

export interface DocxPackage {
  zip: JSZip
  /** Cache of parsed XML parts, keyed by in-zip path (e.g. "word/document.xml"). Populated
   *  lazily by getXmlPart/setXmlPart so untouched parts are never even parsed. */
  xmlCache: Map<string, XmlNode[]>
}

export async function loadDocxPackage(buffer: Buffer): Promise<DocxPackage> {
  const zip = await JSZip.loadAsync(buffer)
  return { zip, xmlCache: new Map() }
}

export async function getXmlPart(pkg: DocxPackage, path: string): Promise<XmlNode[] | undefined> {
  if (pkg.xmlCache.has(path)) return pkg.xmlCache.get(path)
  const file = pkg.zip.file(path)
  if (!file) return undefined
  const xml = await file.async('string')
  const nodes = parseXml(xml)
  pkg.xmlCache.set(path, nodes)
  return nodes
}

export function setXmlPart(pkg: DocxPackage, path: string, nodes: XmlNode[]): void {
  pkg.xmlCache.set(path, nodes)
}

/** Flushes every cached (parsed) XML part back into the zip as text, then returns the final
 *  .docx bytes. Parts never touched via getXmlPart/setXmlPart are re-emitted byte-for-byte from
 *  the original zip entry — only parts we actually parsed get re-serialized. */
export async function saveDocxPackage(pkg: DocxPackage): Promise<Buffer> {
  for (const [path, nodes] of pkg.xmlCache) {
    pkg.zip.file(path, buildXml(nodes))
  }
  const buf = await pkg.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return buf
}

const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml'

/** Path of the .rels part that describes `partPath`'s own outgoing relationships, per OPC's
 *  "_rels/<filename>.rels" convention (sibling of a `_rels` folder next to the part). */
export function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf('/')
  const dir = slash >= 0 ? partPath.slice(0, slash + 1) : ''
  const file = slash >= 0 ? partPath.slice(slash + 1) : partPath
  return `${dir}_rels/${file}.rels`
}

export interface Relationship {
  id: string
  type: string
  target: string
}

/** Reads and parses `partPath`'s relationships part, if any (a fresh document part may have no
 *  .rels file at all if it has zero outgoing relationships). */
export async function getRelationships(pkg: DocxPackage, partPath: string): Promise<Relationship[]> {
  const nodes = await getXmlPart(pkg, relsPathFor(partPath))
  if (!nodes) return []
  const root = nodes.find((n) => 'Relationships' in n)
  if (!root) return []
  return findAll(root, 'Relationship').map((r) => ({
    id: getAttr(r, 'Id') ?? '',
    type: getAttr(r, 'Type') ?? '',
    target: getAttr(r, 'Target') ?? ''
  }))
}

/** Adds a new relationship to `partPath`'s .rels file (creating it if absent) and returns the
 *  new relationship's Id. Used by edit_docx when inserting a new image. */
export async function addRelationship(pkg: DocxPackage, partPath: string, type: string, target: string): Promise<string> {
  const relsPath = relsPathFor(partPath)
  let nodes = await getXmlPart(pkg, relsPath)
  let root: XmlNode
  if (!nodes) {
    root = { Relationships: [], ':@': { '@_xmlns': 'http://schemas.openxmlformats.org/package/2006/relationships' } }
    nodes = [{ '?xml': [], ':@': { '@_version': '1.0', '@_encoding': 'UTF-8', '@_standalone': 'yes' } }, root]
  } else {
    root = nodes.find((n) => 'Relationships' in n) as XmlNode
  }
  const existingIds = findAll(root, 'Relationship').map((r) => getAttr(r, 'Id') ?? '')
  let n = existingIds.length + 1
  let id = `rId${n}`
  while (existingIds.includes(id)) {
    n++
    id = `rId${n}`
  }
  const rel: XmlNode = { Relationship: [] }
  setAttr(rel, 'Id', id)
  setAttr(rel, 'Type', type)
  setAttr(rel, 'Target', target)
  ;(root.Relationships as XmlNode[]).push(rel)
  setXmlPart(pkg, relsPath, nodes)
  return id
}

/** Registers a part's content type (via an Override, since the specific part path is what
 *  matters) in `[Content_Types].xml` if not already present — needed when adding a brand-new
 *  part type to the package (e.g. the first comment ever added to a document with none). */
export async function ensureContentTypeOverride(pkg: DocxPackage, partPath: string, contentType: string): Promise<void> {
  const path = '[Content_Types].xml'
  const nodes = await getXmlPart(pkg, path)
  if (!nodes) return // malformed package; nothing sane to do
  const root = nodes.find((n) => 'Types' in n) as XmlNode | undefined
  if (!root) return
  const partName = partPath.startsWith('/') ? partPath : `/${partPath}`
  const already = findAll(root, 'Override').some((o) => getAttr(o, 'PartName') === partName)
  if (already) return
  const override: XmlNode = { Override: [] }
  setAttr(override, 'PartName', partName)
  setAttr(override, 'ContentType', contentType)
  ;(root.Types as XmlNode[]).push(override)
  setXmlPart(pkg, path, nodes)
}

export function addMediaFile(pkg: DocxPackage, filename: string, data: Buffer): void {
  pkg.zip.file(`word/media/${filename}`, data)
}

export const RELATIONSHIP_TYPES = {
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
} as const

export const CONTENT_TYPES = {
  comments: 'application/vnd.openxmlformats-officedocument.wordprocessing.comments+xml',
  header: 'application/vnd.openxmlformats-officedocument.wordprocessing.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessing.footer+xml'
} as const

export { RELS_CONTENT_TYPE }
