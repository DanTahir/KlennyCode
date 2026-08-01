// write_docx tool implementation — generates a brand-new .docx from a structured spec using the
// `docx` package (dolanmiu), which owns the OPC/zip internals for freshly-created files. This is
// intentionally separate from edit_docx's direct-OOXML-patch approach: for a file that doesn't
// exist yet there's nothing to preserve, so the declarative generator API is simpler and safer
// than hand-building XML from scratch.
import { readFile } from 'node:fs/promises'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  Header,
  Footer,
  WidthType,
  type IImageOptions,
  type ParagraphChild
} from 'docx'
import type { ToolResultPayload } from '@shared/types'
import { resolveWorkspacePath } from '../tools/file-ops'
import { assertMutationAllowed } from '../../workspace'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface RunSpec {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  font?: string
  sizePt?: number
  color?: string
  highlight?: string
  break?: boolean
}

export type HeadingLevelSpec = 1 | 2 | 3 | 4 | 5 | 6

export interface ParagraphSpec {
  type?: 'paragraph'
  text?: string
  runs?: RunSpec[]
  heading?: HeadingLevelSpec
  alignment?: 'left' | 'center' | 'right' | 'justify'
  bullet?: boolean
  numbered?: boolean
  indentLevel?: number
  spacingBeforePt?: number
  spacingAfterPt?: number
}

export interface ImageSpec {
  type: 'image'
  path: string
  widthPx: number
  heightPx: number
  alignment?: 'left' | 'center' | 'right'
}

export interface PageBreakSpec {
  type: 'pageBreak'
}

export interface TableCellSpec {
  text?: string
  runs?: RunSpec[]
  colSpan?: number
  shading?: string
}

export interface TableSpec {
  type: 'table'
  rows: TableCellSpec[][]
  headerRow?: boolean
  columnWidthsPct?: number[]
}

export type BlockSpec = ParagraphSpec | ImageSpec | PageBreakSpec | TableSpec

export interface WriteDocxSpec {
  path: string
  orientation?: 'portrait' | 'landscape'
  header?: ParagraphSpec[]
  footer?: ParagraphSpec[]
  children: BlockSpec[]
}

function alignmentOf(a?: string) {
  switch (a) {
    case 'center':
      return AlignmentType.CENTER
    case 'right':
      return AlignmentType.RIGHT
    case 'justify':
      return AlignmentType.JUSTIFIED
    default:
      return AlignmentType.LEFT
  }
}

function headingOf(level?: HeadingLevelSpec) {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1
    case 2:
      return HeadingLevel.HEADING_2
    case 3:
      return HeadingLevel.HEADING_3
    case 4:
      return HeadingLevel.HEADING_4
    case 5:
      return HeadingLevel.HEADING_5
    case 6:
      return HeadingLevel.HEADING_6
    default:
      return undefined
  }
}

function buildRuns(spec: ParagraphSpec): ParagraphChild[] {
  const runs = spec.runs ?? (spec.text !== undefined ? [{ text: spec.text }] : [])
  return runs.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italic,
        underline: r.underline ? {} : undefined,
        strike: r.strike,
        font: r.font,
        size: r.sizePt ? r.sizePt * 2 : undefined,
        color: r.color,
        highlight: r.highlight as never,
        break: r.break ? 1 : undefined
      })
  )
}

function buildParagraph(spec: ParagraphSpec): Paragraph {
  const numbering = spec.bullet
    ? { reference: 'klenny-bullet-list', level: spec.indentLevel ?? 0 }
    : spec.numbered
      ? { reference: 'klenny-numbered-list', level: spec.indentLevel ?? 0 }
      : undefined
  return new Paragraph({
    children: buildRuns(spec),
    heading: headingOf(spec.heading),
    alignment: alignmentOf(spec.alignment),
    numbering,
    spacing: {
      before: spec.spacingBeforePt ? spec.spacingBeforePt * 20 : undefined,
      after: spec.spacingAfterPt ? spec.spacingAfterPt * 20 : undefined
    }
  })
}

async function buildImage(spec: ImageSpec, root?: string): Promise<Paragraph> {
  const abs = resolveWorkspacePath(spec.path, root)
  const data = await readFile(abs)
  const ext = spec.path.split('.').pop()?.toLowerCase()
  const type: IImageOptions['type'] = ext === 'jpeg' ? 'jpg' : ext === 'png' ? 'png' : ext === 'gif' ? 'gif' : ext === 'bmp' ? 'bmp' : 'png'
  const image = new ImageRun({
    type,
    data,
    transformation: { width: spec.widthPx, height: spec.heightPx }
  } as IImageOptions)
  return new Paragraph({ children: [image], alignment: alignmentOf(spec.alignment) })
}

function buildTable(spec: TableSpec): Table {
  const rows = spec.rows.map((row, rowIdx) => {
    const cells = row.map((cell) => {
      const paragraph = new Paragraph({
        children: buildRuns({ runs: cell.runs, text: cell.text }),
        alignment: AlignmentType.LEFT
      })
      return new TableCell({
        children: [paragraph],
        columnSpan: cell.colSpan,
        shading: cell.shading ? { fill: cell.shading } : undefined
      })
    })
    return new TableRow({ children: cells, tableHeader: spec.headerRow && rowIdx === 0 })
  })
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE }
  })
}

export async function writeDocxTool(args: WriteDocxSpec, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertMutationAllowed(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }

  const children: (Paragraph | Table)[] = []
  try {
    for (const block of args.children) {
      if (block.type === 'table') {
        children.push(buildTable(block))
      } else if (block.type === 'image') {
        children.push(await buildImage(block, root))
      } else if (block.type === 'pageBreak') {
        children.push(new Paragraph({ children: [new TextRun({ text: '', break: 1 })], pageBreakBefore: true }))
      } else {
        children.push(buildParagraph(block))
      }
    }
  } catch (e) {
    return { ok: false, summary: 'Failed to build document content', error: e instanceof Error ? e.message : String(e) }
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'klenny-bullet-list',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: 'bullet' as const,
            text: '\u2022',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 + level * 360, hanging: 360 } } }
          }))
        },
        {
          reference: 'klenny-numbered-list',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: 'decimal' as const,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 + level * 360, hanging: 360 } } }
          }))
        }
      ]
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation: args.orientation === 'landscape' ? 'landscape' : 'portrait'
            }
          }
        },
        headers: args.header ? { default: new Header({ children: args.header.map((p) => buildParagraph(p)) }) } : undefined,
        footers: args.footer ? { default: new Footer({ children: args.footer.map((p) => buildParagraph(p)) }) } : undefined,
        children
      }
    ]
  })

  const buf = await Packer.toBuffer(doc)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, buf)

  return {
    ok: true,
    summary: `Wrote ${args.path} (${args.children.length} blocks)`,
    data: { path: args.path }
  }
}
