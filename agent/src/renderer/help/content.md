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
| `read_file` | Read file contents (supports offset/limit) — global: any absolute path on the host, not just the open project |
| `write_file` | Create or overwrite a file (sandboxed to the current project) |
| `edit_file` | Replace a unique string in a file (sandboxed to the current project) |
| `delete_file` | Delete a file (sandboxed to the current project) |
| `read_docx` | Read a Word .docx file into structured JSON (paragraphs, formatted runs, tables, headers/footers, comments, tracked changes) — global, same as `read_file` |
| `write_docx` | Generate a brand-new .docx from a structured spec (sandboxed to the current project) |
| `edit_docx` | Apply surgical edits to an existing .docx by patching its XML directly, preserving everything untouched byte-for-byte (sandboxed to the current project) |
| `read_image` | Read an image file (png/jpg/gif/webp) and see it, exactly like a pasted/attached image — global, same as `read_file` |
| `grep` | Regex search via ripgrep — global, same as `read_file` |
| `glob` | Find files by pattern — global, same as `read_file` |
| `run_command` | Run shell commands (with approval) |
| `read_terminal` | Read the persistent log of the Terminal panel below, including past sessions |
| `web_search` / `fetch_url` | Look up docs and references |
| `ask_question` | Ask you structured multiple-choice questions |
| `task` | Spawn an isolated subagent |
| `read_skill` / `write_skill` | Load or author a Cursor-style skill |
| `read_subagent` / `write_subagent` | Inspect or author a custom subagent type |
| `read_memory` | Load the full content of an auto-memory topic note (optional `project` to read a different known project's memory) |
| `write_memory` | Persist notes for future sessions (always the current project or global — never another project) |
| `list_memory` | Overview of a memory scope: KLENNY.md + auto-memory index + topic list (optional `project`) |
| `codebase_search` | Semantic search across the codebase (only available if enabled in Settings) |
| `list_projects` | List other projects you've previously opened, to pass to read_file/grep/glob/read_memory/list_memory |
| `gmail_list_messages` / `gmail_get_message` / `gmail_send_message` | Read (and, if enabled, send) email via your connected Gmail account |
| `discord_post_message` | Post to a Discord channel or DM via your connected bot |
| `scheduler_create_task` / `scheduler_update_task` / `scheduler_delete_task` | Manage recurring background tasks |
| `open_settings_panel` | Jump you to a relevant Settings section (e.g. to connect an integration) |

## Approval workflow

- **Manual review** (default): every edit, delete, and command shows a diff or preview — accept or reject before it runs.
- **Command approve**: file edits and deletes apply immediately (with checkpoints), but shell commands still need approval.
- **Auto-apply**: changes apply immediately, with shadow-git checkpoints for revert.

Set the default in **Settings**. Each chat tab also has its own approval-mode dropdown next to
Send/Stop, which overrides the Settings default just for that tab — handy for letting one tab run
hands-off while another stays under manual review. Clicking **Accept all** on a pending approval
card switches that tab's dropdown to Auto approve automatically; you can change it back to Manual
or Command approve at any time. Assistant tabs show the same dropdown minus **Command approve**,
since that mode's only effect is on shell commands and Assistant tabs have no `run_command` tool.

## Memory

- **Project**: `KLENNY.md` in your project root (shared via git).
- **Global**: `~/.klenny/KLENNY.md` (personal, all projects).
- **Auto-memory**: Klenny Code can write topic files (stored outside your project, in Klenny Code's app data directory) and index them in `MEMORY.md`.
- **Personality**: `~/.klenny/SOUL.md` (personal, all projects) — describes who the agent is and how it expresses itself in chat. Editable from the Memory tab's "Personality" scope; defaults to a playful corgi persona, but you can rewrite or blank it out for a plain, personality-free voice, or click **Restore default personality** to bring back Klenny's built-in default. A separate, hardcoded set of guardrails (not user-editable) always keeps personality from affecting reasoning, plans, or code quality, no matter what SOUL.md says.
- **Assistant window shared memory**: every 🐾 Assistant tab (see Personal Assistant below) shares a single, auto-compacting memory pool so other Assistant windows can see at a glance what each one has been up to. View and manage it from the Memory tab's "Assistant windows (shared memory)" scope; the pool size (or turning it off) is set in **Settings → Models & cost**.

## Cross-project reference (read-only)

Klenny Code keeps track of every project you've previously opened. While working in your current project, the agent can read files and memory notes from those *other* projects — e.g. "port the shell-selection feature from my other project into this one" — using a small set of read-only tools. It can never write or edit anything outside the project you currently have open.

## Personal Assistant

Beyond coding projects, Klenny Code can act as a lightweight personal assistant:

- **Assistant tab** — click **Open Assistant** in the sidebar to open a fresh chat tab with web search, cross-project reference, memory, Gmail, Discord, scheduler tools, and full file tools (read/write/edit/multi_edit/multi_write/delete/grep/glob, plus `read_docx`/`write_docx`/`edit_docx` for Word documents specifically and `read_image` to actually see image files) — but no coding project needed and no shell/`run_command`/codebase-search access. File-tool relative paths and every mutation are sandboxed to a **Documents directory** (Settings → Behavior, default your OS Documents folder) instead of a project workspace; absolute-path reads can still reach anywhere on the machine. Every click makes a brand-new tab; Assistant tabs persist across app restarts, and closing one (once it has messages) archives it to the "🐾 Assistant" section of History instead of discarding it.
- **Shared Assistant memory** — after each Assistant-tab turn, Klenny silently uses the utility model to update a short note for that window; every other Assistant tab's prompt gets a digest of what the others have been doing, so windows naturally stay in sync without you copy-pasting context between them. See "Assistant window shared memory" under Memory above for how to view, size, or disable this.
- **Gmail** — connect your own Google Cloud OAuth client in **Settings → Integrations** to let the agent read, and (once you opt in) send, email.
- **Discord** — connect a bot application (never a personal account) so the agent can post updates and respond to DMs/mentions/`!klenny` commands, including reviewing a known project read-only when asked.
- **Scheduler** — define recurring tasks ("every morning at 8am, summarize my inbox") that run unattended as background subagents, even while minimized to the system tray. **Minimize to tray** is on by default in Settings (and **Start on login** can be enabled there too) to keep the scheduler and Discord bot running. When a run finishes, its answer is delivered as a chat message in the tab that created it (reopened from History if needed, or a brand-new tab if that's gone too). Tasks can also be limited to a set number of firings (**Max runs**) — asking for something "at 8pm" or "in 10 minutes" creates a one-shot task that runs once and deletes itself, while "every 10 minutes, 3 times" runs 3 times then deletes itself; leave Max runs blank for a task that recurs forever.
- **Desktop notifications** — a native OS notification fires whenever no Klenny Code window is focused and a subagent run, a main chat turn, or a scheduled task run finishes.
- **Automation Permissions** (Settings → Integrations) — per-action allow/block toggles (Gmail read/send, Discord read/post, scheduler on/off) governing what the agent may do unattended. There's no live "ask me" prompt for background actions — set the toggle you're comfortable with ahead of time.

Shell commands (`run_command`), the interactive terminal, and codebase semantic search stay scoped to an actual open project — the Assistant tab and its tools are additive, available everywhere, not a replacement for a project tab when you actually need to edit code.

## History

Closing a chat tab that has messages archives it instead of deleting it. Open the **History** panel from the sidebar to reopen or permanently delete archived chats — it has separate "💻 Code" and "🐾 Assistant" sections, since Assistant tabs archive to their own history rather than a project's.

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

## Browser automation (beta)

Optional, off by default. When enabled in Settings → Automation, the agent gets a `browser` tool for local,
Playwright-driven browser control: navigate, click, type, fill forms, take screenshots, and read a structured
snapshot of the page — useful for testing a web app, checking a live site, or filling in a form for you.

- **Policy** (Off / Ask / Auto) is independent of your tab's approval-mode dropdown — it only governs browser
  actions. "Ask" shows a screenshot preview before any action that changes page state (click, type, submit, etc.);
  "Auto" lets the agent act without prompting.
- **First use downloads Chromium** — Klenny Code doesn't ship a bundled browser; the very first browser session
  (ever, across the whole app) downloads Chromium once, roughly 150 MB, showing live progress next to the tool
  call in chat. This needs an internet connection and a minute or two; every session after that reuses the
  cached download instantly.
- **Safety defaults**: runs headless-off (you can watch it) for interactive chats but always headless for
  subagents/scheduled tasks; raw JavaScript execution (`evaluate`) is off by default and never available to
  subagents; private-network/localhost access defaults on for interactive use but off for unattended runs; cloud
  metadata endpoints are always blocked.
- You can point `browserExecutablePath` in Settings at an already-installed Chrome/Edge/Brave instead of using
  Playwright's Chromium, skipping the download entirely.

## Tabs

Use **+** or `Ctrl+T` for a new chat tab. `Ctrl+W` closes the active tab. Closing the last tab opens a fresh one.

## Terminal

A collapsible terminal is docked under the chat view — click the "Terminal" bar at the bottom (or press
`` Ctrl+` ``) to expand it. It runs a real interactive shell session using whichever shell you've selected
in Settings → Shell (or the OS default if left on Auto), rooted at your open project folder. The session
stays alive while you collapse/expand the panel, and only restarts if you switch workspaces, click
"Restart", or close the app.

Everything printed in the terminal is also saved to a persistent, plain-text log (ANSI colors
stripped, capped at a few MB with older output auto-trimmed) in Klenny Code's app data directory —
nothing to gitignore. The agent can read it back with the `read_terminal` tool, including sessions
from before the app was last closed, so it can see commands and errors you ran without you having
to paste them.

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
