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
| `write_memory` | Persist notes for future sessions |

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

Packaged builds check GitHub Releases for updates automatically via `electron-updater`.
