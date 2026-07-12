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
    ├── memory/            # Auto-memory topic files + MEMORY.md index
    ├── skills/            # Project skills (SKILL.md per skill)
    ├── agents/            # Custom subagent definitions
    └── plans/             # Plan mode artifacts (*.plan.md)
```

Global config lives in `~/.klenny/`.

## Architecture

```
agent/
├── src/main/          # Electron main process (agent orchestrator, tools, IPC)
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

## License

MIT — see [LICENSE](LICENSE).
