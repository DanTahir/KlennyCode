# Klenny Code

Klenny Code is a desktop coding agent for Windows, macOS, and Linux, built with
**Electron + React + TypeScript** and developed with **Bun**. It connects to
[OpenRouter](https://openrouter.ai) so users can drive the agent with Claude, GPT, Gemini,
and hundreds of other models via a single API key.

## Repo layout

- `agent/` — the actual application (everything lives here; the repo root is mostly docs/assets)
  - `src/main/` — Electron main process: agent orchestrator, tools, IPC handlers, settings,
    session/plan/memory/skills/subagent managers, code index, workspace/data-dir helpers
  - `src/main/agent/orchestrator.ts` — the core agent loop: builds the system prompt, streams
    model responses via OpenRouter, dispatches tool calls, handles approvals/checkpoints/compaction
  - `src/main/agent/tools/` — tool definitions + implementations (read/write/edit/delete file,
    grep, glob, run_command, web_search, fetch_url, ask_question, subagent dispatch, memory tools)
  - `src/main/agent/memory/manager.ts` — project/global `KLENNY.md` + auto-memory notes
  - `src/main/agent/plan/manager.ts` — Plan mode system prompt, plan artifacts, corgi persona text
  - `src/main/agent/skills/`, `src/main/agent/subagents/` — Cursor-style `SKILL.md` skills and
    built-in/custom subagent types
  - `src/main/agent/codeindex/` — optional semantic codebase search (embeddings + vectra store)
  - `src/preload/` — typed `contextBridge` API exposed to the renderer
  - `src/renderer/` — React UI (chat tabs, settings, memory/skills/history panels, terminal)
  - `shared/` — shared TypeScript types + IPC channel name constants
  - `tests/` — Bun test suite (`bun test` from `agent/`)
- `README.md` — user-facing overview, setup, and architecture docs (keep in sync with reality)

## Conventions

- Package manager is **Bun** (`bun install`, `bun run dev`, `bun test`) — not npm/yarn, though
  `npm run build`/`electron-builder` are used for packaging scripts in `package.json`.
- File edits in this codebase must go through `read_file` + `edit_file`/`write_file` — never
  `sed`/`echo`/`node -e` via shell, since that breaks on Windows (primary dev platform).
- Auto-memory notes, plan artifacts, and the codebase index are stored **outside** the project
  tree (Electron `userData` dir, keyed per-project) specifically so nothing needs `.gitignore`
  entries. Only `KLENNY.md`, `KLENNY.local.md`, and `.klenny/skills|agents` at the project root
  are meant to live inside the repo.
- The corgi persona (playful asides in chat responses) lives in `plan/manager.ts` as
  `CORGI_PERSONA_PROMPT` — it must never leak into code, commit messages, or plan documents.
- When changing agent behavior (tools, prompts, memory, orchestrator flow), check
  `agent/tests/` for coverage and update `README.md` if the change affects documented behavior.

## Useful entry points when investigating a bug or feature

- System prompt assembly: `orchestrator.ts` → `buildSystemPrompt()`
- Turn loop / tool dispatch: `orchestrator.ts` → `runTurn`-style functions
- IPC surface (main ↔ renderer): `src/main/ipc.ts` and `shared/ipcChannels.ts` (channel names)
- Settings persistence: `src/main/settings.ts` (or equivalent) and `Settings` panel in renderer
