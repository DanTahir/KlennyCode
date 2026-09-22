# Klenny Code

Klenny Code is a desktop coding agent for Windows, macOS, and Linux — **Electron + React +
TypeScript**, developed with **Bun**. It drives [OpenRouter](https://openrouter.ai) so users can
run the agent on Claude, GPT, Gemini and hundreds of other models via one API key. Beyond project
coding chats it doubles as a personal-assistant platform (Gmail, Discord, scheduled tasks,
Assistant tabs) with a user-editable personality (`SOUL.md`) under hardcoded rigor guardrails.

## Repo layout

- `agent/` — the app
  - `src/main/` — Electron main: `workspace.ts` (global workspace singleton), `shells.ts`,
    `terminalLog.ts` (persistent ANSI-stripped log of the user's PTY), `processLog.ts` (the app's
    own stdout/stderr + `console.*` capture behind `read_app_log`), `settings.ts`, `ipc.ts`,
    `scheduler/` (cron), `openrouter/` (`client.ts` streaming + summarization, `caching.ts`
    breakpoints, `cacheDiag.ts` prefix fingerprints, `images.ts`), `codeindex/` (optional
    semantic search, embeddings + vectra/Pinecone)
  - `src/main/agent/orchestrator/` — the core loop, split up: `system-prompt.ts`, `prompt-snapshot.ts` (frozen cached prefix), `loop.ts` (turn
    loop + `dispatchTool()`), `state.ts` (per-tab bookkeeping), `turn-lifecycle.ts` (checkpoints,
    compaction hooks, streaming), `checklist.ts`, `ledger.ts`, `approval-previews.ts`,
    `scheduled-and-discord.ts`
  - `src/main/agent/tools/` — `definitions.ts` (schemas + per-context allow-lists) plus impls:
    `file-ops.ts`/`edit-match.ts`/`diff.ts`/`eol.ts`, `search.ts`, `shell.ts`/`terminal.ts`,
    `web.ts`, `browser.ts` (Playwright), `image.ts`, `imagegen.ts`, `otherProjects.ts`, plus
    docx/memory/subagent/ask_question
  - `src/main/agent/pawprints/` — 18 modules for sandboxed single-file TSX widget apps:
    `manager.ts`, `windowManager.ts`, `bundler.ts` + `packagePipeline.ts` (esbuild + npm vetting),
    `validator.ts`, `protocol.ts`, `writeGuard.ts`, `storage.ts`, `domains.ts`, `sdk.ts`
  - `src/main/agent/` also: `turnControl.ts` (pure turn-budget / empty-generation + truncation
    retry / compaction- and audit-resume decisions, no Electron deps),
    `compaction/compactor.ts`, `verify/` (fabrication guard:
    `fabrication-detector.ts` C1–C6 + `audit.ts`), `messages.ts` (`toORMessages()`), `memory/`
    (project + assistant pools), `soul/`, `plan/manager.ts` (prompt bodies + guardrails),
    `skills/`, `subagents/`, `frontmatter.ts` (safe YAML — see gotcha)
  - `src/preload/` typed `contextBridge`; `src/renderer/` React UI (chat tabs, settings,
    memory/skills/history/Pawprints panels, terminal); `shared/` types + IPC; `tests/` Bun suite
- `web/` — standalone Next.js 14 App Router marketing site (TS + Tailwind, Bun, own
  `package.json`), static-exported to `out/`. Auto-deployed to S3+CloudFront (klennycode.com) by
  `.github/workflows/deploy-web.yml` on **any** push touching `web/**` on `main`.
- `GOTCHAS.md` — the long-form non-obvious gotchas + open follow-ups (see the last section here)
- `README.md` — user-facing overview, setup, architecture (keep in sync with reality)

## Major features (beyond core chat-with-tools)

- **Personal-assistant platform**: ephemeral, workspace-independent **Assistant tabs**
  (`kind: 'assistant'`) for Gmail (read/send), Discord (@-mentions + `!klenny`), a cron
  **Scheduler** (`scheduler_create_task`), and general Q&A. Their file tools are scoped to a
  configurable Documents directory instead of the workspace, and coding-only tools are gated off
  client-side *and* server-side in `dispatchTool`. All Assistant tabs share one **auto-compacting
  memory pool** (newest-first slots, ~40% kept / 60% summarized at threshold) via
  `read_memory('assistant')`.
- **Cross-project read-only reference**: `read_file`/`grep`/`glob`/memory tools take absolute paths
  or a `project` param to inspect *other* known projects, never writing to them.
- **Integrated terminal**: node-pty panel, one PTY per workspace, a persistent plain-text log read
  via `read_terminal`, and a selectable shell shared with `run_command`.
- **Self-logging** (`read_app_log` → `main/processLog.ts` + `agent/tools/appLog.ts`): the app's
  **own** main-process stdout/stderr *and* `console.*` captured into a persistent, ANSI-stripped
  `process.log` under `userData` — surviving restarts (`=== App session started … ===`) and working
  in a packaged build with no console. Distinct from `read_terminal` (what the *user* ran). Built so
  the agent can diagnose its own prompt caching instead of asking for pasted output, which is how
  every real caching bug was found; its `filter` is a case-insensitive substring applied **before**
  the line cap, which is what makes pulling old `[cache]` lines out of a chatty log practical.
  Non-obvious: under **Bun** `console.log` bypasses `process.stdout.write`, so both the streams
  **and** the console methods are patched, with `suppressStreamCapture` preventing double capture
  on Node/Electron.
- **Batch file editing / writing**: `multi_edit` bundles edit_file-style replacements; `multi_write`
  is the write-side counterpart (`files` array of {path, content}). Both all-or-nothing and
  single-approval, sharing the plan/preview/diff shape in `tools/file-ops.ts`. Results carry exactly
  **one** copy of the diff (`data.diff`) — never re-echo it per file.
- **Parallel content generation** (`parallel_write` → `tools/parallel-write.ts` +
  `tools/parallel-write-protocol.ts`): N **unrelated** write/edit jobs generated by N concurrent
  single-shot completions on the tab's own model — tool *dispatch* was already parallel while token
  *generation* was not. The main model emits only per-job specs; context travels **by reference**
  (paths, read fresh by the harness via `readWithMtime`, never through `fileReadCache`), so bulk
  content never enters its output budget. Workers reply in a per-call **nonce-delimited** sentinel
  envelope, are staged through the existing `planMultiWrite`/`planMultiEdit` planners, get one
  approval card + bounded diff each, and are re-verified against a Phase-2 mtime snapshot before
  applying. Overlapping paths across jobs are a hard **pre-spend** error — that is what makes
  "independent" structural rather than a convention. Coding mode only: excluded from plan mode and
  Assistant tabs, and blocked in subagents by a **runtime** `unattended` check in `loop.ts` (a
  `tools: 'all'` subagent would otherwise bypass allow-list gating, and subagents force
  `approvalMode: 'auto'`). Optional cache priming is decided by the pure `shouldPrimeCache()` in
  `openrouter/caching.ts`, whose projected saving *grows* with job count, since the single
  cache-write premium amortizes across more readers.
- **Pawprints**: agent-generated, sandboxed single-file React (TSX) widget apps, each in its own
  isolated `BrowserWindow`. `create_pawprint`/`update_pawprint` are **always** hard-blocked pending
  human approval regardless of approval mode — one combined dialog reviews source, npm packages
  (transitive versions resolved and integrity-checked at approval time) and HTTPS domains. No
  OpenRouter key, no `run_command`, no broader filesystem. `read_pawprint_source` returns approved
  source plus per-instance state-file paths; state files are directly editable (an open window
  live-reloads) while writes to source/manifest are rejected, pointing at `update_pawprint`.
- **Image generation** (`generate_image` → `tools/imagegen.ts` → `openrouter/images.ts`): text →
  image file on disk. Path/extension/sandbox validated *before* the paid call; the result is
  deliberately **not** added to model context (use `read_image`). Surfaced only once an image model
  is configured (`AppSettings.imageModel != null`, filtered in `definitions.ts`), never in plan
  mode — planning shouldn't spend money.
- **Codebase semantic search** (`codebase_search`): optional, off-by-default vector index over the
  workspace, incremental via a manifest.
- **Skill/subagent authoring**: the agent writes and reads its own Cursor-style `SKILL.md` skills
  and custom subagent types (`write_skill`/`read_skill`, `write_subagent`/`read_subagent`).
- **Bundled default skills**: `browser-automation`, `pawprint-authoring`, `website-replica` ship
  with every install — `BUNDLED_SKILLS` entries `{content, version, legacyVariants, assets?}`,
  seeded by `seedBundledSkills()` into `~/.klenny/skills/<name>/` with per-skill `{version, hash}`
  in `skills-seed-state.json` (re-seeded on a version bump only if unedited; a skill the user
  *deletes* stays deleted). Skills may carry **multi-file assets**: `website-replica`'s 36-file
  template is written by `seedSkillAssets()` with *per-file* edit detection
  (`SeedRecord.assetHashes`). A deleted *asset* is rewritten (unlike a deleted skill) — template
  internals aren't user-facing units. Inside `seedSkillAssets` the **check order is load-bearing**:
  "on disk already equals what we're about to write" is tested *before* "differs from what we last
  wrote", so a fix made live inside an install and later ported into the bundle is re-adopted as
  pristine rather than pinned as edited and cut off from every future update (the real case:
  `assets.mjs` during the v6 port). A genuine edit differs from both and is still preserved.
- **Checkpoint-based long tasks**: auto-pause every N steps (`turnCheckpointSteps`) with one-click
  Continue — bounds runaway turns without stopping prematurely.
- **Live-progress checklists** (`create_checklist`/`update_checklist`): for any multi-step task, not
  just approved plans. `create_checklist` won't clobber an existing one unless `replace: true`; both
  paths share `buildChecklist()` and the same widget/reinjection machinery. `update_checklist` takes
  an optional per-item `evidence` string (~300 chars) which is a **soft mitigation only** — nothing
  verifies it reflects real work, its value is the friction of articulating a concrete check plus
  the human-inspectable trail, so never build anything downstream that treats it as proof.
- **Live tool-call "writing" status** (`shared/toolWriting.ts`): a call whose arguments are still
  streaming shows a pulsing `writing… 3.4 KB agent/src/foo.ts` card sniffed from the *partial*
  argument JSON (`client.ts` `'tool_call_delta'` → `loop.ts` throttled `tool_call_writing` events →
  renderer placeholder replaced in place by `tool_call_start`). Also splits the old blanket
  `'running'` into `'queued'` (recorded, maybe awaiting approval) vs `'running'` (actually in
  `dispatchTool`) — see the gotcha.
- **Fabrication guard** (`agent/verify/`, `orchestrator/ledger.ts`): cross-checks the model's claims
  against harness-owned ground truth — the **verification ledger** (tool calls that actually ran,
  derived from `tab.messages` so it can't drift), the injected clock, the live checklist, the
  filesystem. Zero extra model calls; tiered by `AppSettings.fabricationGuard`
  (`'off'|'warn'|'enforce'`, default `'enforce'`). **Hard** findings — C1 future completion time,
  C2a literal fake `[called ...]` marker, C3 claimed-created file that no write targeted and
  doesn't exist, C4 checklist contradiction — set `status = 'disputed'`, inject a harness-authored
  audit note (`role: 'user'` + `isAuditNote: true`) and recurse for a forced self-correction,
  capped at `MAX_AUDIT_CORRECTIONS = 2` before the `'audit_failed'` stop reason. **Soft** findings
  — C2b prose tool-claim, C5 narration/tool-call ratio, C6 turn size — are `'warned'` only.
  `scopeForContext()` drops C3/C5/C6 in plan mode (plans legitimately describe files they intend to
  create); subagents and scheduled runs get `buildFindingsWarningBlock()` instead of the correction
  loop (no Continue button, one-shot budget). False positives were the primary design risk: code
  fences and backtick spans are stripped first, same-sentence proximity is required,
  hedging/future-tense bails out, and honest "I tried to write X but it was rejected" narration is
  exempt. See the C3 gotcha for the four precision gates live use forced.
- **Documents and images**: `read_docx`/`write_docx`/`edit_docx` for structured Word edits;
  `read_image` for arbitrary png/jpg/gif/webp files inline.
- **History, Cost Report, per-tab approval modes, auto-update**: closed tabs (project 💻 and
  Assistant 🐾) are archived and reopenable; a Cost Report tracks spend by model over time; each tab
  can override the global approval mode (manual/command/auto); auto-update works on Windows (NSIS)
  and Linux (AppImage) only — see follow-ups for Mac and `.deb`.

## Conventions

- Package manager is **Bun** (`bun install`, `bun run dev`, `bun test`) — not npm/yarn, though
  `npm run build`/`electron-builder` are used for packaging scripts.
- File edits must go through `read_file` + `edit_file`/`write_file` — never `sed -i`/`echo > file`/
  `node -e` via shell, which breaks on Windows (the primary dev platform). `run_command` enforces
  this via `fileEditGuardReason` (`tools/shell.ts`), judging each shell statement separately: only
  *authored* content (echo/printf/heredoc) aimed at a real file counts. Diagnostic `echo`,
  `2>/dev/null`, `2>&1` and `cmd | tee build.log` are deliberately allowed.
- Auto-memory notes, plan artifacts and the codebase index live **outside** the project tree
  (Electron `userData`, keyed per project) so nothing needs `.gitignore` entries. Only `KLENNY.md`,
  `KLENNY.local.md` and `.klenny/skills|agents` are meant to live inside the repo.
- **Personality is user-editable, rigor is not.** `SOUL.md` (`~/.klenny/SOUL.md`, edited from the
  Memory tab's "Personality" scope; `agent/soul/manager.ts`) defaults to a playful corgi persona.
  The non-editable guardrails live in `plan/manager.ts`: `PERSONA_GUARDRAILS_PROMPT` keeps
  personality out of internal reasoning, code, commit messages and plan documents;
  `TRUTHFUL_NARRATION_NOTE` forbids describing a tool call or file mutation as done unless it
  actually ran — the load-bearing fix for compaction-summary poisoning, not a style rule;
  `CHECKLIST_HONESTY_NOTE` requires in-turn verification before marking an item done.
- When changing agent behavior (tools, prompts, memory, orchestrator flow), check `agent/tests/` for
  coverage and update `README.md` if documented behavior changes.

## Useful entry points when investigating a bug or feature

- System prompt: `orchestrator/system-prompt.ts` → `buildSystemPrompt()`, frozen for the
  conversation's life by `orchestrator/prompt-snapshot.ts` (`resolveSystemPrompt` /
  `buildPromptConfigKey`, snapshots in `state.ts`) — see caching invariant 4. Per-turn dynamic content
  (clock, ledger digest, checklist, Assistant memory) must stay in the always-uncached trailing
  note from `buildCurrentTimeNote()`, never the cached prefix — see the caching gotcha.
  `system-prompt.test.ts` asserts both halves (digest present in the trailing note, absent from the
  prefix, prefix byte-identical across two builds). Do not "optimize" it into the prefix later.
- Prompt caching: `openrouter/caching.ts` → `applyCacheControl()`; diagnose only from live
  `[cache]` lines via `read_app_log`, reading `cacheDiag.ts`'s `bp=` prefix fingerprints
  (`wire` / `noMark` / `text` separate a marker-only flip from a shape flip from real content
  change; `on=part`/`on=call` reports marker placement) plus the `rid=` correlating a request line
  with its usage line.
- Turn loop / dispatch: `orchestrator/loop.ts` → the loop and `dispatchTool()` (per-tool switch,
  per-tab approval mode, Assistant-tab coding-tool gate, `Promise.all` parallel dispatch).
- Turn budget / empty-generation + truncation retries / compaction and audit resumes:
  `agent/turnControl.ts` (pure decisions), wired in `orchestrator/turn-lifecycle.ts` and `loop.ts`.
  All three "turn ended mid-task with no error" stalls live here — see the stall gotchas and
  `tests/stall-recovery.test.ts`.
- Per-tab state: `orchestrator/state.ts` — all cleaned up on tab close via `clearTabState()`
  (memory-leak fix — check this when adding per-tab bookkeeping).
- Compaction: `compaction/compactor.ts` — `KEEP_RECENT = 12` messages are never folded,
  summarization uses the separate utility model, and the result is cached in `tab.compactionSummary`
  and re-injected every later turn without re-verification (full history preserved for the UI).
- Wire format: `agent/messages.ts` → `toORMessages()` — flattens `ChatMessage[]`, batches
  tool-result images into one trailing synthetic user message, round-trips reasoning in its own
  wire fields.
- Parallel tool calling: instruction lives in all three prompt bodies in `plan/manager.ts` plus a
  turn-scoped `BATCHING_NUDGE` at the end of `buildCurrentTimeNote()`.
- Checklists: `orchestrator/checklist.ts` → `buildChecklist()`; reinjection in
  `buildCurrentTimeNote()`; UI in `ChecklistWidget.tsx`.
- Fabrication guard: `verify/fabrication-detector.ts` → `detectFabrication()`/`scopeForContext()`;
  `verify/audit.ts` → `auditAssistantMessage()`/`buildAuditNoteMessage()`/
  `buildFindingsWarningBlock()`; wired in `loop.ts` via `runAudit()`/`applyAuditEnforcement()` at
  three exit points (truncation-failed, no-tool-calls, post-tool-results). UI:
  `MessageBubble.tsx`'s `VerificationBadge`.
- Bundled skills: `skills/bundledSkills.ts` → `skills/manager.ts`'s `seedBundledSkills()`/
  `seedSkillAssets()`. Tests: `skills-seeding-*.test.ts`, `frontmatter.test.ts`.
- Pawprints: `pawprints/manager.ts` (lifecycle/approval) → `bundler.ts` (esbuild) →
  `windowManager.ts` (window + CSP); `writeGuard.ts` enforces state-only direct writes.

## Gotchas and open follow-ups live in `GOTCHAS.md`

The two long reference sections that used to end this file now live in
[`GOTCHAS.md`](GOTCHAS.md) at the repo root. Anywhere above that says "see the caching gotcha",
"see the stall gotchas", "see the C3 gotcha", "see gotcha" or "see follow-ups" is pointing there.

**Non-obvious gotchas worth knowing before touching these areas** (first section of `GOTCHAS.md`) —
roughly twenty bullets, each recording counter-intuitive behavior learned from a real bug, a live
measurement or a shipped regression. Covered there: the four hard **prompt-caching** invariants
(never mark a `tool` message; mark the assistant turn's *last* `tool_call`, not its text; the
`tools` array must never change mid-conversation because it is hashed ahead of the system prompt;
freeze the system prompt for the conversation's life) plus the dead theories and the whole-session
verification greps; why `thinking` must never be merged into assistant `content` (it few-shots
serial tool calling) and how reasoning round-trips instead; the three layers of
**compaction-summary poisoning** defense; the two silent mid-task **stalls** (post-compaction and
post-audit) and the deliberately `finish_reason`-ungated truncation, empty-generation and
provider-refusal recovery; **fabrication-guard** internals (ledger recomputed *after* streaming,
audit notes that are `role: 'user'` but not user input, and C3's four precision gates —
authorship, multi-root resolution, numeric tokens, hostnames); `multi_write`'s deliberate argument
tolerance and the ledger mirroring it; never building **YAML frontmatter** by interpolation, plus
gray-matter's options-dependent content cache; the inert `.txt`-suffixed vendored `website-replica`
template and the load-bearing `.gitattributes` `eol=lf` pin on `skills/bundled/**`; **browser-tool**
deadlines, non-mutating `resize`, and pixel-area screenshot costing; the `data.dataUrl` cross-file
contract for images; the four-layer bounded-**diff** invariant behind the 61 MB session-log
incident; the renderer-only "writing…" placeholder and its three prune points;
`assertMutationAllowed` *returning* false rather than throwing (a silent sandbox escape);
fuzzy edit matching vs `read_file` line-number prefixes; tool JSON schemas being documentation
only; filename auto-sanitization for memory/skill/subagent names; `node-pty` packaging flags; and
the process-wide global workspace singleton.

**Known open follow-ups (not yet implemented)** (second section of `GOTCHAS.md`) — a third cache
breakpoint on the compaction-summary system message (Anthropic allows 4, we use 2); root-causing
the first-write cold-start cache miss, where every client-side hypothesis is now eliminated and it
looks like an upstream visibility artifact costing one extra prefix write per conversation; a
user-facing compaction-summary reset (UX + IPC, no channel yet); Mac auto-update
(code-signing/notarization) with Linux `.deb` intentionally update-less; per-tab workspace tracking
instead of the global singleton; MCP-style tool integration scaling (researched, not built); a live
wire capture to confirm how OpenRouter translates consecutive `role: 'tool'` messages; GitHub
(`gh` CLI) integration; and `system-prompt.test.ts`'s test-isolation weakness when run alone.

**Don't read `GOTCHAS.md` end to end** — it is long and dense, and most of it won't apply to what
you're doing. `grep` it for the area you're about to touch and read only the matching bullet, e.g.
`grep -n -i 'caching\|breakpoint' GOTCHAS.md`, `grep -n -i 'frontmatter' GOTCHAS.md`,
`grep -n -i 'diff\|sanitize' GOTCHAS.md`, `grep -n -i 'browser\|screenshot' GOTCHAS.md`.
