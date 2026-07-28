// Operation appliers for edit_docx: each function mutates a real, parsed OOXML part in place
// (via the XmlNode tree from xmlNodes.ts), so every paragraph/run/table this module doesn't
// touch survives byte-for-byte on save — see package.ts's saveDocxPackage. This deliberately
// does NOT round-trip through model.ts's DocxModel; that model is a read-only projection and
// regenerating XML from it would risk dropping anything it doesn't represent (unusual
// paragraph/run properties, existing tracked changes elsewhere in the same paragraph, etc).
import { readFile } from 'node:fs/promises'
import {
  type XmlNode,
  childrenOf,
  tagOf,
  findFirst,
  getAttr,
  setAttr,
  makeTextNode,
  parseXml,
  cloneNode
} from './xmlNodes'
import {
  type DocxPackage,
  getXmlPart,
  setXmlPart,
  getRelationships,
  addRelationship,
  addMediaFile,
  ensureContentTypeOverride,
  RELATIONSHIP_TYPES,
  CONTENT_TYPES
} from './package'

export interface RunSpecLite {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  font?: string
  sizePt?: number
  color?: string
  highlight?: string
}

export interface TableCellSpecLite {
  text?: string
  runs?: RunSpecLite[]
  colSpan?: number
}

export interface RunFormatPatch {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  font?: string
  sizePt?: number
  color?: string
  highlight?: string
}

export type DocxEditOp =
  | { op: 'setRunText'; part?: string; paraIndex: number; runIndex: number; text: string }
  | { op: 'setRunFormat'; part?: string; paraIndex: number; runIndex: number; format: RunFormatPatch }
  | { op: 'setParagraphFormat'; part?: string; paraIndex: number; alignment?: string; style?: string }
  | {
      op: 'insertParagraph'
      part?: string
      afterParaIndex: number
      text?: string
      runs?: RunSpecLite[]
      heading?: 1 | 2 | 3 | 4 | 5 | 6
      alignment?: string
    }
  | { op: 'deleteParagraph'; part?: string; paraIndex: number }
  | { op: 'insertTable'; part?: string; afterParaIndex: number; rows: TableCellSpecLite[][]; headerRow?: boolean }
  | {
      op: 'insertImage'
      part?: string
      afterParaIndex: number
      path: string
      widthPx: number
      heightPx: number
      description?: string
    }
  | { op: 'addComment'; part?: string; paraIndex: number; runIndexStart: number; runIndexEnd: number; text: string; author?: string }

/** Strips the "header:"/"footer:" prefix read_docx's headers[].key/footers[].key use, so users
 *  can pass that key verbatim as `part` — bare part paths (or omitted, meaning the main
 *  document) work too. */
function normalizePart(part?: string): string {
  if (!part) return 'word/document.xml'
  return part.replace(/^(header|footer):/, '')
}

interface PartHandle {
  partPath: string
  nodes: XmlNode[]
  /** The element whose direct children are the w:p/w:tbl sequence — w:body for the main
   *  document, or the w:hdr/w:ftr root itself for headers/footers. */
  container: XmlNode
}

async function resolvePart(pkg: DocxPackage, part?: string): Promise<PartHandle> {
  const partPath = normalizePart(part)
  const nodes = await getXmlPart(pkg, partPath)
  if (!nodes) throw new Error(`Part not found: ${partPath}`)
  const root = nodes.find((n) => ['w:document', 'w:hdr', 'w:ftr'].includes(tagOf(n) ?? ''))
  if (!root) throw new Error(`Malformed part (no w:document/w:hdr/w:ftr root): ${partPath}`)
  const container = tagOf(root) === 'w:document' ? findFirst(root, 'w:body') : root
  if (!container) throw new Error(`Malformed part (missing w:body): ${partPath}`)
  return { partPath, nodes, container }
}

/** Locates every `w:p` that is a direct child of `container` (document/header/footer body),
 *  paired with its real array index for splice-based insert/delete — paraIndex addressing
 *  matches model.ts's readBody, which only counts top-level w:p elements the same way. */
function locateParagraphs(container: XmlNode): { node: XmlNode; index: number }[] {
  const kids = childrenOf(container)
  const out: { node: XmlNode; index: number }[] = []
  kids.forEach((k, i) => {
    if (tagOf(k) === 'w:p') out.push({ node: k, index: i })
  })
  return out
}

/** Locates every `w:r` reachable from a paragraph (including inside w:hyperlink/w:ins/w:del
 *  wrappers), each paired with the actual array it lives in + its index there — mirrors
 *  model.ts's readParagraphRuns traversal so runIndex addressing lines up with what read_docx
 *  reported, but here we keep a *mutable* reference back into the real tree. */
function locateRuns(paraNode: XmlNode): { node: XmlNode; parent: XmlNode[]; index: number }[] {
  const out: { node: XmlNode; parent: XmlNode[]; index: number }[] = []
  const visit = (node: XmlNode) => {
    const kids = childrenOf(node)
    kids.forEach((child, i) => {
      const tag = tagOf(child)
      if (tag === 'w:r') {
        out.push({ node: child, parent: kids, index: i })
      } else if (tag === 'w:hyperlink' || tag === 'w:smartTag' || tag === 'w:ins' || tag === 'w:del') {
        visit(child)
      }
    })
  }
  visit(paraNode)
  return out
}

function getOrCreateChild(parent: XmlNode, tag: string, atFront = true): XmlNode {
  const existing = findFirst(parent, tag)
  if (existing) return existing
  const parentTag = tagOf(parent)
  if (!parentTag) throw new Error('getOrCreateChild called on a non-element node')
  const created: XmlNode = { [tag]: [] }
  const kids = childrenOf(parent)
  if (atFront) kids.unshift(created)
  else kids.push(created)
  return created
}

function removeChild(parent: XmlNode, tag: string): void {
  const parentTag = tagOf(parent)
  if (!parentTag) return
  const kids = parent[parentTag] as XmlNode[]
  const idx = kids.findIndex((k) => tagOf(k) === tag)
  if (idx >= 0) kids.splice(idx, 1)
}

// OOXML's CT_RPr/CT_PPr are strict `xsd:sequence`s — Word (and some other consumers) can flag a
// document as needing "repair" if child elements appear out of schema order. These list the
// subset of each sequence this module ever inserts, in schema order, so insertInOrder() below
// can always splice a new/patched property into the right slot instead of just push/unshift-ing.
const RPR_ORDER = [
  'w:rStyle',
  'w:rFonts',
  'w:b',
  'w:bCs',
  'w:i',
  'w:iCs',
  'w:caps',
  'w:smallCaps',
  'w:strike',
  'w:dstrike',
  'w:color',
  'w:sz',
  'w:szCs',
  'w:highlight',
  'w:u',
  'w:vertAlign',
  'w:lang'
]

const PPR_ORDER = [
  'w:pStyle',
  'w:keepNext',
  'w:keepLines',
  'w:pageBreakBefore',
  'w:numPr',
  'w:tabs',
  'w:spacing',
  'w:ind',
  'w:jc',
  'w:outlineLvl',
  'w:rPr',
  'w:sectPr'
]

/** Splices `node` (tagged `tag`) into `parent`'s children at the position schema order (`order`)
 *  says it belongs, relative to whichever of `parent`'s existing children are also in `order`.
 *  An existing child whose tag isn't in `order` at all is left wherever it is and ignored when
 *  deciding placement (safest default for anything this module doesn't otherwise touch). */
function insertInOrder(parent: XmlNode, tag: string, node: XmlNode, order: string[]): void {
  const parentTag = tagOf(parent)
  if (!parentTag) throw new Error('insertInOrder called on a non-element node')
  const kids = parent[parentTag] as XmlNode[]
  const myRank = order.indexOf(tag)
  let insertAt = kids.length
  for (let i = 0; i < kids.length; i++) {
    const rank = order.indexOf(tagOf(kids[i]) ?? '')
    if (rank !== -1 && rank > myRank) {
      insertAt = i
      break
    }
  }
  kids.splice(insertAt, 0, node)
}

function applyRunFormatPatch(rPr: XmlNode, patch: RunFormatPatch): void {
  if (patch.bold !== undefined) {
    removeChild(rPr, 'w:b')
    if (patch.bold) insertInOrder(rPr, 'w:b', { 'w:b': [] }, RPR_ORDER)
  }
  if (patch.italic !== undefined) {
    removeChild(rPr, 'w:i')
    if (patch.italic) insertInOrder(rPr, 'w:i', { 'w:i': [] }, RPR_ORDER)
  }
  if (patch.underline !== undefined) {
    removeChild(rPr, 'w:u')
    if (patch.underline) {
      const u: XmlNode = { 'w:u': [] }
      setAttr(u, 'val', 'single')
      insertInOrder(rPr, 'w:u', u, RPR_ORDER)
    }
  }
  if (patch.strike !== undefined) {
    removeChild(rPr, 'w:strike')
    if (patch.strike) insertInOrder(rPr, 'w:strike', { 'w:strike': [] }, RPR_ORDER)
  }
  if (patch.font !== undefined) {
    removeChild(rPr, 'w:rFonts')
    if (patch.font) {
      const f: XmlNode = { 'w:rFonts': [] }
      setAttr(f, 'ascii', patch.font)
      setAttr(f, 'hAnsi', patch.font)
      insertInOrder(rPr, 'w:rFonts', f, RPR_ORDER)
    }
  }
  if (patch.sizePt !== undefined) {
    removeChild(rPr, 'w:sz')
    removeChild(rPr, 'w:szCs')
    if (patch.sizePt) {
      const half = String(Math.round(patch.sizePt * 2))
      const sz: XmlNode = { 'w:sz': [] }
      setAttr(sz, 'val', half)
      const szCs: XmlNode = { 'w:szCs': [] }
      setAttr(szCs, 'val', half)
      insertInOrder(rPr, 'w:szCs', szCs, RPR_ORDER)
      insertInOrder(rPr, 'w:sz', sz, RPR_ORDER)
    }
  }
  if (patch.color !== undefined) {
    removeChild(rPr, 'w:color')
    if (patch.color) {
      const c: XmlNode = { 'w:color': [] }
      setAttr(c, 'val', patch.color)
      insertInOrder(rPr, 'w:color', c, RPR_ORDER)
    }
  }
  if (patch.highlight !== undefined) {
    removeChild(rPr, 'w:highlight')
    if (patch.highlight) {
      const h: XmlNode = { 'w:highlight': [] }
      setAttr(h, 'val', patch.highlight)
      insertInOrder(rPr, 'w:highlight', h, RPR_ORDER)
    }
  }
}

function buildRunNode(spec: RunSpecLite): XmlNode {
  const rPr: XmlNode = { 'w:rPr': [] }
  applyRunFormatPatch(rPr, spec)
  const children: XmlNode[] = []
  if ((rPr['w:rPr'] as XmlNode[]).length > 0) children.push(rPr)
  children.push(makeTextNode(spec.text))
  return { 'w:r': children }
}

function buildParagraphNode(opts: {
  text?: string
  runs?: RunSpecLite[]
  heading?: 1 | 2 | 3 | 4 | 5 | 6
  alignment?: string
}): XmlNode {
  const runs = opts.runs ?? (opts.text !== undefined ? [{ text: opts.text }] : [])
  const pPrChildren: XmlNode[] = []
  if (opts.heading) {
    const style: XmlNode = { 'w:pStyle': [] }
    setAttr(style, 'val', `Heading${opts.heading}`)
    pPrChildren.push(style)
  }
  if (opts.alignment) {
    const jc: XmlNode = { 'w:jc': [] }
    setAttr(jc, 'val', opts.alignment)
    pPrChildren.push(jc)
  }
  const children: XmlNode[] = []
  if (pPrChildren.length > 0) children.push({ 'w:pPr': pPrChildren })
  for (const r of runs) children.push(buildRunNode(r))
  return { 'w:p': children }
}

function buildTableNode(rows: TableCellSpecLite[][], headerRow?: boolean): XmlNode {
  const colCount = Math.max(...rows.map((r) => r.length), 1)
  const gridCols: XmlNode[] = Array.from({ length: colCount }, () => ({ 'w:gridCol': [] }))

  const tblW: XmlNode = { 'w:tblW': [] }
  setAttr(tblW, 'w', '5000')
  setAttr(tblW, 'type', 'pct')

  const tblBorders: XmlNode = { 'w:tblBorders': [] }
  for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
    const b: XmlNode = { [`w:${side}`]: [] }
    setAttr(b, 'val', 'single')
    setAttr(b, 'sz', '4')
    setAttr(b, 'space', '0')
    setAttr(b, 'color', 'auto')
    ;(tblBorders['w:tblBorders'] as XmlNode[]).push(b)
  }

  const tblPr: XmlNode = { 'w:tblPr': [tblW, tblBorders] }

  const trNodes = rows.map((row, rowIdx) => {
    const tcNodes = row.map((cell) => {
      const tcPrChildren: XmlNode[] = []
      if (cell.colSpan && cell.colSpan > 1) {
        const gridSpan: XmlNode = { 'w:gridSpan': [] }
        setAttr(gridSpan, 'val', String(cell.colSpan))
        tcPrChildren.push(gridSpan)
      }
      const paragraph = buildParagraphNode({ text: cell.text, runs: cell.runs })
      const tcChildren: XmlNode[] = []
      if (tcPrChildren.length > 0) tcChildren.push({ 'w:tcPr': tcPrChildren })
      tcChildren.push(paragraph)
      return { 'w:tc': tcChildren }
    })
    const trPrChildren: XmlNode[] = []
    if (headerRow && rowIdx === 0) trPrChildren.push({ 'w:tblHeader': [] })
    const trChildren: XmlNode[] = []
    if (trPrChildren.length > 0) trChildren.push({ 'w:trPr': trPrChildren })
    trChildren.push(...tcNodes)
    return { 'w:tr': trChildren }
  })

  return { 'w:tbl': [tblPr, { 'w:tblGrid': gridCols }, ...trNodes] }
}

function insertAfterParaIndex(container: XmlNode, afterParaIndex: number, newNode: XmlNode): void {
  const containerTag = tagOf(container)
  if (!containerTag) throw new Error('insertAfterParaIndex: container is not an element')
  const kids = container[containerTag] as XmlNode[]
  const paragraphs = locateParagraphs(container)
  if (afterParaIndex < 0) {
    kids.unshift(newNode)
    return
  }
  const target = paragraphs[afterParaIndex]
  if (!target) {
    kids.push(newNode)
    return
  }
  kids.splice(target.index + 1, 0, newNode)
}

const EMU_PER_PX = 9525

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildDrawingXml(rId: string, widthPx: number, heightPx: number, docPrId: number, description?: string): string {
  const cx = Math.round(widthPx * EMU_PER_PX)
  const cy = Math.round(heightPx * EMU_PER_PX)
  const descr = escapeXmlAttr(description ?? 'Image')
  return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="Picture ${docPrId}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

/** Counts existing inline drawings across the whole document part so a freshly-inserted image
 *  gets a docPr id that doesn't collide with any already present (Word tolerates duplicates in
 *  practice, but keeping ids unique is the documented-correct behavior). */
function countExistingDrawings(container: XmlNode): number {
  let n = 0
  const walk = (node: XmlNode) => {
    for (const c of childrenOf(node)) {
      if (tagOf(c) === 'wp:docPr') n++
      walk(c)
    }
  }
  walk(container)
  return n
}

export interface OpResult {
  description: string
}

export async function applyEditOp(pkg: DocxPackage, op: DocxEditOp): Promise<OpResult> {
  const { partPath, nodes, container } = await resolvePart(pkg, op.part)
  const commit = () => setXmlPart(pkg, partPath, nodes)

  switch (op.op) {
    case 'setRunText': {
      const paragraphs = locateParagraphs(container)
      const para = paragraphs[op.paraIndex]
      if (!para) throw new Error(`paraIndex ${op.paraIndex} out of range (part has ${paragraphs.length} paragraphs)`)
      const runs = locateRuns(para.node)
      const run = runs[op.runIndex]
      if (!run) throw new Error(`runIndex ${op.runIndex} out of range (paragraph has ${runs.length} runs)`)
      if (findFirst(run.node, 'w:drawing')) throw new Error(`Run ${op.runIndex} is an image, not text — can't setRunText on it`)
      const rPr = findFirst(run.node, 'w:rPr')
      const newChildren: XmlNode[] = []
      if (rPr) newChildren.push(rPr)
      newChildren.push(makeTextNode(op.text))
      run.node['w:r'] = newChildren
      commit()
      return { description: `Set run #${op.runIndex} of paragraph #${op.paraIndex} text` }
    }
    case 'setRunFormat': {
      const paragraphs = locateParagraphs(container)
      const para = paragraphs[op.paraIndex]
      if (!para) throw new Error(`paraIndex ${op.paraIndex} out of range (part has ${paragraphs.length} paragraphs)`)
      const runs = locateRuns(para.node)
      const run = runs[op.runIndex]
      if (!run) throw new Error(`runIndex ${op.runIndex} out of range (paragraph has ${runs.length} runs)`)
      const rPr = getOrCreateChild(run.node, 'w:rPr')
      applyRunFormatPatch(rPr, op.format)
      commit()
      return { description: `Set formatting on run #${op.runIndex} of paragraph #${op.paraIndex}` }
    }
    case 'setParagraphFormat': {
      const paragraphs = locateParagraphs(container)
      const para = paragraphs[op.paraIndex]
      if (!para) throw new Error(`paraIndex ${op.paraIndex} out of range (part has ${paragraphs.length} paragraphs)`)
      const pPr = getOrCreateChild(para.node, 'w:pPr')
      if (op.alignment !== undefined) {
        removeChild(pPr, 'w:jc')
        if (op.alignment) {
          const jc: XmlNode = { 'w:jc': [] }
          setAttr(jc, 'val', op.alignment)
          insertInOrder(pPr, 'w:jc', jc, PPR_ORDER)
        }
      }
      if (op.style !== undefined) {
        removeChild(pPr, 'w:pStyle')
        if (op.style) {
          const style: XmlNode = { 'w:pStyle': [] }
          setAttr(style, 'val', op.style)
          insertInOrder(pPr, 'w:pStyle', style, PPR_ORDER)
        }
      }
      commit()
      return { description: `Set paragraph #${op.paraIndex} formatting` }
    }
    case 'insertParagraph': {
      const newNode = buildParagraphNode(op)
      insertAfterParaIndex(container, op.afterParaIndex, newNode)
      commit()
      return { description: `Inserted a new paragraph after #${op.afterParaIndex}` }
    }
    case 'deleteParagraph': {
      const paragraphs = locateParagraphs(container)
      const para = paragraphs[op.paraIndex]
      if (!para) throw new Error(`paraIndex ${op.paraIndex} out of range (part has ${paragraphs.length} paragraphs)`)
      const containerTag = tagOf(container)!
      ;(container[containerTag] as XmlNode[]).splice(para.index, 1)
      commit()
      return { description: `Deleted paragraph #${op.paraIndex}` }
    }
    case 'insertTable': {
      const newNode = buildTableNode(op.rows, op.headerRow)
      insertAfterParaIndex(container, op.afterParaIndex, newNode)
      commit()
      return { description: `Inserted a ${op.rows.length}-row table after paragraph #${op.afterParaIndex}` }
    }
    case 'insertImage': {
      const data = await readFile(op.path)
      const ext = op.path.split('.').pop()?.toLowerCase() ?? 'png'
      const rels = await getRelationships(pkg, partPath)
      const mediaCount = rels.filter((r) => r.type === RELATIONSHIP_TYPES.image).length
      const filename = `klenny_image_${Date.now()}_${mediaCount + 1}.${ext}`
      addMediaFile(pkg, filename, data)
      const rId = await addRelationship(pkg, partPath, RELATIONSHIP_TYPES.image, `media/${filename}`)
      const docPrId = countExistingDrawings(container) + 1000
      const drawingXml = buildDrawingXml(rId, op.widthPx, op.heightPx, docPrId, op.description)
      const drawingNode = parseXml(drawingXml)[0]
      const wrapperPara: XmlNode = { 'w:p': [drawingNode] }
      insertAfterParaIndex(container, op.afterParaIndex, wrapperPara)
      commit()
      return { description: `Inserted image "${op.path}" after paragraph #${op.afterParaIndex}` }
    }
    case 'addComment': {
      const paragraphs = locateParagraphs(container)
      const para = paragraphs[op.paraIndex]
      if (!para) throw new Error(`paraIndex ${op.paraIndex} out of range (part has ${paragraphs.length} paragraphs)`)
      const runs = locateRuns(para.node)
      const startRun = runs[op.runIndexStart]
      const endRun = runs[op.runIndexEnd]
      if (!startRun || !endRun) throw new Error(`runIndexStart/runIndexEnd out of range (paragraph has ${runs.length} runs)`)

      const commentId = await nextCommentId(pkg)
      await appendComment(pkg, commentId, op.text, op.author)

      const startMarker: XmlNode = { 'w:commentRangeStart': [] }
      setAttr(startMarker, 'id', String(commentId))
      const endMarker: XmlNode = { 'w:commentRangeEnd': [] }
      setAttr(endMarker, 'id', String(commentId))
      const refRun: XmlNode = { 'w:r': [{ 'w:commentReference': [] }] }
      setAttr((refRun['w:r'] as XmlNode[])[0], 'id', String(commentId))

      // Insert commentRangeStart immediately before the start run, and commentRangeEnd + the
      // reference run immediately after the end run — both within their own parent arrays
      // (which differ if runs sit inside a hyperlink/ins/del wrapper).
      startRun.parent.splice(startRun.index, 0, startMarker)
      // If start and end share the same parent array and start comes before end, the above
      // splice shifted end's index by 1.
      const endIndex = startRun.parent === endRun.parent && startRun.index <= endRun.index ? endRun.index + 1 : endRun.index
      endRun.parent.splice(endIndex + 1, 0, endMarker, refRun)

      commit()
      return { description: `Added comment on runs ${op.runIndexStart}-${op.runIndexEnd} of paragraph #${op.paraIndex}` }
    }
    default:
      throw new Error(`Unknown edit_docx op: ${(op as { op: string }).op}`)
  }
}

async function nextCommentId(pkg: DocxPackage): Promise<number> {
  const nodes = await getXmlPart(pkg, 'word/comments.xml')
  if (!nodes) return 0
  const root = nodes.find((n) => tagOf(n) === 'w:comments')
  if (!root) return 0
  const ids = childrenOf(root)
    .filter((c) => tagOf(c) === 'w:comment')
    .map((c) => Number(getAttr(c, 'id') ?? '0'))
  return ids.length > 0 ? Math.max(...ids) + 1 : 0
}

async function appendComment(pkg: DocxPackage, id: number, text: string, author?: string): Promise<void> {
  const partPath = 'word/comments.xml'
  let nodes = await getXmlPart(pkg, partPath)
  let root: XmlNode
  if (!nodes) {
    root = { 'w:comments': [] }
    setAttr(root, 'xmlns:w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
    nodes = [root]
    await ensureContentTypeOverride(pkg, `/${partPath}`, CONTENT_TYPES.comments)
    const existing = await getRelationships(pkg, 'word/document.xml')
    if (!existing.some((r) => r.type === RELATIONSHIP_TYPES.comments)) {
      await addRelationship(pkg, 'word/document.xml', RELATIONSHIP_TYPES.comments, 'comments.xml')
    }
  } else {
    root = nodes.find((n) => tagOf(n) === 'w:comments') as XmlNode
  }
  const comment: XmlNode = { 'w:comment': [{ 'w:p': [{ 'w:r': [makeTextNode(text)] }] }] }
  setAttr(comment, 'id', String(id))
  setAttr(comment, 'author', author ?? 'Klenny')
  setAttr(comment, 'date', new Date().toISOString())
  setAttr(comment, 'initials', (author ?? 'K').slice(0, 2).toUpperCase())
  ;(root['w:comments'] as XmlNode[]).push(comment)
  setXmlPart(pkg, partPath, nodes)
}

export { cloneNode }
