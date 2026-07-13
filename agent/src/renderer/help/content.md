# Klenny Code Help

Klenny Code is a desktop coding agent that uses OpenRouter to access frontier models (Claude, GPT, Gemini, and more).

## Getting started

1. Open **Settings** and paste your [OpenRouter API key](https://openrouter.ai/keys).
2. Click **Open folder** in the sidebar to choose a project directory.
3. Start chatting in **Agent mode**, or switch to **Plan mode** to research and produce a plan before edits.

## Modes

### Agent mode
Full tool access: read/write/edit/delete files, grep, glob, run shell commands, web search, subagents, and memory.

### Plan mode
Read-only tools only. Klenny Code will ask clarifying questions, research your codebase, and save a plan to `.klenny/plans/`. Review it in the **Plans** panel, then approve to switch back to Agent mode.

## Tools

| Tool | What it does |
|------|--------------|
| `read_file` | Read file contents (supports offset/limit) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace a unique string in a file |
| `delete_file` | Delete a file |
| `grep` | Regex search via ripgrep |
| `glob` | Find files by pattern |
| `run_command` | Run shell commands (with approval) |
| `web_search` / `fetch_url` | Look up docs and references |
| `ask_question` | Ask you structured multiple-choice questions |
| `task` | Spawn an isolated subagent |
| `read_skill` | Load a Cursor-style skill |
| `read_memory` | Load the full content of an auto-memory topic note |
| `write_memory` | Persist notes for future sessions |
| `codebase_search` | Semantic search across the codebase (only available if enabled in Settings) |

## Approval workflow

- **Manual review** (default): every edit, delete, and command shows a diff or preview — accept or reject before it runs.
- **Auto-apply**: changes apply immediately, with shadow-git checkpoints for revert.

Toggle this in **Settings**.

## Memory

- **Project**: `KLENNY.md` in your project root (shared via git).
- **Global**: `~/.klenny/KLENNY.md` (personal, all projects).
- **Auto-memory**: Klenny Code can write topic files under `.klenny/memory/` and index them in `MEMORY.md`.

## Skills

Create skills under `.klenny/skills/<name>/SKILL.md` (project) or `~/.klenny/skills/` (global). Klenny Code sees a lightweight catalog and loads full instructions when relevant — you don't need to invoke them manually.

## Subagents

Built-in types: `general-purpose`, `explore`, `plan-checker`. Define custom subagents in `.klenny/agents/*.md`. Pick a separate subagent model in Settings to save cost on exploration tasks.

## Codebase semantic search (beta)

Optional, off by default. When enabled in Settings, Klenny Code builds a local semantic index of your
workspace — split into chunks, embedded, and stored in a small vector database under `.klenny/index/` — and
keeps it live-updated as you edit files. This lets the agent find relevant code by *meaning* ("where do we
handle X") rather than exact keyword matches, complementing `grep`/`glob` rather than replacing them.

- **Embeddings** use your existing OpenRouter key and credits — no separate signup. Pick any embeddings-capable
  model OpenRouter offers; a code-tuned default is pre-selected for you.
- **Storage** defaults to a local, file-based index (no cloud account needed). You can switch to Pinecone in
  Settings if you'd rather store vectors in the cloud — that needs its own Pinecone API key and index name.
- **Cost**: unlike memory/grep/glob, this spends a small amount of OpenRouter credit per file indexed and per
  search — rolled into your existing spending cap if you've set one.
- Switching embeddings models triggers a full rebuild (old vectors aren't compatible with a new model's vector
  space). "Rebuild index" and "Delete index" are available in Settings if you need to reset things manually.

## Tabs

Use **+** or `Ctrl+T` for a new chat tab. `Ctrl+W` closes the active tab. Closing the last tab opens a fresh one.

## Spending cap

Set a per-session or daily USD cap in Settings. Klenny Code warns as you approach it and blocks further model calls when exceeded.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Enter` | Send message |
| `Shift+Enter` | New line |

## Updates

The **Windows installer build** (`Klenny-Code-Setup-*.exe`) checks GitHub Releases for updates automatically on
launch and every few hours, downloads new versions in the background, and shows a **Restart to update** button in
the sidebar once ready. The same applies to the macOS and Linux builds.

The **Windows portable build** (`Klenny-Code-*.exe`, no installer) cannot auto-update — this is a limitation of the
underlying packaging tool, not something Klenny Code can work around. Download the latest portable exe manually
from [GitHub Releases](https://github.com/DanTahir/KlennyCode/releases/latest) instead, or switch to the installer
build to get automatic updates.
