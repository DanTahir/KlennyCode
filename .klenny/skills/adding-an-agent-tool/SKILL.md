---
name: adding-an-agent-tool
description: >-
  Step-by-step reference for adding a new agent tool to KlennyCode — where the
  schema, dispatch case, approval preview, tool-name registries, ledger paths,
  barrel export and tests must all be touched, plus the prompt-caching rule that
  forbids state-driven tool gating. Read this before adding, removing or
  re-gating any tool.
---

> Anchors here are **symbol names and grep patterns, never line numbers** — an earlier version of
> this reference lived as a root-level markdown file full of line numbers and every one of them had
> rotted (`executeTool` had moved ~500 lines, `resolveWorkspacePath` ~120). Grep for the symbol.

## The files a new tool touches

| Step | File | What goes there |
|------|------|-----------------|
| 1 | `agent/shared/types.ts` | add the name to the `ToolName` union, plus any family arrays that apply |
| 2 | `agent/src/main/agent/tools/<module>.ts` | the implementation, returning `ToolResultPayload` |
| 3 | `agent/src/main/agent/tools/index.ts` | re-export from the barrel |
| 4 | `agent/src/main/agent/tools/definitions.ts` | the JSON schema in `getToolDefinitions()`'s `all[]` |
| 5 | `agent/src/main/agent/orchestrator/loop.ts` | a `case` in `dispatchTool()`, and an approval entry in `executeTool()` if it mutates |
| 6 | `agent/src/main/agent/orchestrator/approval-previews.ts` | a branch in `previewMutatingTool()` if it mutates |
| 7 | `agent/src/main/agent/orchestrator/ledger.ts` | `WRITE_TOOLS` + `collectPathsFromArgs` if it creates files |
| 8 | `agent/shared/ipc.ts`, `agent/src/main/ipc.ts`, `agent/src/preload/index.ts` | only if the renderer needs to call it |
| 9 | `agent/tests/` | a test file; barrel tests already exist and will need updating |
| 10 | `README.md` / `KLENNY.md` | if user-visible behavior or architecture changed |

---

## 1. Register the name

`ToolName` in `agent/shared/types.ts` is the single source of truth. Below it sit the family
arrays that drive gating and behavior — decide membership deliberately for each:

- `CODING_ONLY_TOOLS` — needs a real project workspace; excluded from Assistant tabs. Currently
  `run_command`, `read_terminal`, `codebase_search`, `parallel_write`.
- `ASSISTANT_TOOLS` — the *entire* allow-set for Assistant tabs (file tools included, scoped to
  `documentsDirectory`). If a tool should work there, it must be listed here explicitly.
- `MUTATING_TOOLS` — used by reasoning-effort scoring, not by the approval gate.
- `ALWAYS_BLOCKED_TOOLS` — hard-blocked pending human approval regardless of approval mode, and
  refused outright inside subagents (the Pawprint tools).
- `BROWSER_TOOLS`, `DOCX_TOOLS`, `GMAIL_READ_TOOLS`, `GMAIL_SEND_TOOLS`, `DISCORD_TOOLS` — the
  option-dependent families.

`ASSISTANT_TOOLS`' doc comment notes the Assistant system prompt **spells the same names out in
prose**, not generated from the array — keep both in sync by hand.

## 2. Implement it

Put it in the module that fits (`file-ops.ts`, `search.ts`, `web.ts`, `shell.ts`, `browser.ts`,
`image.ts`, …) or a new one. Always return `ToolResultPayload`:

```typescript
| { ok: true;  summary: string; data?: Record<string, unknown> }
| { ok: false; summary: string; error: string; data?: Record<string, unknown> }
```

`summary` is user-visible; `error` is a machine-readable code; `data` is what the model reads.

### Paths and the mutation sandbox

```typescript
const abs = resolveWorkspacePath(args.path, root)          // tools/file-ops.ts
if (!assertMutationAllowed(abs, root)) {                    // main/workspace.ts
  return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
}
```

**`assertMutationAllowed` RETURNS false — it does not throw.** A bare call inside a `try` block is
a silent sandbox escape (this actually shipped in `parallel_write`'s Phase 1). Only
`resolveWorkspacePath` throws, and only for a structurally invalid path; it does no `..` stripping,
so the boolean branch is the only thing between a relative path and an escape.

Allowed mutation roots: the open workspace, the Assistant `documentsDirectory`, and always
`~/.klenny` plus Electron's `userData` (`alwaysAllowedMutationRoots()`).

### Other implementation invariants

- Respect EOL: `detectEol`/`toLf`/`fromLf` (`tools/eol.ts`) — CRLF is the primary dev platform.
- For edits, honor `fileReadCache` staleness (`mtimeMs` mismatch → `error: 'stale'`).
- **A diff is a bounded preview, never raw content.** Use `makeDiff`/`joinDiffs` (`tools/diff.ts`)
  and `readTextForDiff()` rather than `readFile` + diff — an unbounded diff once wrote a 61 MB
  session file and froze the app.
- If the model must *see* an image, the key is exactly `data.dataUrl` (lifted out by `loop.ts`);
  any other key silently becomes truncated base64 garbage.
- Wrap anything that can hang (Playwright, network) in a deadline race, as `browser.ts` does.

## 3. Barrel export

Add it to `agent/src/main/agent/tools/index.ts`. `agent/tests/tools-index-barrel.test.ts` asserts
the barrel re-exports every implementation function — extend it.

## 4. Schema in `definitions.ts`

Append to the `all[]` array inside `getToolDefinitions(mode, restrictTo, codebaseSearchAvailable,
hasWorkspace, isAssistant, gating)`:

```typescript
{
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write or overwrite a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  }
}
```

Schemas are **documentation only** — there is no ajv/zod validation at dispatch. Real enforcement
is in the implementation, and models do send JSON-string-encoded arrays where a native array was
declared, so coerce defensively (see `normalizeFilesArg` in `file-ops.ts` and
`coerce-array-arg.test.ts`).

The description is the model's only instruction manual for the tool; spend words on routing rules
and failure modes, not just a label.

### ⛔ The gating rule you must not break

`getToolDefinitions()`'s return value **is** the request's `tools` array, and providers serialize
it *ahead* of the system prompt. A cached block is keyed on its entire preceding prefix, so a
`tools` array that changes mid-conversation invalidates **every** cache breakpoint, including the
fixed system one.

**Never add a gate driven by per-turn conversation state.** This was a real, measured bug:
`update_checklist` used to be hidden until `TabSession.activeChecklist` existed, so the first
`create_checklist` call grew the array and re-wrote the whole prefix at full price
(`cachedTokens=0`, `cacheWriteTokens=53456`) while the system message's own fingerprint was
byte-identical. Every legitimate gate derives from settings, tab kind or subagent type — all fixed
for a conversation's life. Prefer always offering the tool and returning a clean error
(`no_active_checklist`) over hiding it.

Gates at the end of the function, all filter-style, all legitimate: `hasWorkspace`,
`codebaseSearchAvailable`, `gating.imageGenerationAvailable`, docx/Gmail/Discord connection +
`automationPermissions` + `*AvailableInCoding`, and `gating.browserAutomationAvailable`. Add new
optional fields to `ToolGatingOptions`, which defaults every field **closed** so a caller that
forgets one never over-shares.

`agent/tests/tools-cache-stability.test.ts` pins this; it has positive controls, so don't "fix" a
failure by blinding it.

## 5. Dispatch and approval in `loop.ts`

`dispatchTool()` is a plain `switch (name)` ending in `default: { ok: false, error: 'unknown_tool' }`:

```typescript
case 'edit_file':
  return editFileTool(args as { path: string; old_string: string; new_string: string; replace_all?: boolean }, fileRoot)
```

`fileRoot` is the sandbox root (Assistant `documentsDirectory`, else `undefined` = open workspace).
Extra capabilities arrive as injected dispatch objects (`imageGen`, `parallelWrite`, `toolCallId`)
rather than globals — follow that pattern instead of reaching for module state.

`executeTool()` runs the gates in order before dispatch:

1. **Assistant-tab guard** — `tab.kind === 'assistant' && CODING_ONLY_TOOLS.includes(name)` is
   refused server-side, because `getWorkspace()` is a process-global singleton and a hallucinated
   or stale call would otherwise execute against whatever project another window has open. The
   client-side allow-list is not sufficient on its own.
2. **`ALWAYS_BLOCKED_TOOLS`** — always prompts; refused with `unsupported_in_subagent` in a subagent.
3. **The standard mutating list** — `['write_file', 'edit_file', 'multi_edit', 'multi_write',
   'delete_file', 'write_docx', 'edit_docx', 'generate_image', 'run_command']`:

```typescript
const needsApproval = approvalMode === 'manual' || (approvalMode === 'command' && name === 'run_command')
if (needsApproval) {
  const preview = await previewMutatingTool(name, args, fileRoot)
  const action = approvalManager.buildPendingFromTool(tab.id, tc.id, name as PendingActionKind, preview.title, preview.extra)
  emit({ type: 'pending_action', tabId: tab.id, action })
  const decision = await approvalManager.waitForDecision(action.id)
  emit({ type: 'pending_action_resolved', tabId: tab.id, actionId: action.id })
  if (decision === 'reject') return { payload: { ok: false, summary: 'User rejected action', error: 'rejected' }, status: 'rejected' }
} else {
  const ws = getWorkspace()
  if (ws) await approvalManager.createCheckpoint(ws)
}
```

Adding a name here also means adding it to `PendingActionKind` (grep it in `agent/shared/types.ts`)
and handling the card in `ApprovalCard.tsx`. Note the `else` branch: skipping approval still takes
a checkpoint — don't drop it.

**A tool whose content doesn't exist yet must not be listed here.** `parallel_write` is
deliberately absent and instead requests approval from *inside* the tool, once per job, via an
injected `approve()` callback; listing it would queue a second, contentless card. `browser` has its
own independent policy gate (`'off' | 'ask' | 'auto'`) keyed on whether the action is mutating.

**Subagent exclusion is a runtime check, not an allow-list one.** A subagent type may declare
`tools: 'all'`, so allow-lists alone leak; `parallel_write` checks `unattended` inside its dispatch
case. Subagent runs also force `approvalMode: 'auto'`, so anything needing a human must refuse
outright there.

## 6. Approval preview

`previewMutatingTool(name, args, root)` returns `{ title, extra }`:

```typescript
if (name === 'write_file') {
  const { content: oldContent } = await readTextForDiff(resolveWorkspacePath(path, root))
  return { title: `Write ${path}`, extra: { filePath: path, diff: makeDiff(oldContent, String(args.content), path) } }
}
```

This path ships over IPC to the renderer, so it needs the same bounded-diff discipline as the tool
itself — it once had the identical unbounded-diff bug. Never let a preview throw; degrade to
`{ title, extra: { filePath } }` with no diff.

## 7. Ledger (only if the tool creates files)

The fabrication guard's C3 check flags a claimed-created file that no write targeted. Add the name
to `WRITE_TOOLS` in `orchestrator/ledger.ts` and teach `collectPathsFromArgs` your argument shape
(including alias keys and map forms, as `multi_write` needs) — otherwise a file genuinely written
by your tool gets hard-flagged as fabricated.

## 8. IPC (only if the renderer calls it)

Four coordinated edits, all in `agent/shared/ipc.ts` + `agent/src/main/ipc.ts` +
`agent/src/preload/index.ts`:

1. A channel constant in `IPC`, named `namespace:action` (`'memory:write'`, `'chat:sendMessage'`).
2. A method on the `KlennyApi` interface.
3. `ipcMain.handle(IPC.x, …)` in main.
4. `ipcRenderer.invoke(IPC.x, …)` in the preload bridge (or an `on`-listener returning an
   unsubscribe function, for streaming events).

## 9. Tests

`bun test` (Bun, not npm/yarn). Existing suites you will likely need to update: `tools.test.ts`,
`tools-index-barrel.test.ts`, `tools-cache-stability.test.ts`, `global-mutation-sandbox.test.ts`,
`ledger.test.ts`, and `diff-safety.test.ts` if the tool produces diffs. Cover at minimum: the happy
path, an out-of-sandbox path (asserting nothing was written), and a malformed-arguments shape.

## Checklist

1. `ToolName` + family arrays in `agent/shared/types.ts`
2. Implementation returning `ToolResultPayload`, with the `assertMutationAllowed` **return-value**
   branch if it mutates
3. Barrel export in `tools/index.ts`
4. Schema in `getToolDefinitions()`'s `all[]` — no per-turn-state gate
5. `dispatchTool()` case; approval entry + `PendingActionKind` if mutating; runtime `unattended`
   refusal if it needs a human
6. `previewMutatingTool()` branch with a bounded diff
7. `WRITE_TOOLS` + `collectPathsFromArgs` if it creates files
8. IPC channel / handler / preload / `KlennyApi` if the UI needs it
9. Tests in `agent/tests/`
10. `README.md` and `KLENNY.md` if documented behavior changed
