# KlennyCode Electron Agent: Complete Tool Addition Reference

This document provides exact file paths, line numbers, and code patterns for adding new agent tools to KlennyCode. All references are concrete and ready to use as implementation templates.

---

## 1. Tool Definitions: `src/main/agent/tools/definitions.ts`

### Structure Overview

**Location:** `C:\all\projects\KlennyCode\agent\src\main\agent\tools\definitions.ts` (961 lines)

The file exports a single `getToolDefinitions()` function that returns an array of `ToolDef[]` (OpenAI-compatible tool schemas). Tool definitions are **not** hardcoded individually; they're assembled dynamically based on **gating conditions** (approval mode, workspace state, feature flags).

### Key Imports (lines 1-3)
```typescript
import type { ToolName } from '@shared/types'
import { ASSISTANT_TOOLS, CODING_ONLY_TOOLS, DOCX_TOOLS, GMAIL_READ_TOOLS, GMAIL_SEND_TOOLS, DISCORD_TOOLS } from '@shared/types'
import type { ToolDef } from '../../openrouter/client'
```

### Tool Gating Options (lines 9-36)
```typescript
export interface ToolGatingOptions {
  docxAvailableInCoding?: boolean
  gmailConnected?: boolean
  gmailReadAllowed?: boolean
  gmailSendAllowed?: boolean
  gmailAvailableInCoding?: boolean
  discordConnected?: boolean
  discordPostAllowed?: boolean
  discordAvailableInCoding?: boolean
  browserAutomationAvailable?: boolean
}
```

### Function Signature (lines 38-62)
```typescript
export function getToolDefinitions(
  mode: 'agent' | 'plan',
  restrictTo?: ToolName[] | 'all',
  codebaseSearchAvailable = false,
  hasWorkspace = true,
  isAssistant = false,
  gating: ToolGatingOptions = {},
  hasActiveChecklist = false
): ToolDef[]
```

### Tool Definition JSON Schema Pattern

**Example: `write_file` (lines 83-91)**
```typescript
{
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write or overwrite a file.',
    parameters: {
      type: 'object',
      properties: { 
        path: { type: 'string' }, 
        content: { type: 'string' } 
      },
      required: ['path', 'content']
    }
  }
}
```

---

## 2. Tool Dispatch: `src/main/agent/orchestrator/loop.ts`

### The `executeTool()` Function (lines 499–683)

Handles approval gating and result formatting before dispatch.

**Approval Gating Pattern (lines 595–612)**
```typescript
if (['write_file', 'edit_file', 'multi_edit', 'delete_file', 'write_docx', 'edit_docx', 'run_command'].includes(name)) {
  const needsApproval = approvalMode === 'manual' || (approvalMode === 'command' && name === 'run_command')
  if (needsApproval) {
    const kind = name as PendingActionKind
    const preview = await previewMutatingTool(name, args, fileRoot)
    const action = approvalManager.buildPendingFromTool(tab.id, tc.id, kind, preview.title, preview.extra)
    emit({ type: 'pending_action', tabId: tab.id, action })
    const decision = await approvalManager.waitForDecision(action.id)
    emit({ type: 'pending_action_resolved', tabId: tab.id, actionId: action.id })
    if (decision === 'reject') {
      return { payload: { ok: false, summary: 'User rejected action', error: 'rejected' }, status: 'rejected' }
    }
  }
}
```

### The `dispatchTool()` Function (lines 685–900+)

**Signature (lines 685–702)**
```typescript
async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  emit: Emit,
  signal: AbortSignal,
  subagentDepth: number,
  models: ModelInfo[],
  shellId?: string | null,
  unattended = false,
  browserAutomation?: BrowserAutomationSettings,
  onToolProgress?: (message: string) => void,
  fileRoot?: string
): Promise<ToolResultPayload>
```

**Switch Statement Pattern (lines 703+)**
```typescript
switch (name) {
  case 'read_file':
    return readFileTool(args as { path: string; offset?: number; limit?: number }, fileRoot)
  case 'write_file':
    return writeFileTool(args as { path: string; content: string }, fileRoot)
  case 'edit_file':
    return editFileTool(
      args as { path: string; old_string: string; new_string: string; replace_all?: boolean },
      fileRoot
    )
  case 'multi_edit':
    return multiEditFileTool(args as unknown as { edits: MultiEditOp[]; path?: string }, fileRoot)
  // ... 40+ more cases
  default:
    return { ok: false, summary: `Unknown tool: ${name}`, error: 'unknown_tool' }
}
```

### Return Value Convention

Every tool must return a `ToolResultPayload`:

```typescript
export type ToolResultPayload = 
  | {
      ok: true
      summary: string  // User-visible 1-2 sentence summary
      data?: Record<string, unknown>  // Structured output for the model
    }
  | {
      ok: false
      summary: string  // Error message
      error: string  // Machine-readable error code
      data?: Record<string, unknown>
    }
```

---

## 3. Approval Previews: `src/main/agent/orchestrator/approval-previews.ts`

### Function Signature (lines 15–22)

```typescript
export async function previewMutatingTool(
  name: string,
  args: Record<string, unknown>,
  root?: string
): Promise<{ title: string; extra: Partial<PendingAction> }>
```

### Pattern: File Tools with Diffs

**write_file (lines 30–38)**
```typescript
if (name === 'write_file') {
  let oldContent = ''
  try {
    const abs = resolveWorkspacePath(path, root)
    oldContent = toLf(await readFile(abs, 'utf8'))
  } catch {
    // new file — diff against empty content
  }
  return { title: `Write ${path}`, extra: { filePath: path, diff: makeDiff(oldContent, String(args.content), path) } }
}
```

**edit_file (lines 40–52)**
```typescript
if (name === 'edit_file') {
  try {
    const abs = resolveWorkspacePath(path, root)
    const content = toLf(await readFile(abs, 'utf8'))
    const match = resolveEditMatch(content, String(args.old_string), String(args.new_string))
    if (!match) return { title: `Edit ${path}`, extra: { filePath: path } }
    const updated = args.replace_all
      ? content.replaceAll(match.oldString, match.newString)
      : content.replace(match.oldString, match.newString)
    return { title: `Edit ${path}`, extra: { filePath: path, diff: makeDiff(content, updated, path) } }
  } catch {
    return { title: `Edit ${path}`, extra: { filePath: path } }
  }
}
```

---

## 4. IPC Channels: `shared/ipc.ts`

### Channel Constants (lines 24–128)

```typescript
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  setApiKey: 'settings:setApiKey',
  clearApiKey: 'settings:clearApiKey',
  
  workspaceOpen: 'workspace:open',
  workspaceGet: 'workspace:get',
  
  documentsDirectoryPick: 'documentsDirectory:pick',
  
  modelsList: 'models:list',
  shellsList: 'shells:list',
  
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  // ... ~100 more channels
  
  sendMessage: 'chat:sendMessage',
  stopGeneration: 'chat:stop',
  continueTurn: 'chat:continue',
  
  // ...
} as const
```

**Naming Convention**: colon-separated namespaces (e.g., 'memory:write', 'terminal:resize', 'chat:sendMessage').

### Type Definition: KlennyApi (lines 147–303)

The `KlennyApi` interface specifies the Electron preload API exposed to the renderer:

```typescript
export interface KlennyApi {
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  setApiKey: (key: string) => Promise<void>
  clearApiKey: () => Promise<void>
  
  openWorkspace: () => Promise<string | null>
  getWorkspace: () => Promise<string | null>
  
  listModels: (forceRefresh?: boolean) => Promise<ModelInfo[]>
  listShells: () => Promise<ShellInfo[]>
  
  sendMessage: (payload: SendMessagePayload) => Promise<void>
  stopGeneration: (tabId: string) => Promise<void>
  
  // ... ~60 more methods
}
```

---

## 5. IPC Handler Registration: `src/main/ipc.ts`

### Pattern: Settings Handler (lines 108–130)

```typescript
ipcMain.handle(IPC.settingsGet, async () => loadSettings())

ipcMain.handle(IPC.settingsSet, async (_e, patch) => {
  const next = await saveSettings(patch)
  approvalManager.setMode(next.approvalMode)
  // Re-evaluate indexing if relevant fields changed
  const relevantKeys: Array<keyof typeof patch> = [
    'codebaseIndexEnabled',
    'embeddingsModel',
    'vectorStoreBackend',
    'pineconeIndexName'
  ]
  if (relevantKeys.some((k) => k in patch)) {
    const ws = getWorkspace()
    if (ws) void refreshIndexingForWorkspace(ws)
  }
  return next
})
```

### Main Window Creation (lines 384–438)

```typescript
export function createMainWindow(): BrowserWindow {
  Menu.setApplicationMenu(null)
  
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: `${DEFAULT_BRAND_NAME} ${app.getVersion()}`,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icons/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  
  void applyBrandingToAllWindows()
  
  win.on('ready-to-show', () => win.show())
  wireMinimizeToTray(win)
  
  // Prevent the renderer's <title> from overwriting the version-suffixed title
  win.on('page-title-updated', (e) => e.preventDefault())
  
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('Preload failed:', preloadPath, error)
  })
  
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  
  return win
}
```

---

## 6. File Operations & Global Mutation Sandbox: `src/main/agent/tools/file-ops.ts`

### Path Resolution: `resolveWorkspacePath()` (lines 21–33)

```typescript
export function resolveWorkspacePath(relOrAbs: string, root?: string): string {
  if (typeof relOrAbs !== 'string' || relOrAbs.length === 0) {
    throw new Error(`Invalid path: expected a non-empty string, got ${JSON.stringify(relOrAbs)}`)
  }
  if (isAbsolute(relOrAbs)) return resolve(relOrAbs)
  const base = root ?? getWorkspace()
  if (!base) throw new Error('No workspace open. Pass an absolute path to reach a file outside a workspace.')
  return resolve(base, relOrAbs)
}
```

### Mutation Sandbox: `assertMutationAllowed()` in workspace.ts (lines 55–58)

```typescript
export function assertMutationAllowed(abs: string, root?: string): boolean {
  if (alwaysAllowedMutationRoots().some((allowed) => isInsideDirectory(abs, allowed))) return true
  return root ? isInsideDirectory(abs, root) : assertInWorkspace(abs)
}

export function alwaysAllowedMutationRoots(): string[] {
  return [globalKlennyDir(), app.getPath('userData')]
}
```

**Allowed mutation paths:**
1. Inside the open workspace (if any)
2. Inside the Assistant-tab documentsDirectory
3. Inside `~/.klenny` (global config directory) — **always**
4. Inside Electron's `userData` directory — **always**

### Read File: `readFileTool()` (lines 42–57)

```typescript
export async function readFileTool(
  args: { path: string; offset?: number; limit?: number },
  root?: string
): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  const raw = await readFile(abs, 'utf8')
  const content = toLf(raw)
  const st = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st.mtimeMs, content })
  const lines = content.split('\n')
  const offset = Math.max(1, args.offset ?? 1)
  const limit = args.limit ?? lines.length
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((l, i) => `${offset + i}|${l}`).join('\n')
  return { ok: true, summary: `Read ${args.path} (${slice.length} lines)`, data: { path: args.path, content: numbered } }
}
```

### Write File: `writeFileTool()` (lines 59–85)

```typescript
export async function writeFileTool(args: { path: string; content: string }, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertMutationAllowed(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  let oldRaw = ''
  let hadExisting = false
  try {
    oldRaw = await readFile(abs, 'utf8')
    hadExisting = true
  } catch {
    // new file
  }
  const eol = hadExisting ? detectEol(oldRaw) : '\n'
  const normalized = toLf(args.content)
  const finalContent = fromLf(normalized, eol)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, finalContent, 'utf8')
  const st = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st.mtimeMs, content: normalized })
  return {
    ok: true,
    summary: `Wrote ${args.path}`,
    data: { path: args.path, diff: makeDiff(toLf(oldRaw), normalized, args.path) }
  }
}
```

### Edit File: `editFileTool()` (lines 87–145)

```typescript
export async function editFileTool(
  args: {
    path: string
    old_string: string
    new_string: string
    replace_all?: boolean
  },
  root?: string
): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertMutationAllowed(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const raw = await readFile(abs, 'utf8')
  const eol = detectEol(raw)
  const content = toLf(raw)
  const cached = fileReadCache.get(abs)
  const st = await stat(abs)
  if (cached && cached.mtimeMs !== st.mtimeMs) {
    return {
      ok: false,
      summary: 'File changed on disk since last read',
      error: 'stale',
      data: { path: args.path, hint: 'Call read_file again, then retry edit_file with the exact text shown.' }
    }
  }
  
  const match = resolveEditMatch(content, args.old_string, args.new_string)
  if (!match) {
    return {
      ok: false,
      summary: 'old_string not found',
      error: 'not_found',
      data: { path: args.path, ...buildEditNotFoundHelp(content, args.old_string) }
    }
  }
  
  const count = countOccurrences(content, match.oldString)
  if (!args.replace_all && count > 1) {
    return {
      ok: false,
      summary: `old_string appears ${count} times; use replace_all or provide more context`,
      error: 'ambiguous',
      data: { path: args.path, occurrences: count }
    }
  }
  
  const next = args.replace_all
    ? content.replaceAll(match.oldString, match.newString)
    : content.replace(match.oldString, match.newString)
  
  await writeFile(abs, fromLf(next, eol), 'utf8')
  const st2 = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st2.mtimeMs, content: next })
  return {
    ok: true,
    summary: args.replace_all ? `Edited ${args.path} (${count} replacements)` : `Edited ${args.path}`,
    data: { path: args.path, diff: makeDiff(content, next, args.path), replacements: count }
  }
}
```

---

## 7. Dependencies: `package.json`

**Key Dependencies for Tools (lines 28–53):**
```json
{
  "dependencies": {
    "@vscode/ripgrep": "^1.15.14",
    "diff": "^7.0.0",
    "docx": "^9.7.1",
    "discord.js": "^14.27.0",
    "fast-glob": "^3.3.3",
    "fast-xml-parser": "^5.10.1",
    "googleapis": "^173.0.0",
    "gray-matter": "^4.0.3",
    "jszip": "^3.10.1",
    "nanoid": "^5.0.9",
    "node-pty": "^1.1.0",
    "playwright": "^1.62.0",
    "react": "^18.3.1",
    "vectra": "^0.15.0"
  }
}
```

**No AST parsing libraries** (esbuild, acorn, babel) are currently included. If needed for a new tool, add them to dependencies.

---

## 8. Preload Bridge Pattern: `src/preload/index.ts`

**Location:** `C:\all\projects\KlennyCode\agent\src\preload\index.ts` (150 lines)

```typescript
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { KlennyApi } from '@shared/ipc'

const api: KlennyApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  
  // Request-response pattern
  sendMessage: (payload) => ipcRenderer.invoke(IPC.sendMessage, payload),
  
  // One-way listener pattern
  onStreamEvent: (cb) => {
    const listener = (_: unknown, event: AgentStreamEvent) => cb(event)
    ipcRenderer.on('agent:stream', listener)
    return () => ipcRenderer.removeListener('agent:stream', listener)
  }
}

contextBridge.exposeInMainWorld('klenny', api)

declare global {
  interface Window {
    klenny: KlennyApi
  }
}
```

---

## Summary: Checklist for Adding a New Tool

To add a new tool:

1. **Define schema** in `src/main/agent/tools/definitions.ts` (add to `all[]` array, lines 63+)
2. **Implement tool** in appropriate module (file-ops.ts, search.ts, web.ts, shell.ts, or new module)
3. **Return `ToolResultPayload`** (ok/error shape)
4. **Add dispatch case** in `dispatchTool()` (loop.ts, lines 703+)
5. **Add approval preview** if mutating (approval-previews.ts, lines 15+)
6. **Add gating flags** if optional (ToolGatingOptions in definitions.ts)
7. **If UI needed:** Add IPC channel, handler, preload bridge, KlennyApi interface
8. **Update README.md** if behavior affects documentation
9. **Write tests** in `agent/tests/`

