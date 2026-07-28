// Barrel for the core tool implementations. Split by concern into file-ops.ts, search.ts,
// web.ts, and shell.ts (see each for details) — this file re-exports everything so existing
// imports (`from './tools/index'` / `from './index'`) keep working unchanged.
export {
  resolveWorkspacePath,
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditFileTool,
  previewMultiEdit,
  normalizeEditsArg,
  deleteFileTool,
  type MultiEditOp
} from './file-ops'

export { grepTool, globTool } from './search'

export { webSearchTool, fetchUrlTool } from './web'

export { runCommandTool, killBackgroundProcess, runProcess } from './shell'

export { readTerminalTool } from './terminal'

// Re-exported for backward compatibility — canonical definitions now live in @shared/types
// (dependency-free, safe to import from test code without pulling in Electron).
export { READ_ONLY_TOOLS, MUTATING_TOOLS } from '@shared/types'
