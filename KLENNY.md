# Klenny Code

Klenny Code is a desktop coding agent for Windows, macOS, and Linux, built with
**Electron + React + TypeScript** and developed with **Bun**. It connects to
[OpenRouter](https://openrouter.ai) so users can drive the agent with Claude, GPT, Gemini,
and hundreds of other models via a single API key. Beyond project coding chats, it doubles as a
personal-assistant platform (Gmail, Discord, scheduled background tasks, Assistant tabs) with a
user-editable personality (`SOUL.md`) layered under hardcoded rigor guardrails.

## Repo layout

- `agent/` — the actual application (everything lives here; the repo root is mostly docs/assets)
  - `src/main/` — Electron main process: agent orchestrator, tools, IPC handlers, settings,
    session/plan/memory/skills/subagent managers, code index, workspace/data-dir helpers
  - `src/main/agent/orchestrator/` — the core agent loop, split into focused files (mirrors the
    `tools/index.ts` split): `system-prompt.ts` (`buildSystemPrompt()`), `loop.ts` (turn loop +
    `dispatchTool()`), `state.ts` (per-tab bookkeeping/types), `turn-lifecycle.ts` (checkpoints,
    compaction hooks, streaming), `approval-previews.ts`, `scheduled-and-discord.ts`
  - `src/main/agent/tools/` — tool definitions (`definitions.ts`) + implementations: file ops
    (`file-ops.ts`, `edit-match.ts`, `diff.ts`, `eol.ts`), `search.ts` (grep/glob),
    `shell.ts`/`terminal.ts` (run_command + PTY terminal), `web.ts` (web_search/fetch_url),
    `browser.ts` (Playwright automation), `image.ts` (read_image), `otherProjects.ts`
    (cross-project reference), plus docx tools, memory tools, subagent dispatch, ask_question
  - `src/main/agent/compaction/compactor.ts` — context-window compaction (summarize-and-fold)
  - `src/main/agent/memory/manager.ts` — project/global `KLENNY.md` + auto-memory notes;
    `assistantMemory.ts` — shared, auto-compacting memory pool for Assistant tabs
  - `src/main/agent/soul/manager.ts` — `SOUL.md` (user-editable agent personality) read/write/reset
  - `src/main/agent/plan/manager.ts` — Plan/agent mode system prompt builders + hardcoded
    personality guardrails (`PERSONA_GUARDRAILS_PROMPT`) and the truthful-narration guardrail
  - `src/main/agent/skills/`, `src/main/agent/subagents/` — Cursor-style `SKILL.md` skills and
    built-in/custom subagent types (agent can author both itself via `write_skill`/`write_subagent`)
  - `src/main/agent/codeindex/` — optional semantic codebase search (embeddings + vectra/Pinecone)
  - `src/main/workspace.ts` — global workspace singleton (`getWorkspace()`/`setWorkspace()`)
  - `src/main/shells.ts` — per-platform shell detection for run_command/terminal (shell picker)
  - `src/main/terminalLog.ts` — persistent, size-capped, ANSI-stripped per-workspace terminal log
  - `src/main/scheduler/` — cron-based background task runner (Gmail/Discord/general subagent jobs)
  - `src/preload/` — typed `contextBridge` API exposed to the renderer
  - `src/renderer/` — React UI (chat tabs, settings, memory/skills/history panels, terminal)
  - `shared/` — shared TypeScript types + IPC channel name constants
  - `tests/` — Bun test suite (`bun test` from `agent/`)
- `README.md` — user-facing overview, setup, and architecture docs (keep in sync with reality)

## Major features (beyond core chat-with-tools)

- **Assistant tabs** (`kind: 'assistant'`): ephemeral, workspace-independent chats for
  Gmail/Discord/scheduling and general Q&A, separate from project coding tabs. They get file
  tools scoped to a user-configurable Documents directory (not the workspace) plus docx/image
  tools, but coding-only tools (run_command, code index, etc.) are gated off both client-side
  and server-side (`dispatchTool` defense-in-depth) unless explicitly enabled in Settings.
- **Personal Assistant Platform**: Gmail (read/send), Discord (post, respond to @-mentions/
  `!klenny`), and a cron-based **Scheduler** (`scheduler_create_task` et al.) for one-time or
  recurring background jobs, with results delivered back to the creator tab.
- **Assistant shared memory pool**: cross-window, auto-compacting memory shared by all Assistant
  tabs (newest-first slots, ~40% kept / 60% folded into summary on threshold), readable via
  `read_memory('assistant')` and a dedicated viewer UI.
- **Cross-project read-only reference**: `read_file`/`grep`/`glob`/memory tools accept absolute
  paths or a `project` param to inspect *other* known projects without ever writing to them.
- **Integrated terminal**: interactive node-pty terminal panel, one PTY per workspace, with a
  persistent plain-text log the agent can read via `read_terminal`, and a selectable shell
  (cmd/PowerShell/bash/zsh/WSL/Git Bash) shared with `run_command`.
- **Batch file editing**: `multi_edit` bundles multiple edit_file-style replacements (optionally
  across files) into a single all-or-nothing, single-approval operation.
- **Codebase semantic search** (`codebase_search`): optional, off-by-default vector index over
  the workspace (embeddings + local Vectra or Pinecone), incremental via a manifest.
- **Skill/subagent authoring**: the agent can write and read its own Cursor-style `SKILL.md`
  skills and custom subagent types (`write_skill`/`read_skill`, `write_subagent`/`read_subagent`).
- **Checkpoint-based long tasks**: configurable auto-pause every N steps (`turnCheckpointSteps`)
  with a one-click Continue, preventing runaway turns while avoiding premature stopping.
- **Generalized live-progress checklists** (`create_checklist`/`update_checklist`): not just for
  approved plans — the agent can proactively start a live checklist for any multi-step task via
  `create_checklist` (refuses to clobber an existing one unless `replace: true`), sharing the same
  underlying `buildChecklist()` helper (`orchestrator/checklist.ts`) and widget/reinjection
  machinery as plan checklists. `update_checklist` accepts an optional per-item `evidence` string
  (~300 chars, truncated at write time) describing what was actually verified; this is a **soft,
  self-reported mitigation only** (friction + a human-inspectable trail, not a structural proof —
  nothing checks the evidence text against reality) rendered in both `ChecklistWidget.tsx` and the
  fresh-every-turn reinjection note. A `CHECKLIST_HONESTY_NOTE` guardrail (`plan/manager.ts`)
  instructs the model to only mark items done after in-turn verification and to prefer supplying
  evidence; a post-compaction skepticism sentence (`buildCurrentTimeNote()`'s `justCompacted` arg)
  additionally flags pre-existing done items as unverified right after a compaction pass, since
  they weren't re-checked this turn.
- **Word .docx support**: `read_docx`/`write_docx`/`edit_docx` for structured document edits.
- **Image viewing**: `read_image` for viewing arbitrary png/jpg/gif/webp files inline.
- **SOUL.md personality**: user-editable personality (default: playful corgi) layered under
  hardcoded, non-editable rigor guardrails — see Conventions below.
- **History, Cost Report, per-tab approval modes, auto-update**: closed tabs (both project 💻 and
  Assistant 🐾) are archived and reopenable; a Cost Report tracks spend by model over time; each
  tab can override the global approval mode (manual/command/auto); auto-update works on Windows
  (NSIS) and Linux (AppImage) — **Mac is unsigned/broken** and **.deb has no update mechanism**.

## Conventions

- Package manager is **Bun** (`bun install`, `bun run dev`, `bun test`) — not npm/yarn, though
  `npm run build`/`electron-builder` are used for packaging scripts in `package.json`.
- File edits in this codebase must go through `read_file` + `edit_file`/`write_file` — never
  `sed -i`/`echo > file`/`node -e` via shell, since that breaks on Windows (primary dev platform).
  `run_command` enforces this via `fileEditGuardReason` (`tools/shell.ts`), which judges each shell
  statement separately: only *authored* content (echo/printf/heredoc) aimed at a real file counts.
  Diagnostic `echo`, `2>/dev/null`, `2>&1`, and `cmd | tee build.log` are deliberately allowed.
- Auto-memory notes, plan artifacts, and the codebase index are stored **outside** the project
  tree (Electron `userData` dir, keyed per-project) specifically so nothing needs `.gitignore`
  entries. Only `KLENNY.md`, `KLENNY.local.md`, and `.klenny/skills|agents` at the project root
  are meant to live inside the repo.
- The agent's personality is user-editable via `SOUL.md` (`~/.klenny/SOUL.md`, edited from the
  Memory tab's "Personality" scope; see `agent/src/main/agent/soul/manager.ts`), defaulting to a
  playful corgi persona. The hardcoded, non-editable guardrails that keep personality from ever
  overriding coding rigor live in `plan/manager.ts` as `PERSONA_GUARDRAILS_PROMPT` — personality
  (from SOUL.md or otherwise) must never leak into internal reasoning, code, commit messages, or
  plan documents. A related **truthful-narration guardrail** (same file) forbids describing a
  tool call/file mutation as done in prose unless it actually ran — this is the load-bearing fix
  for compaction-summary poisoning (see gotchas below), not just a style rule.
- When changing agent behavior (tools, prompts, memory, orchestrator flow), check
  `agent/tests/` for coverage and update `README.md` if the change affects documented behavior.

## Useful entry points when investigating a bug or feature

- System prompt assembly: `orchestrator/system-prompt.ts` → `buildSystemPrompt()` — runs per
  turn; dynamic/per-turn content (current time, Assistant memory digest) must live in the
  always-uncached trailing system message, never in the cached prefix (see caching gotcha below).
- Turn loop / tool dispatch: `orchestrator/loop.ts` → the turn loop and `dispatchTool()`
  (per-tool switch; checks per-tab approval mode; Assistant-tab coding-tool gate lives here too).
- Per-tab state: `orchestrator/state.ts` — `abortControllers`, `activeRuns`, `endedTurns`,
  `pendingQuestions`, `lastCacheBreakpointIdx`, etc.; all cleaned up on tab close via
  `clearTabState()` (memory-leak fix — check this when adding new per-tab bookkeeping).
- Context compaction: `compaction/compactor.ts` — `KEEP_RECENT = 12` messages are never folded;
  summarization uses the separate utility model; result is cached in `tab.compactionSummary` and
  re-injected every later turn without re-verification (full history is preserved for the UI,
  never mutated in place). `transcriptLineForMessage()` sanitizes any fabricated `"[called ...]"`
  marker text found in free-text/thinking blocks before it reaches the summarizer (see poisoning
  gotcha below).
- Message wiring: `agent/messages.ts` → `toORMessages()` — flattens `ChatMessage[]` to OpenRouter
  wire format, batches tool-result images into one trailing synthetic user message.
- Live checklists: `orchestrator/checklist.ts` → `buildChecklist()` (shared by `approvePlan()` in
  turn-lifecycle.ts and the `create_checklist` dispatch case in loop.ts); rendering/reinjection in
  `orchestrator/system-prompt.ts` → `buildCurrentTimeNote()`; UI in `ChecklistWidget.tsx`.
- IPC surface (main ↔ renderer): `src/main/ipc.ts` and `shared/ipcChannels.ts` (channel names)
- Settings persistence: `src/main/settings.ts` and the `Settings` panel in renderer (category
  sidebar with 8 sections + scrollspy/deep-linking).

## Non-obvious gotchas worth knowing before touching these areas

- **Prompt caching needs an explicit re-mark, not just system + last message**: the *previous*
  turn's last-message cache breakpoint must be explicitly re-marked in the *current* wire
  payload, or Anthropic's lookback misses it when routed through OpenRouter. Verify with `[cache]`
  debug logs (breakpointsAt vs. cachedTokens trend) — implicit behavior is unreliable here.
- **Compaction-summary poisoning — fixed, three layers deep (now also covering tool-call
  args/results, not just free-text)**: if the model narrates a tool call as done without actually
  calling it, that fabrication could get folded into `compactionSummary` and trusted forever after
  (replayed verbatim on every later turn). Fixed at three levels: (1) upstream prevention — the
  `TRUTHFUL_NARRATION_NOTE` guardrail (`plan/manager.ts`) tells the model never to narrate an
  action as done without a real tool call; (2) downstream mitigation — `summarizeMessages()`'s
  prompt (`openrouter/client.ts`) tells the summarizer to trust only literal
  `"[called toolName(...)]"` markers, never prose that merely claims something happened; (3)
  structural enforcement — `transcriptLineForMessage()` (`compaction/compactor.ts`) runs
  `sanitizeFabricatedMarkers()` over free-text/thinking content, and **also over the
  JSON-stringified tool-call `args` and tool-result `result` payloads** (a fetched page, a file's
  own contents, or an `old_string`/`new_string` argument can just as easily contain the literal
  `"[called "` substring), rewriting any match as prose into `"[not-a-real-call: "` so a
  fabricated marker can never be visually indistinguishable from a real, structurally-generated
  one even if layer (1) fails — only the surrounding `[called toolName(...)]` wrapper syntax
  itself is left untouched, since that's the one reliable, unforgeable signal. Covered by
  `compaction.test.ts` ("sanitizes fabricated ... markers", including the args/result-specific
  regression test). A user-facing manual reset button to force re-summarization from scratch is
  still open follow-up work (not yet built) — belt-and-suspenders recovery UX, not required for
  the poisoning fix itself.
- **Checklist `evidence` is a soft mitigation, not a hard guarantee**: nothing structurally
  verifies an `update_checklist` call's `evidence` string actually reflects real work — it's
  self-reported, and its value is entirely the friction of having to articulate a concrete
  justification plus the human-inspectable trail it leaves, not a verification mechanism. Don't
  build anything downstream that treats a present `evidence` string as proof; treat it the same
  way you'd treat any other unverified model claim.
- **Fuzzy edit matching** (`edit-match.ts`): handles CRLF, escaped chars, em-dash/hyphen variants
  — but line-number prefixes from `read_file` output are NOT in real file bytes, never include
  them in `old_string`.
- **node-pty packaging**: set `npmRebuild: false` + `asarUnpack: ['**/node-pty/**']` in
  electron-builder config; a normal postinstall rebuild fails hard without VS Build Tools even
  when working prebuilt binaries already exist.
- **Global workspace singleton**: `getWorkspace()`/`setWorkspace()` is one process-wide value,
  not per-tab — a scheduled task targeting a different workspace can transiently affect a live
  tab's workspace-scoped tool resolution if timings collide (accepted limitation, not yet fixed).
- **Tool JSON schemas are documentation only**: there's no ajv/zod validation at dispatch time;
  real enforcement lives in each tool's implementation, and models sometimes send JSON-string-
  encoded nested arrays instead of native arrays — handle that explicitly.
- **Memory/skill/subagent names auto-sanitize illegal filename chars** (`/\:*?"<>|`, control
  chars, leading dots) rather than rejecting — the tool result tells the model the sanitized name
  so it doesn't retry the same invalid one.

## Known open follow-ups (not yet implemented)

- Compaction-summary manual reset (UX + IPC) — a user-facing "reset conversation summary" button
  to recover if a summary ever ends up wrong for some other reason; not required for the
  poisoning fix itself (that's now fixed, see gotchas above), just recovery UX.
- Mac auto-update (needs code-signing/notarization in CI); Linux `.deb` has no update path by
  design (AppImage is fine).
- Per-tab workspace tracking (currently a single global workspace singleton — see gotcha above).
- MCP-style tool integration scaling — researched (OpenClaw/OpenCode patterns) but not built.
- GitHub integration (`gh` CLI connect/browse/clone) — plan drafted, not started.
