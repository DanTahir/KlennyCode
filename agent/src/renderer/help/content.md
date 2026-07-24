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
Read-only tools only. Klenny Code will ask clarifying questions, research your codebase, and save a plan artifact (stored outside your project, in Klenny Code's app data directory — nothing to gitignore). Review it in the **Plans** panel, then approve to switch back to Agent mode.

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
| `list_projects` / `read_other_project_file` / `grep_other_project` / `glob_other_project` / `read_other_project_memory` | Read-only access to *other* projects you've previously opened |
| `gmail_list_messages` / `gmail_get_message` / `gmail_send_message` | Read (and, if enabled, send) email via your connected Gmail account |
| `discord_post_message` | Post to a Discord channel or DM via your connected bot |
| `scheduler_create_task` / `scheduler_update_task` / `scheduler_delete_task` | Manage recurring background tasks |
| `open_settings_panel` | Jump you to a relevant Settings section (e.g. to connect an integration) |

## Approval workflow

- **Manual review** (default): every edit, delete, and command shows a diff or preview — accept or reject before it runs.
- **Auto-apply**: changes apply immediately, with shadow-git checkpoints for revert.

Toggle this in **Settings**.

## Memory

- **Project**: `KLENNY.md` in your project root (shared via git).
- **Global**: `~/.klenny/KLENNY.md` (personal, all projects).
- **Auto-memory**: Klenny Code can write topic files (stored outside your project, in Klenny Code's app data directory) and index them in `MEMORY.md`.

## Cross-project reference (read-only)

Klenny Code keeps track of every project you've previously opened. While working in your current project, the agent can read files and memory notes from those *other* projects — e.g. "port the shell-selection feature from my other project into this one" — using a small set of read-only tools. It can never write or edit anything outside the project you currently have open.

## Personal Assistant

Beyond coding projects, Klenny Code can act as a lightweight personal assistant:

- **Assistant tab** — click **Open Assistant** in the sidebar to open a fresh chat tab with web search, cross-project reference, memory, Gmail, Discord, and scheduler tools, but no file/shell access (no coding project needed). Every click makes a brand-new tab; closing one discards it for good — Assistant tabs don't persist or show up in History.
- **Gmail** — connect your own Google Cloud OAuth client in **Settings → Integrations** to let the agent read, and (once you opt in) send, email.
- **Discord** — connect a bot application (never a personal account) so the agent can post updates and respond to DMs/mentions/`!klenny` commands, including reviewing a known project read-only when asked.
- **Scheduler** — define recurring tasks ("every morning at 8am, summarize my inbox") that run unattended as background subagents, even while minimized to the system tray. Enable **Minimize to tray** / **Start on login** in Settings to keep the scheduler and Discord bot running. When a run finishes, its answer is delivered as a chat message in the tab that created it (reopened from History if needed, or a brand-new tab if that's gone too), plus a desktop notification if no window is focused.
- **Automation Permissions** (Settings → Integrations) — per-action allow/block toggles (Gmail read/send, Discord read/post, scheduler on/off) governing what the agent may do unattended. There's no live "ask me" prompt for background actions — set the toggle you're comfortable with ahead of time.

Coding tools (file read/write, shell commands, codebase search) stay scoped to an actual open project — the Assistant tab and its tools are additive, available everywhere, not a replacement.

## History

Closing a chat tab that has messages archives it instead of deleting it. Open the **History** panel from the sidebar to reopen or permanently delete archived chats. (Assistant tabs are the exception — they're ephemeral and never archived.)

## Cost Report

Click **Cost Report** at the bottom of the Models section in Settings to see cumulative token usage and USD cost broken down by model, both for the current project and across every project you've used Klenny Code on. There's a reset button if you want to zero the counters.

## Skills

Create skills under `.klenny/skills/<name>/SKILL.md` (project) or `~/.klenny/skills/` (global). Klenny Code sees a lightweight catalog and loads full instructions when relevant — you don't need to invoke them manually.

## Subagents

Built-in types: `general-purpose`, `explore`, `plan-checker`. Define custom subagents in `.klenny/agents/*.md`. Pick a separate subagent model in Settings to save cost on exploration tasks.

## Codebase semantic search (beta)

Optional, off by default. When enabled in Settings, Klenny Code builds a local semantic index of your
workspace — split into chunks, embedded, and stored in a small vector database outside your project, in
Klenny Code's app data directory — and keeps it live-updated as you edit files. This lets the agent find relevant code by *meaning* ("where do we
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

## Terminal

A collapsible terminal is docked under the chat view — click the "Terminal" bar at the bottom (or press
`` Ctrl+` ``) to expand it. It runs a real interactive shell session using whichever shell you've selected
in Settings → Shell (or the OS default if left on Auto), rooted at your open project folder. The session
stays alive while you collapse/expand the panel, and only restarts if you switch workspaces, click
"Restart", or close the app.

Pick which shell to use — Git Bash, PowerShell, cmd, WSL, or your OS default — under **Settings → Shell**.
This same setting also controls the shell `run_command` uses.

## Spending cap

Set a per-session or daily USD cap in Settings. Klenny Code warns as you approach it and blocks further model calls when exceeded.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `` Ctrl+` `` | Toggle terminal |
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

## macOS: "app is damaged and can't be opened"

Klenny Code isn't signed with a paid Apple Developer certificate, so macOS Gatekeeper blocks the downloaded
`.dmg`/`.app` and reports it as damaged — it isn't actually corrupted, Gatekeeper is just refusing to run an
unsigned app. Fix it from Terminal by clearing the quarantine flag (the app bundle is `KlennyCode.app` — no
space — even though it displays as "Klenny Code"):

```bash
xattr -cr /Applications/KlennyCode.app
```

Then launch it normally. If you haven't moved it to `/Applications` yet, you can run the same command on the
downloaded `.dmg` instead (e.g. `xattr -cr ~/Downloads/KlennyCode.dmg`), then mount and install as usual.
