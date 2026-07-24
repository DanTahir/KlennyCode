# Klenny Code

<p align="center">
  <img src="Klenny.jpg" alt="Klenny Code" width="160" />
</p>

**Klenny Code** is a desktop coding agent for Windows, macOS, and Linux. Give it an [OpenRouter](https://openrouter.ai) API key and use frontier models — Claude Sonnet 5, Claude Opus 4.8, the latest OpenAI and Google models, and hundreds more.

Built with **Electron + React + TypeScript**, developed with **Bun** as the package manager.

## Features

- **Chat interface** with tabbed sessions (new/close tabs; closing the last opens a fresh one)
- **Agent mode** — read/write/edit/delete files, grep (regex), glob, shell commands, web search
- **Plan mode** — read-only research, clarifying questions, reviewable plan artifacts before edits
- **Thinking display** — streams reasoning tokens from supported models live
- **Diff viewer** — see every code change with accept/reject approval workflow
- **Memory** — project `KLENNY.md`, global `~/.klenny/KLENNY.md`, and auto-memory notes (Claude Code-style)
- **Cross-project reference (read-only)** — the agent can read files and memory from *other* projects it has previously opened, so you can ask it to port a feature or convention from one project into the one you're currently working in
- **Personal Assistant** — an on-demand, ephemeral "Assistant" tab (Gmail, Discord, web search, scheduler, cross-project reference — no coding project required), plus a background scheduler for recurring tasks and a Discord bot for two-way chat/automation — see [Personal Assistant](#personal-assistant) below
- **No `.gitignore` gymnastics** — plans, auto-memory notes, and the codebase index live in Klenny Code's own app data directory, not in your project
- **Skills** — Cursor-style `SKILL.md` files, auto-discovered and loaded when relevant
- **Subagents** — built-in + custom types, parallel execution, separate subagent model setting
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

| Mode | Behavior |
|------|----------|
| Manual review (default) | Every edit/delete/command shows a diff or preview — accept or reject |
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
custom subagents, and global memory (`KLENNY.md` + auto-memory notes).

### Cross-project reference (read-only)

Because every project's memory/plans/index and chat sessions are keyed by path under Klenny
Code's own `userData` directory (not inside the project itself — see above), Klenny Code
already knows about every project you've previously opened. The agent can use this to read
files and memory notes from *other* projects while working in your current one — e.g.
"port the shell-selection feature from my other project into this one" — via a small set of
read-only tools (`list_projects`, `read_other_project_file`, `grep_other_project`,
`glob_other_project`, `read_other_project_memory`). There is no cross-project write/edit —
the agent can only ever modify files in the project you currently have open.

### Personal Assistant

Beyond coding projects, Klenny Code can act as a lightweight personal assistant:

- **Assistant tab** — click "Open Assistant" in the sidebar (between "Check for update" and
  "Change project") to spin up a new chat tab with web search, cross-project reference, memory,
  Gmail, Discord, and scheduler tools, but no file/shell access (no coding project needed). Every
  click creates a fresh, independent tab; closing one discards it permanently — there is no
  persistence or history for Assistant tabs in this version.
- **Gmail** — connect your own Google Cloud OAuth client in Settings → Integrations to let the
  agent read and (once you opt in) send email.
- **Discord** — connect a bot application (never a personal account) to let the agent post
  updates and respond to DMs/mentions/`!klenny` commands, including reviewing a known project
  read-only when asked.
- **Scheduler** — define recurring tasks ("every morning at 8am, summarize my inbox") that run
  unattended as background subagents, even while the app is minimized to the system tray. Enable
  "Minimize to tray" / "Start on login" in Settings so the scheduler and Discord bot keep running.
  When a run finishes, its final answer is delivered as a new message in the tab that created the
  task — reopening that tab from History first if it had been closed — or, if the tab can no
  longer be found at all, a brand-new tab is opened for it instead (an Assistant tab for
  workspace-less tasks, or a project tab in the task's target workspace otherwise). A desktop
  notification is shown if no Klenny Code window is currently focused.
- **Automation Permissions** (Settings → Integrations) — a simple per-action allow/block toggle
  (Gmail read/send, Discord read/post, scheduler on/off) governing what the agent may do
  unattended; there's no live "ask me" prompt for background actions.

Coding tools (file read/write, shell commands, codebase search) remain scoped to an actual open
project — the Assistant tab and its tools are additive, available everywhere, not a replacement.

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
