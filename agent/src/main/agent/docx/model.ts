// Builds a JSON-friendly model of a .docx's visible content + formatting from its OOXML parts,
// for read_docx. This is intentionally a *read* projection only — edit_docx does NOT round-trip
// through this model to write changes back (that would risk dropping anything not modeled here);
// it patches the real XmlNode tree directly. Keeping this one-directional means the model here
// can stay simpler than a full OOXML object graph while edit_docx still gets full fidelity.
import {
  type XmlNode,
  childrenOf,
  tagOf,
  findAll,
  findFirst,
  findAllDeep,
  getAttr,
  plainTextOf
} from './xmlNodes'
import { type DocxPackage, getXmlPart, getRelationships, RELATIONSHIP_TYPES } from './package'

export interface RunFormat {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  font?: string
  sizePt?: number
  color?: string
  highlight?: string
  vertAlign?: 'superscript' | 'subscript'
}

export interface RunModel {
  runIndex: number
  text: string
  format: RunFormat
  /** Present when this run sits inside a `w:ins` (insertion) or `w:del` (deletion) tracked
   *  change, so read_docx surfaces existing revisions instead of silently flattening them. */
  revision?: { type: 'inserted' | 'deleted'; author?: string; date?: string }
  /** Comment ids (from w:commentRangeStart/End + w:commentReference) whose range covers this
   *  run, if any. */
  commentIds?: string[]
  image?: { relId: string; description?: string }
}

export interface ParagraphModel {
  paraIndex: number
  text: string
  style?: string
  alignment?: string
  numbering?: { numId: string; ilvl: string }
  runs: RunModel[]
}

export interface TableCellModel {
  text: string
  paragraphs: ParagraphModel[]
  gridSpan?: number
}

export interface TableRowModel {
  cells: TableCellModel[]
}

export interface TableModel {
  tableIndex: number
  rows: TableRowModel[]
}

export interface CommentModel {
  id: string
  author?: string
  date?: string
  text: string
}

export interface HeaderFooterModel {
  /** e.g. "header:default", "footer:first" */
  key: string
  paragraphs: ParagraphModel[]
}

export interface DocxModel {
  paragraphs: ParagraphModel[]
  tables: TableModel[]
  headers: HeaderFooterModel[]
  footers: HeaderFooterModel[]
  comments: CommentModel[]
  /** Plain-text rendering of the whole body (paragraphs + table cell text), one line per
   *  paragraph/row, for a quick human-readable overview alongside the structured data. */
  plainText: string
}

function readRunFormat(run: XmlNode): RunFormat {
  const rPr = findFirst(run, 'w:rPr')
  if (!rPr) return {}
  const format: RunFormat = {}
  if (findFirst(rPr, 'w:b') && getAttr(findFirst(rPr, 'w:b')!, 'val') !== '0') format.bold = true
  if (findFirst(rPr, 'w:i') && getAttr(findFirst(rPr, 'w:i')!, 'val') !== '0') format.italic = true
  const u = findFirst(rPr, 'w:u')
  if (u && getAttr(u, 'val') && getAttr(u, 'val') !== 'none') format.underline = true
  if (findFirst(rPr, 'w:strike')) format.strike = true
  const font = findFirst(rPr, 'w:rFonts')
  if (font) format.font = getAttr(font, 'ascii') ?? getAttr(font, 'hAnsi') ?? undefined
  const sz = findFirst(rPr, 'w:sz')
  if (sz) {
    const half = Number(getAttr(sz, 'val'))
    if (!Number.isNaN(half)) format.sizePt = half / 2
  }
  const color = findFirst(rPr, 'w:color')
  if (color) format.color = getAttr(color, 'val')
  const highlight = findFirst(rPr, 'w:highlight')
  if (highlight) format.highlight = getAttr(highlight, 'val')
  const vert = findFirst(rPr, 'w:vertAlign')
  if (vert) {
    const v = getAttr(vert, 'val')
    if (v === 'superscript' || v === 'subscript') format.vertAlign = v
  }
  return format
}

/** Walks a paragraph's children collecting RunModels, descending into `w:hyperlink`/`w:ins`/
 *  `w:del` wrappers (which contain runs but aren't runs themselves) and tracking which comment
 *  ranges are currently open so runs inside them get tagged. */
function readParagraphRuns(paraNode: XmlNode): RunModel[] {
  const runs: RunModel[] = []
  const openComments = new Set<string>()

  const visit = (node: XmlNode, revision?: RunModel['revision']) => {
    const tag = tagOf(node)
    if (tag === 'w:commentRangeStart') {
      const id = getAttr(node, 'id')
      if (id) openComments.add(id)
      return
    }
    if (tag === 'w:commentRangeEnd') {
      const id = getAttr(node, 'id')
      if (id) openComments.delete(id)
      return
    }
    if (tag === 'w:ins' || tag === 'w:del') {
      const rev: RunModel['revision'] = {
        type: tag === 'w:ins' ? 'inserted' : 'deleted',
        author: getAttr(node, 'author'),
        date: getAttr(node, 'date')
      }
      for (const c of childrenOf(node)) visit(c, rev)
      return
    }
    if (tag === 'w:hyperlink' || tag === 'w:smartTag') {
      for (const c of childrenOf(node)) visit(c, revision)
      return
    }
    if (tag === 'w:r') {
      const drawing = findFirst(node, 'w:drawing')
      const blip = drawing ? findAllDeep(drawing, 'a:blip')[0] : undefined
      const embedRelId = blip ? getAttr(blip, 'r:embed') : undefined
      const docPr = drawing ? findAllDeep(drawing, 'wp:docPr')[0] : undefined
      // w:delText is used instead of w:t for text inside a deletion (still readable as text).
      const text = plainTextOf(node)
      const model: RunModel = {
        runIndex: runs.length,
        text,
        format: readRunFormat(node)
      }
      if (revision) model.revision = revision
      if (openComments.size > 0) model.commentIds = [...openComments]
      if (embedRelId) model.image = { relId: embedRelId, description: docPr ? getAttr(docPr, 'descr') || getAttr(docPr, 'name') : undefined }
      runs.push(model)
    }
  }

  for (const c of childrenOf(paraNode)) visit(c)
  return runs
}

function readParagraph(paraNode: XmlNode, paraIndex: number): ParagraphModel {
  const pPr = findFirst(paraNode, 'w:pPr')
  const style = pPr ? findFirst(pPr, 'w:pStyle') : undefined
  const jc = pPr ? findFirst(pPr, 'w:jc') : undefined
  const numPr = pPr ? findFirst(pPr, 'w:numPr') : undefined
  const runs = readParagraphRuns(paraNode)
  return {
    paraIndex,
    text: runs.map((r) => r.text).join(''),
    style: style ? getAttr(style, 'val') : undefined,
    alignment: jc ? getAttr(jc, 'val') : undefined,
    numbering: numPr
      ? {
          numId: getAttr(findFirst(numPr, 'w:numId') ?? {}, 'val') ?? '',
          ilvl: getAttr(findFirst(numPr, 'w:ilvl') ?? {}, 'val') ?? '0'
        }
      : undefined,
    runs
  }
}

function readTable(tblNode: XmlNode, tableIndex: number): TableModel {
  const rows = findAll(tblNode, 'w:tr').map((tr) => {
    const cells = findAll(tr, 'w:tc').map((tc) => {
      const tcPr = findFirst(tc, 'w:tcPr')
      const gridSpan = tcPr ? findFirst(tcPr, 'w:gridSpan') : undefined
      const paragraphs = findAll(tc, 'w:p').map((p, i) => readParagraph(p, i))
      return {
        text: paragraphs.map((p) => p.text).join('\n'),
        paragraphs,
        gridSpan: gridSpan ? Number(getAttr(gridSpan, 'val')) : undefined
      }
    })
    return { cells }
  })
  return { tableIndex, rows }
}

/** Walks the body of a document-like part (document.xml, a header, or a footer — they all share
 *  the same `w:p`/`w:tbl` shape at the top level) into paragraphs + tables, in document order. */
function readBody(bodyNode: XmlNode): { paragraphs: ParagraphModel[]; tables: TableModel[] } {
  const paragraphs: ParagraphModel[] = []
  const tables: TableModel[] = []
  let paraIdx = 0
  let tblIdx = 0
  for (const child of childrenOf(bodyNode)) {
    const tag = tagOf(child)
    if (tag === 'w:p') {
      paragraphs.push(readParagraph(child, paraIdx++))
    } else if (tag === 'w:tbl') {
      tables.push(readTable(child, tblIdx++))
    }
  }
  return { paragraphs, tables }
}

async function readHeaderFooterParts(
  pkg: DocxPackage,
  kind: 'header' | 'footer'
): Promise<HeaderFooterModel[]> {
  const rels = await getRelationships(pkg, 'word/document.xml')
  const relType = kind === 'header' ? RELATIONSHIP_TYPES.header : RELATIONSHIP_TYPES.footer
  const matches = rels.filter((r) => r.type === relType)
  const out: HeaderFooterModel[] = []
  for (const rel of matches) {
    const partPath = `word/${rel.target.replace(/^\/?word\//, '')}`
    const nodes = await getXmlPart(pkg, partPath)
    if (!nodes) continue
    const root = nodes.find((n) => tagOf(n) === `w:${kind}`)
    if (!root) continue
    const { paragraphs } = readBody(root)
    out.push({ key: `${kind}:${partPath}`, paragraphs })
  }
  return out
}

async function readComments(pkg: DocxPackage): Promise<CommentModel[]> {
  const nodes = await getXmlPart(pkg, 'word/comments.xml')
  if (!nodes) return []
  const root = nodes.find((n) => tagOf(n) === 'w:comments')
  if (!root) return []
  return findAll(root, 'w:comment').map((c) => ({
    id: getAttr(c, 'id') ?? '',
    author: getAttr(c, 'author'),
    date: getAttr(c, 'date'),
    text: findAll(c, 'w:p')
      .map((p) => plainTextOf(p))
      .join('\n')
  }))
}

export async function buildDocxModel(pkg: DocxPackage): Promise<DocxModel> {
  const docNodes = await getXmlPart(pkg, 'word/document.xml')
  if (!docNodes) throw new Error('word/document.xml not found — not a valid .docx package')
  const documentEl = docNodes.find((n) => tagOf(n) === 'w:document')
  if (!documentEl) throw new Error('Malformed document.xml: missing w:document root')
  const body = findFirst(documentEl, 'w:body')
  if (!body) throw new Error('Malformed document.xml: missing w:body')

  const { paragraphs, tables } = readBody(body)
  const [headers, footers, comments] = await Promise.all([
    readHeaderFooterParts(pkg, 'header'),
    readHeaderFooterParts(pkg, 'footer'),
    readComments(pkg)
  ])

  const bodyLines = paragraphs.map((p) => p.text)
  const tableLines = tables.map((t) => t.rows.map((r) => r.cells.map((c) => c.text).join(' | ')).join('\n'))
  const plainText = [...bodyLines, ...tableLines].filter((l) => l.length > 0).join('\n')

  return { paragraphs, tables, headers, footers, comments, plainText }
}
