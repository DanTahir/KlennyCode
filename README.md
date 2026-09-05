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
- **Word document support** — `read_docx`/`write_docx`/`edit_docx` tools read structured content (paragraphs, runs with formatting, tables, headers/footers, comments, tracked changes) from `.docx` files, generate brand-new ones from a JSON spec, and apply surgical edits directly to a `.docx`'s underlying XML so untouched content (images, comments, revisions, unknown formatting) survives byte-for-byte, unlike round-tripping through a lossy text conversion
- **Attach documents to chat** — an accessible attach menu next to the composer lets you upload a `.md`/`.txt`/`.docx` file (8 MB cap) alongside images; content is extracted server-side at attach time via IPC (so parse/size errors surface immediately, not on Send), wrapped with clear delimiters for the model, truncated with a visible badge if it exceeds the per-message text cap, and rendered as a chip in both the pending-attachment row and message history
- **Image viewing** — `read_image` reads a png/jpg/gif/webp file from disk (any absolute path on the host, or relative to the open workspace) and lets the agent actually see it, exactly like a user-pasted/attached image
- **Plan mode** — read-only research, clarifying questions, reviewable plan artifacts before edits
- **Live-progress checklists** — not just for approved plans: the agent can start one for any multi-step task via `create_checklist`, ticking items off live via `update_checklist` as it actually finishes them (with an optional short evidence note per item — self-reported, not independently verified, but it adds friction and a visible trail). The checklist survives context compaction, reappearing fresh every turn so the agent never loses track of what's actually done
- **Fabrication guard** — the harness mechanically cross-checks what the agent *says* it did against what it actually did: a machine-maintained ledger of executed tool calls, the injected clock, the live checklist, and the filesystem. Claims that contradict those records (a file "created" that no write touched and doesn't exist, a completion time in the future, a checklist declared finished with no `update_checklist` call) get the message badged as **disputed** and force the agent to retract or actually do the work. Costs nothing extra — it's pure bookkeeping, with no additional model calls — and is configurable (Enforce / Warn only / Off) in Settings → see [Fabrication guard](#fabrication-guard) below
- **Thinking display** — streams reasoning tokens from supported models live
- **Diff viewer** — see every code change with accept/reject approval workflow
- **Memory** — project `KLENNY.md`, global `~/.klenny/KLENNY.md`, and auto-memory notes (Claude Code-style); Assistant tabs additionally share a single auto-compacting memory pool across every Assistant window — see [Assistant window shared memory](#assistant-window-shared-memory) below
- **Personality** — a user-editable `~/.klenny/SOUL.md` describing who the agent is and how it talks, defaulting to a playful corgi persona; edit it from the Memory tab's "Personality" scope, blank it out for a neutral voice, or restore the built-in default with one click — hardcoded guardrails always keep personality from affecting reasoning, plans, or code quality
- **Cross-project reference (read-only)** — the agent can read files and memory from *other* projects it has previously opened, so you can ask it to port a feature or convention from one project into the one you're currently working in
- **Personal Assistant** — an on-demand, persistent "🐾 Assistant" tab (Gmail, Discord, web search, scheduler, cross-project reference — no coding project required), plus a background scheduler for recurring tasks and a Discord bot for two-way chat/automation — see [Personal Assistant](#personal-assistant) below
- **Pawprints** — the agent can build small, single-file React apps ("Pawprints" — sticky notes, timers, trackers, etc.) that run as their own sandboxed desktop windows, separate from the chat UI. Creating or updating one always goes through a hard-blocked human approval step (source diff + any requested npm packages + any requested network domains, shown together); the agent can also read and edit a running or closed Pawprint's saved data directly via the normal file tools, and an open window picks up an external data edit automatically, in place, with its size and position untouched — see [Pawprints](#pawprints) below
- **History panel** — closed chat tabs (with messages) are archived, not deleted; reopen or permanently delete them from the History panel, which has separate "💻 Code" and "🐾 Assistant" sections
- **Cost Report** — a Settings panel breaking down cumulative token usage and USD cost by model, for the current project and across all projects
- **Codebase semantic search (beta)** — optional, off-by-default vector index of your workspace so the agent can find relevant code by meaning via a `codebase_search` tool, alongside `grep`/`glob`
- **Browser automation (beta)** — optional, off-by-default local Playwright-driven browser control (navigate, click, type, snapshot, screenshot, etc.), gated by its own policy (Off/Ask/Auto) in Settings → Automation, independent of file-edit approvals. Chromium isn't bundled with the app; the very first browser session downloads it once (~150 MB), showing progress inline in the tool call
- **Integrated terminal** — a collapsible, real interactive shell session (via `node-pty`) docked under the chat view, rooted at your open project. Its output is persisted to a size-capped, ANSI-stripped log per project (survives app restarts) and readable by the agent via a `read_terminal` tool, so it can see what you ran — including in past sessions — without you pasting it
- **Selectable shell** — pick which shell `run_command` and the terminal use (e.g. Git Bash, PowerShell, cmd, WSL) in Settings, or leave it on OS-default Auto
- **No `.gitignore` gymnastics** — plans, auto-memory notes, and the codebase index live in Klenny Code's own app data directory, not in your project
- **Skills** — Cursor-style `SKILL.md` files, auto-discovered and loaded when relevant. Authored via the Skills panel, directly on disk, or by the agent itself via the `write_skill` tool (project or global scope). Three skills ship built in and are installed automatically on first run — `browser-automation`, `pawprint-authoring`, and `website-replica` (which builds a pixel-faithful Next.js replica of a live web page, and comes with its own 34-file project template). Your edits to a built-in skill are preserved across app updates, and one you delete stays deleted
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

### Fabrication guard

LLM agents can produce a confident, detailed, entirely fictional report of work they never did —
narrating commands they never ran and files they never wrote. Prose instructions telling the model
not to do this help, but they are not a control: they can simply be violated, and the failure looks
identical to success.

So Klenny Code checks the agent's claims against records the agent doesn't author:

| Ground truth | What it catches |
|---|---|
| **Verification ledger** — harness-generated list of tool calls that actually executed this turn | "I ran the tests / updated the checklist" with no such call on record |
| **Injected clock** | A stated completion time later than the real current time |
| **Filesystem** | A file described as created that no write tool targeted *and* that doesn't exist |
| **Live checklist** | "All items complete" while the checklist still has unfinished items |

The ledger is also injected into the agent's own context every turn, so it can see the same
authoritative record the auditor uses — the goal is for the agent to self-correct before a check
ever fires.

Findings come in two tiers:

- **Hard** — near-unforgeable contradictions. The message is badged **Disputed** in red, and (in
  Enforce mode) the agent is handed an audit note and required to retract the unsupported claims or
  actually perform the work with real tool calls. Capped at two correction attempts, after which the
  turn stops rather than looping.
- **Soft** — heuristics (e.g. a wall of result-shaped output with no tool calls). These only badge
  the message **Unverified narration** in amber; they never interrupt.

| Setting | Behavior |
|---|---|
| Enforce (default) | Hard findings force a self-correction turn; soft findings warn |
| Warn only | Everything is badged, nothing is ever forced |
| Off | No checking |

A few deliberate design choices worth knowing:

- **No extra model calls.** Every check is programmatic string/filesystem work, so the guard adds
  no token cost and no latency to speak of.
- **Flagged, never deleted.** A disputed message stays visible with its badge — you need to see
  exactly what was claimed to judge it. Disputed messages are also labelled as disputed inside
  context-compaction summaries, so a fabricated claim can't be laundered into "trusted history"
  later.
- **False positives were the primary design risk.** Code blocks and backticked text are stripped
  before analysis, hedged/future-tense phrasing is ignored, honest "I tried to write X but it was
  rejected" narration is exempt, and Plan mode drops the file-existence and narration-volume checks
  entirely (a plan legitimately describes files it intends to create, at length).
- **Checklist items marked done in a turn with no tool calls at all** are tagged as unbacked in the
  widget rather than silently accepted — that pattern is the signature of the incident this feature
  was built in response to.
- **Unattended runs** (subagents, scheduled tasks) don't get a correction loop — nobody's watching
  to click Continue — so their findings are appended to the delivered result instead.

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
`multi_edit`/`multi_write`/`delete_file` are otherwise sandboxed to the currently open workspace (or an
Assistant tab's Documents directory) — mutation doesn't reach outside the project/folder you
have open — **except** for two always-allowed global directories: `~/.klenny/` (global
memory/skills/subagents/`SOUL.md`) and Klenny Code's own Electron `userData` directory
(settings, sessions, plans, per-project data). Those two stay mutable through the normal file
tools no matter what workspace is open (or none at all), so the agent can maintain its own
config/state directly instead of falling back on shell workarounds. `read_docx` and `read_image`
follow the same global, read-only rule; `write_docx`/`edit_docx` are sandboxed the same way as
the other mutating file tools (including the same two always-allowed exceptions).

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
  Gmail, Discord, scheduler tools, and full file tools (read/write/edit/multi_edit/multi_write/
  delete/grep/glob, plus `read_docx`/`write_docx`/`edit_docx` for Word documents specifically and `read_image`
  to actually see image files) — but no coding project needed and no
  shell/`run_command`/`codebase_search` access.
  File-tool relative paths and mutation are sandboxed to a **Documents directory**
  (Settings → Behavior → "Documents directory", default your OS Documents folder) instead of a
  project workspace, with the same always-allowed exceptions for `~/.klenny/` and the Electron
  `userData` directory described above; absolute-path reads can still reach anywhere on the
  machine, same as in a project tab. Every click creates a fresh, independent tab (no create-or-focus singleton
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

### Pawprints

Beyond editing your own project files, the agent can generate small, standalone React apps —
called **Pawprints** — that live outside the chat window entirely, each running in its own
sandboxed desktop window (a sticky-note app, a countdown timer, a simple tracker, etc.).

- **Sandboxed by construction, not just by convention** — a Pawprint window never gets Node
  integration, the OpenRouter API key, `run_command`, or general filesystem access, even if its
  generated code is buggy or actively hostile. Each Pawprint's source is statically validated
  (only React, a small SDK, vetted libraries, and its own explicitly-approved npm packages may be
  imported — no dynamic `require`/`eval`/Node globals), then bundled once at approval time and
  served from a locked-down custom protocol with its own per-window session.
- **Human approval is the security boundary, always** — `create_pawprint`/`update_pawprint` are
  hard-blocked regardless of your approval-mode setting (even Auto/Accept-all). The single
  approval screen shows the full source diff, any requested extra npm packages (fetched directly
  from the npm registry, hash-verified against the registry's own published integrity hash, and
  rejected outright if they contain native bindings or install-time lifecycle scripts), and any
  requested network domains (exact hostnames only, HTTPS-only, capped at 10 per Pawprint,
  enforced at the network layer first and mirrored into CSP as a second layer) — all together, so
  you review everything that could affect what the Pawprint does in one place.
- **A small curated library set ships for free** — a short allowlist of pre-bundled, browser-safe
  libraries (starting with `nanoid`) is always importable without going through the extra-package
  approval flow, since they're part of Klenny Code itself rather than something fetched at
  runtime.
- **The agent can read and edit a Pawprint's saved data directly** — ask it to "add an item to my
  todo-list Pawprint" and it locates that instance's state file (via `read_pawprint_source`) and
  edits the JSON with the same `read_file`/`edit_file`/`write_file`/`multi_edit`/`multi_write` tools it already
  uses everywhere else — no dedicated tool needed. This works even for a Pawprint that isn't
  currently open; the change is simply there the next time you open it. A currently-open window
  notices the change automatically and reloads itself in place (same window, size and position
  untouched) — the agent's blanket file access is narrowed, for this one subtree, to only allow
  writing that saved-data file directly; changing a Pawprint's actual code or approved
  packages/domains still always requires the approval flow above.
- **My Pawprints panel** — see every Pawprint you've created, open/close/delete instances, toggle
  always-on-top per window, review (read-only) its approved packages and domains, and jump into a
  chat pre-scoped to "ask Klenny to modify" one of them. Deleting an instance removes its saved
  data and its window (if open) but leaves the Pawprint itself and its other instances untouched;
  deleting a Pawprint's very last instance is allowed for either instance model — the panel just
  falls back to a "reopen" row, so nothing is ever bricked.
- **A Pawprint can delete its own instance from inside its own UI** — the SDK's `deleteSelf()`
  lets agent-written code add an in-app control (e.g. a trash icon on one sticky note in a
  `per-item` Pawprint) that deletes only that instance's own window and saved data, without going
  through the management panel.
- **Known v1 limitations** — no rollback to a previous version of a Pawprint's source (updates are
  destructive; only the latest approved version is kept), and the network domain allowlist doesn't
  defend against DNS rebinding to a private IP — both called out here rather than silently glossed
  over.

Pawprints have thorough automated coverage (`agent/tests/pawprints-*.test.ts`) for everything
`bun:test` can exercise without a real rendered window — bundling, validation, storage, the
package pipeline, domain rules, theming, the write-access guard, and the state-file watcher's
reload/debounce/self-write-suppression logic. A handful of things genuinely need a live Electron
GUI and haven't been visually verified in this environment: CSP/`connect-src` enforcement actually
blocking a real network request at runtime, a package-fetch pipeline run against the live npm
registry, always-on-top state surviving a real app restart, and a real on-disk edit (via the
actual `edit_file` tool, not a simulated write) reloading a real open Pawprint window in place with
its size/position unchanged.

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
