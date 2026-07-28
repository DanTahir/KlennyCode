# Klenny Code

<p align="center">
  <img src="Klenny.jpg" alt="Klenny Code" width="160" />
</p>

**Klenny Code** is a desktop coding agent for Windows, macOS, and Linux. Give it an [OpenRouter](https://openrouter.ai) API key and use frontier models — Claude Opus 5, Claude Sonnet 5, the latest OpenAI and Google models, and hundreds more.

Built with **Electron + React + TypeScript**, developed with **Bun** as the package manager.

👉 See **[klennycode.com](https://klennycode.com)** for the marketing site, screenshots, and one-click downloads (the `web/` folder in this repo, deployed automatically on release).

## Features

- **Chat interface** with tabbed sessions (new/close tabs; closing the last opens a fresh one)
- **Agent mode** — read/write/edit/delete files, grep (regex), glob, shell commands, web search
- **Plan mode** — read-only research, clarifying questions, reviewable plan artifacts before edits
- **Thinking display** — streams reasoning tokens from supported models live
- **Diff viewer** — see every code change with accept/reject approval workflow
- **Memory** — project `KLENNY.md`, global `~/.klenny/KLENNY.md`, and auto-memory notes (Claude Code-style); Assistant tabs additionally share a single auto-compacting memory pool across every Assistant window — see [Assistant window shared memory](#assistant-window-shared-memory) below
- **Personality** — a user-editable `~/.klenny/SOUL.md` describing who the agent is and how it talks, defaulting to a playful corgi persona; edit it from the Memory tab's "Personality" scope, blank it out for a neutral voice, or restore the built-in default with one click — hardcoded guardrails always keep personality from affecting reasoning, plans, or code quality
- **Cross-project reference (read-only)** — the agent can read files and memory from *other* projects it has previously opened, so you can ask it to port a feature or convention from one project into the one you're currently working in
- **Personal Assistant** — an on-demand, persistent "🐾 Assistant" tab (Gmail, Discord, web search, scheduler, cross-project reference — no coding project required), plus a background scheduler for recurring tasks and a Discord bot for two-way chat/automation — see [Personal Assistant](#personal-assistant) below
- **History panel** — closed chat tabs (with messages) are archived, not deleted; reopen or permanently delete them from the History panel, which has separate "💻 Code" and "🐾 Assistant" sections
- **Cost Report** — a Settings panel breaking down cumulative token usage and USD cost by model, for the current project and across all projects
- **Codebase semantic search (beta)** — optional, off-by-default vector index of your workspace so the agent can find relevant code by meaning via a `codebase_search` tool, alongside `grep`/`glob`
- **Browser automation (beta)** — optional, off-by-default local Playwright-driven browser control (navigate, click, type, snapshot, screenshot, etc.), gated by its own policy (Off/Ask/Auto) in Settings → Automation, independent of file-edit approvals. Chromium isn't bundled with the app; the very first browser session downloads it once (~150 MB), showing progress inline in the tool call
- **Integrated terminal** — a collapsible, real interactive shell session (via `node-pty`) docked under the chat view, rooted at your open project. Its output is persisted to a size-capped, ANSI-stripped log per project (survives app restarts) and readable by the agent via a `read_terminal` tool, so it can see what you ran — including in past sessions — without you pasting it
- **Selectable shell** — pick which shell `run_command` and the terminal use (e.g. Git Bash, PowerShell, cmd, WSL) in Settings, or leave it on OS-default Auto
- **No `.gitignore` gymnastics** — plans, auto-memory notes, and the codebase index live in Klenny Code's own app data directory, not in your project
- **Skills** — Cursor-style `SKILL.md` files, auto-discovered and loaded when relevant. Authored via the Skills panel, directly on disk, or by the agent itself via the `write_skill` tool (project or global scope)
- **Subagents** — built-in + custom types, parallel execution, separate subagent model setting. Custom types are authored via the UI, directly on disk, or by the agent itself via the `write_subagent` tool (project or global scope), and read back (including built-ins) via `read_subagent`
- **Clarifying questions** — structured multiple-choice prompts in every mode (especially Plan mode)
- **Vision** — attach/paste images in chat for multimodal models
- **Spending cap** — per-session or daily USD limit with warning and hard block
- **Auto-update** — packaged builds check GitHub Releases via `electron-updater`
- **Cross-platform** — Windows, macOS, and Linux installers built in CI

## Screenshots

_Open the app, add your API key in Settings, and open a project folder to get started._

## Quick start (development)

### Prerequisites

- [Bun](https://bun.sh) 1.1+
- Node.js 20+ (used by Electron)
- Windows 10/11 (for local Windows builds)

### Setup

```bash
cd agent
bun install
bun run icons
bun run dev
```

### Build installers

```bash
cd agent
bun run build
bun run dist:win    # Windows (run on Windows)
bun run dist:mac    # macOS (run on macOS or CI)
bun run dist:linux  # Linux (run on Linux or CI)
```

Installers are written to `agent/dist/`.

## Configuration

1. Launch Klenny Code
2. Go to **Settings** → paste your OpenRouter API key
3. Click **Open folder** in the sidebar to select your project
4. Pick a model (curated frontier models are pinned at the top; full catalog is searchable)
5. Choose **Agent** or **Plan** mode per tab

### Approval modes

Set a default in Settings, and override it per chat tab from the dropdown next to Send/Stop
(useful when you want one tab to run hands-off while another stays under manual review). Clicking
"Accept all" on a pending approval card also flips that tab's dropdown to Auto approve — you can
switch it back to Manual or Command approve afterward. Assistant tabs get the same dropdown (since
they can write files/memory too) but without the Command approve option, since Assistant tabs have
no shell/`run_command` tool for it to affect.

| Mode | Behavior |
|------|----------|
| Manual review (default) | Every edit/delete/command shows a diff or preview — accept or reject |
| Command approve | File edits/deletes apply immediately (with checkpoints); shell commands still require approval |
| Auto-apply | Changes apply immediately; shadow-git checkpoints enable revert |

### Project layout (created by Klenny Code)

```
your-project/
├── KLENNY.md              # Project memory (commit to git)
├── KLENNY.local.md        # Personal project prefs (gitignored)
└── .klenny/
    ├── skills/            # Project skills (SKILL.md per skill) — commit to git
    └── agents/            # Custom subagent definitions — commit to git
```

Everything else Klenny Code generates for a project — auto-memory topic files, plan mode
artifacts, and the codebase semantic-search index — is **not** written inside your project.
It's stored under `projects/<id>/` (one subfolder per project, keyed by its path) in Klenny
Code's own Electron `userData` directory (e.g. `%APPDATA%/Klenny Code/` on Windows,
`~/Library/Application Support/Klenny Code/` on macOS, `~/.config/Klenny Code/` on Linux), so
there's nothing to `.gitignore` and no risk of accidentally committing local agent state.

Global config (shared across all projects) lives in `~/.klenny/` — global skills, global
custom subagents, global memory (`KLENNY.md` + auto-memory notes), and the agent's personality
(`SOUL.md`).

### Filesystem access and cross-project reference

`read_file`, `grep`, and `glob` are global, read-only tools — they can reach any absolute path
on the host the way you, the logged-in user running Klenny Code, can (not limited to the open
project). A relative path still resolves against the current workspace as before, and with no
path at all grep/glob still default to the workspace root. `write_file`/`edit_file`/
`multi_edit`/`delete_file` remain sandboxed to the currently open workspace only — mutation
never reaches outside the project you have open.

Because every project's memory/plans/index and chat sessions are keyed by path under Klenny
Code's own `userData` directory (not inside the project itself — see above), Klenny Code
already knows about every project you've previously opened; `list_projects` lists them. Combined
with global read_file/grep/glob, the agent can reference or port things from *other* projects
while working in your current one — e.g. "port the shell-selection feature from my other project
into this one" — just by passing an absolute path from `list_projects`. `read_memory` and
`list_memory` similarly take an optional `project` argument to look at a different known
project's memory notes instead of the current one. There is still no cross-project write/edit or
memory write — the agent can only ever modify files or write memory for the project you
currently have open.

### Personal Assistant

Beyond coding projects, Klenny Code can act as a lightweight personal assistant:

- **Assistant tab** — click "Open Assistant" in the sidebar (between "Check for update" and
  "Change project") to spin up a new chat tab with web search, `list_projects` discovery, memory,
  Gmail, Discord, scheduler tools, and full file tools (read/write/edit/multi_edit/delete/grep/
  glob) — but no coding project needed and no shell/`run_command`/`codebase_search` access.
  File-tool relative paths and every mutation are sandboxed to a **Documents directory**
  (Settings → Behavior → "Documents directory", default your OS Documents folder) instead of a
  project workspace; absolute-path reads can still reach anywhere on the machine, same as in a
  project tab. Every click creates a fresh, independent tab (no create-or-focus singleton
  behavior), tagged with a 🐾 pawprint in the tab bar and automatically retitled from your first
  message, just like a regular chat tab. Assistant tabs are workspace-independent: they persist
  across app restarts, and closing one (once it has messages) archives it to the "🐾 Assistant"
  section of the History panel instead of discarding it — reopen it from there to keep going.
- **Shared Assistant memory** — every Assistant tab silently keeps other Assistant windows in the
  loop; see [Assistant window shared memory](#assistant-window-shared-memory) below.
- **Gmail** — connect your own Google Cloud OAuth client in Settings → Integrations to let the
  agent read and (once you opt in) send email.
- **Discord** — connect a bot application (never a personal account) to let the agent post
  updates and respond to DMs/mentions/`!klenny` commands, including reviewing a known project
  read-only when asked.
- **Scheduler** — define recurring tasks ("every morning at 8am, summarize my inbox") that run
  unattended as background subagents, even while the app is minimized to the system tray.
  "Minimize to tray" is on by default in Settings (and "Start on login" can be enabled there too)
  so the scheduler and Discord bot keep running. When a run finishes, its final answer is
  delivered as a new message in the tab that created the task — reopening that tab from History
  first if it had been closed — or, if the tab can no longer be found at all, a brand-new tab is
  opened for it instead (an Assistant tab for workspace-less tasks, or a project tab in the task's
  target workspace otherwise).
- **Desktop notifications** — a native OS notification is shown whenever Klenny Code has no
  focused window and any of the following finishes: a subagent run, a main chat turn (the agent's
  final summary), or a scheduled task run.
- **One-time and limited-repetition tasks** — every scheduled task can carry an optional `maxRuns`:
  once it has fired that many times, it deletes itself instead of rescheduling. Asking the agent to
  "do this at 8pm" or "remind me in 10 minutes" creates a one-shot task (`maxRuns: 1`); "every 10
  minutes, 3 times in a row" sets `maxRuns: 3`. Leaving `maxRuns` unset means the task recurs
  indefinitely until deleted, same as before. The Settings → Scheduled tasks panel has a "Max runs"
  field for creating these by hand, and shows each task's current run count when applicable.
- **Automation Permissions** (Settings → Integrations) — a simple per-action allow/block toggle
  (Gmail read/send, Discord read/post, scheduler on/off) governing what the agent may do
  unattended; there's no live "ask me" prompt for background actions.

Shell commands (`run_command`), the interactive terminal, and codebase semantic search remain
scoped to an actual open project — the Assistant tab and its tools are additive, available
everywhere, not a replacement for a project tab when you actually need to edit code.

### Assistant window shared memory

Assistant tabs (see above) share a single, workspace-independent memory pool so that opening a
second (or third, or tenth) Assistant window doesn't mean starting from a blank slate — each
window can see at a glance what the others have been up to.

- **How it's written** — after each Assistant-tab turn finishes (live in the UI, or delivered by a
  scheduled task), Klenny silently uses the cheap/fast **utility model** (Settings → Models & cost)
  to rewrite that tab's own memory slot: a short note summarizing what happened since its last
  update. This never shows up as a visible tool call — it's a background housekeeping step, same
  spirit as chat-history compaction.
- **How it's read** — every Assistant tab's system prompt is silently given a digest of every
  *other* Assistant tab's current slot (never its own — see the caching note below) at the top of
  each turn, so the agent can naturally reference other windows' work without you having to
  paste anything in. It can also be read on demand any time via `read_memory` with
  `scope: "assistant"`.
- **Aggregate budget & compaction** — the whole pool shares one token budget, set in
  Settings → Models & cost as "Assistant window memory": Small (~10k tokens, default), Large
  (~20k tokens), or Disabled. The newest ~40% of the budget is kept as individually-addressable
  slots; anything older gets folded into a single rolled-up summary (also via the utility model,
  bounded to ~2,000 tokens) so the pool never grows without limit. Turning the setting to Disabled
  stops all new writes immediately — existing notes stick around, simply excluded from prompts,
  until you re-enable it or clear them by hand.
- **Viewing/managing it** — the Memory panel's scope dropdown has an "Assistant windows (shared
  memory)" option showing every slot (tab title, content, token estimate, last-updated time) and
  the current rollup, with per-slot delete, "Clear rollup", and "Clear all" actions. Klenny itself
  is the only writer — this view is otherwise read-only.
- **Cost & caching** — utility-model calls for a tab's own slot update are attributed to that tab's
  cost total; pool-wide rollup compaction is attributed globally (not to any one tab), same
  convention as codebase-index embedding costs. The digest is injected as an uncached trailing
  note (alongside the current-time note) so it never invalidates prompt caching on the big, static
  part of the system prompt — see the code comments in `system-prompt.ts` if you're curious about
  the caching mechanics.

## Architecture

```
agent/
├── src/main/          # Electron main process (agent orchestrator, tools, IPC)
│   ├── integrations/  # Gmail (OAuth) and Discord (bot) integrations
│   ├── scheduler/      # Background recurring-task manager (ScheduledTaskManager)
│   └── tray.ts         # System tray, minimize-to-tray, auto-start-with-OS
├── src/preload/       # Typed contextBridge API
├── src/renderer/      # React UI
├── shared/            # Types + IPC channel names
├── build/icons/       # App icon (generated from Klenny.jpg)
└── tests/             # Bun test suite
```

## CI builds and auto-update

Every push to `main` that touches `agent/**` triggers GitHub Actions to:

1. Build Windows, macOS, and Linux installers
2. **Publish a GitHub Release** (version `0.1.<run_number>`, e.g. `v0.1.42`)
3. Upload `latest.yml` metadata so installed apps can auto-update via `electron-updater`

**Download installers:**
- [GitHub Releases](https://github.com/DanTahir/KlennyCode/releases/latest) — scroll past "Source code" to the installer assets
  - Windows: `KlennyCode-Setup-<version>.exe` (installer) or `KlennyCode-<version>.exe` (portable)
  - macOS: `KlennyCode-<version>-arm64.dmg` or `.zip`
  - Linux: `KlennyCode-<version>.AppImage` or `.deb`
- [Actions artifacts](https://github.com/DanTahir/KlennyCode/actions) — backup copies on each workflow run

Packaged Klenny Code apps (installer builds on Windows/macOS/Linux) check for updates on startup and every few
hours thereafter, download new versions in the background, and prompt to restart once ready. The Windows
**portable** exe cannot auto-update (electron-builder only supports auto-update for the NSIS installer target on
Windows) — grab new portable builds manually from Releases.

### macOS: "app is damaged and can't be opened"

Klenny Code isn't signed with a paid Apple Developer certificate, so macOS Gatekeeper blocks the downloaded
`.dmg`/`.app` and reports it as damaged. This isn't actual corruption — it's Gatekeeper refusing to run an
unsigned app. Clear the quarantine flag from Terminal to fix it (the installed app bundle is `KlennyCode.app`
— no space — even though it displays as "Klenny Code"):

```bash
xattr -cr /Applications/KlennyCode.app
```

Then launch it normally. If you haven't dragged it into `/Applications` yet, you can strip quarantine from the
`.dmg` itself first instead:

```bash
xattr -cr ~/Downloads/KlennyCode.dmg
```

(Adjust the path if your downloaded file has a version suffix, e.g. `KlennyCode-0.1.42-arm64.dmg`.)

## License

MIT — see [LICENSE](LICENSE).
