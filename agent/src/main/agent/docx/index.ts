// Barrel for the docx module — read_docx/write_docx/edit_docx tool implementations plus the
// types callers need (edit op shapes, write spec shapes). See read.ts/write.ts/edit.ts for the
// tools themselves, model.ts for the read-side OOXML->JSON projection, ops.ts/xmlNodes.ts/
// package.ts for the direct-OOXML-patch machinery edit_docx uses to stay non-destructive.
export { readDocxTool } from './read'
export { writeDocxTool, type WriteDocxSpec, type BlockSpec, type ParagraphSpec, type RunSpec, type ImageSpec, type TableSpec } from './write'
export { editDocxTool, type EditDocxArgs } from './edit'
export type { DocxEditOp, RunSpecLite, RunFormatPatch, TableCellSpecLite } from './ops'
export type { DocxModel, ParagraphModel, RunModel, TableModel, CommentModel, HeaderFooterModel } from './model'
