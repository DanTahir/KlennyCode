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
  - `src/main/agent/orchestrator/` — the core loop, split up: `system-prompt.ts`, `loop.ts` (turn
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

- System prompt: `orchestrator/system-prompt.ts` → `buildSystemPrompt()`. Per-turn dynamic content
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

## Non-obvious gotchas worth knowing before touching these areas

- **Prompt caching has three hard invariants, each established by a live ladder and each previously
  broken in a way that looked like an upstream miss.** `applyCacheControl` (`openrouter/caching.ts`)
  marks exactly two positions — the system message (fixed forever) and an advancing breakpoint (the
  *second*-to-last message, since the true last is the volatile trailing note) — and never anything
  interior. The mandatory procedure for any change here is the project skill
  **`caching-live-verification`**: unit tests cannot observe upstream matching behavior, so write a
  throwaway live-ladder script, run it, confirm read-back, delete it.
  1. **Never mark a `tool` message.** Boundary role predicted the outcome perfectly across every
     measured ladder and nothing else correlated: `assistant` boundary → exact read-back every
     time; `tool` boundary → miss or partial every time, because a `tool` message becomes an
     Anthropic `tool_result` block inside a user turn and appears never to produce a matchable
     entry (the write is still billed). This was also the mechanism behind the old
     "every-other-turn double-write". `applyCacheControl` therefore walks the advancing breakpoint
     backwards off any `tool` message. Known cost, by design: a breakpoint is a prefix *cut*, so
     walking back **defers** the trailing tool results into the next request's block rather than
     excluding them — bounded but not always small, since each result is capped at 40 000 chars
     (~10k tokens) by `compactToolResult`, so a wide parallel fan-out can defer tens of thousands
     of tokens by one request.
  2. **Mark the assistant turn's LAST `tool_call`, not its text.** OpenRouter forwards
     `cache_control` from an OpenAI-format `tool_calls[i]` object to Anthropic's `tool_use` block
     (live-verified, and genuinely **readable**, not just a billed write) — which is what makes a
     prose-free tool-calling turn markable at all. It also beats marking text, because Anthropic
     orders a turn as `[text, tool_use...]`, so a text marker cuts *before* the calls and strands
     `tool_calls.arguments` where big write/edit payloads live. Measured on claude-sonnet-5, same
     conversation, ~8k-token write payload:

     | marker on | cache write | uncached tail |
     |-----------|-------------|---------------|
     | text part | 7 074       | **8 483**     |
     | last tool call | 16 208 | **12**        |

     Mark the *last* call specifically — an earlier one cuts between calls and strands the rest.
     Rejected alternatives, both measured: a synthesized **empty** text part is silently ignored
     (no cache at all); a synthesized **space** works but needlessly changes model-visible content.
     This invariant is also why breakpoints used to be *dropped entirely* on ~15% of requests: a
     prose-free tool-calling turn has `content: ''` → zero content parts → the old
     `withCacheControlOnLastPart` returned the message untouched instead of failing, and the
     walk-back landed on exactly that message every normal step.
  3. **The `tools` array must never change mid-conversation — it is hashed AHEAD of the system
     prompt.** `getToolDefinitions`'s output *is* the request's `tools` block and providers
     serialize it before the system message, so a cached block (keyed on its entire preceding
     prefix) dies the moment that array changes, taking **every** breakpoint with it, including the
     fixed system one. It used to change once per task: `update_checklist` was hidden until
     `TabSession.activeChecklist` existed, so the first `create_checklist` call grew the array by
     one ~700-char definition — measured live as `cachedTokens=0` plus a full rewrite on the very
     next request *while the system message's `bp=` fingerprint was byte-identical* (the `bp=`
     hashes cover **messages only**, which is exactly how this hid behind "identical bytes, so the
     miss must be upstream"). The gate is gone (the tool is always offered; dispatch returns
     `no_active_checklist`). Every remaining gate derives from settings, tab kind or subagent type,
     all fixed for a conversation's life; **never add one driven by per-turn conversation state.**

  **Dead theories — each looked compelling and cost a build; do not re-chase.** (a) "an interior
  `cache_control` marker invalidates the prefix" — refuted by a rung that read its block back
  exactly while an interior marker had flipped, so interior churn is benign; (b) "the
  string-vs-parts shape flip at the boundary breaks the match" — refuted by assistant-boundary hits
  that matched exactly *across* that flip; (c) content drift — the content-only hash was
  byte-identical at every repeated index in every session. Also note a real cold-start effect that
  our placement does **not** control: a session's first few requests can read back 0 with a
  byte-stable prefix *and* a stable tools array, then every later transition is exact.

  **Verify whole-session, never by eyeballing the tail** (both must be 0, both scoped to one
  session): `grep 'includeLastMsgBreakpoint=true' process.log | grep -c 'breakpointsAt=\[0\] '`
  (dropped breakpoints) and `awk '/App session started \(vX\.Y\.Z/{f=1} f' process.log | grep -c
  ':tool:parts'` (tool boundaries). Also
  `grep -o 'tools=n=[0-9]* names=[a-f0-9]*' process.log | sort -u` — more than one distinct value
  in a session means the tools array is still mutating (`names` = a tool appearing/disappearing,
  our bug; `defs` = an edited description/schema, legitimately once per build). `fingerprintTools`
  (`cacheDiag.ts`) also `console.warn`s once when it changes mid-conversation. Pinned by
  `tests/tools-cache-stability.test.ts` and `cacheDiag.test.ts`, both with positive controls so
  they cannot pass vacuously.
- **Never merge `thinking` into assistant `content` — it few-shots the model into serial tool
  calling.** Replaying private reasoning as assistant *content* presents it as something the model
  said out loud, so its own history reads as a worked example of "think a paragraph, narrate a
  sentence, call exactly one tool" — and models imitate the transcript they are shown. This caused
  the one-`read_file`-per-turn rhythm despite parallel dispatch working. Reasoning now rides its own
  wire fields, with four non-obvious parts: (1) **structured beats plaintext** —
  `reasoning_details` is preferred over the plaintext `reasoning` fallback because
  encrypted/summarized reasoning carries signatures that flattening destroys, so
  `mergeReasoningDetails()` treats blocks as opaque (concatenating only `text`/`summary`/`data` by
  (index, type), replacing signatures/ids wholesale, passing unknown provider fields through);
  (2) `reasoningDetails` rides the `'done'` chunk and is read **independently of `finishReason`**;
  (3) **rejection is remembered per model** — on a 400 `client.ts` strips the fields, retries once,
  and adds the model to a process-lived `reasoningRejectedModels` set, else the recovery retry fires
  every turn forever, strictly worse than never round-tripping; (4) a **reasoning-only** turn
  (reasoning, no text, no tool calls) is deliberately dropped on the wire — there is no content to
  attach reasoning to, empty-content assistant messages are rejected by some providers, and such a
  turn has no effect on the conversation anyway. Pinned by `tests/reasoning-roundtrip.test.ts`.
- **Compaction-summary poisoning — fixed three layers deep, covering tool-call args/results too.** A
  fabricated "I did X" can otherwise be folded into `compactionSummary` and replayed as trusted fact
  forever. (1) *Prevention*: `TRUTHFUL_NARRATION_NOTE` (`plan/manager.ts`). (2) *Mitigation*:
  `summarizeMessages()`'s prompt (`openrouter/client.ts`) tells the summarizer to trust only literal
  `[called toolName(...)]` markers, never prose. (3) *Structural enforcement*:
  `transcriptLineForMessage()` (`compaction/compactor.ts`) runs `sanitizeFabricatedMarkers()` over
  free-text/thinking **and** over JSON-stringified tool-call `args` and tool-result `result`
  payloads — a fetched page, a file's own contents or an `old_string` can equally contain the
  literal `"[called "` substring — rewriting prose matches to `"[not-a-real-call: "`. Only the
  structurally-generated wrapper is left untouched: it is the one unforgeable signal. Covered by
  `compaction.test.ts`, including the args/result regression test.
- **Two silent mid-task stops needed structural fixes, not prompt wording — and they share one
  shape.** Both cases inject a harness message mid-turn that the model reads as a stopping point,
  replying text-only with no tool calls, indistinguishable from a finished task:
  - *Post-compaction*: a one-shot `justCompacted` cue reaches the model for exactly ONE request
    with no retry, and asking for an acknowledgment primed the very text-only shape that triggers
    the stop.
  - *Post-audit*: the fabrication guard's notice closed with "do exactly one of the following … and
    nothing else", which read literally — and correctly — forbids tool calls in the correction
    reply. Worst on resolution (b) ("the claim was accurate, here is the evidence"), where there is
    nothing to redo. Branch (b) now says to cite the evidence **and keep going in the same
    message**.

  `shouldResumeAfterCompaction()` and `shouldResumeAfterAuditCorrection()` (`turnControl.ts`) back
  both harness-side with the same deliberately conservative shape: require an unfinished checklist
  (no evidence of remaining work → don't pressure the model to invent some), bail if a correction is
  being forced on this very step (no double recursion), and allow one resume each
  (`MAX_COMPACTION_RESUMES` / `MAX_AUDIT_RESUMES` = 1). `compactedThisStep` must be *this* step's
  result — the caller carries the resume count across the recursion because `maybeCompact` returns
  false on the resumed step. Both nudges fire exactly where pressure turns a stall into a
  fabrication, so both keep an explicit escape hatch and forbid claiming unverified progress. Pinned
  by `tests/stall-recovery.test.ts`.
- **Output-truncation and empty-generation recovery are both ungated from `finish_reason`.** A
  generation cut off at the output token limit can leave tool-call arguments as invalid JSON
  *without* the provider reporting `finish_reason: 'length'`, so `turnControl.ts` treats unparseable
  args as truncation regardless (`DEFAULT_MAX_COMPLETION_TOKENS = 16_000` when a model doesn't
  report its own cap, `MAX_TRUNCATION_RETRIES = 3`). The retry note is *informed*, not a bare "try
  again": it states that nothing ran and no file was created, then tells the model to split batches,
  prefer `multi_edit` over `multi_write` for partial changes (fragments cost far fewer output tokens
  than whole files), and skip preamble so the budget goes to arguments. The same distrust of that
  label drove `isTruncatedEmpty` → **`isEmptyGeneration`**: a generation with no text *and* no tool
  calls used to be retried only on `finish_reason: 'length'`, so every other empty shape (`'stop'`,
  or none at all) was accepted as a **finished task** and the turn ended silently mid-work. The
  check now ignores the label entirely, and its retry note is deliberately cause-agnostic — it must
  not assert a token limit the provider never reported.
- **The fabrication guard's ledger must be recomputed AFTER streaming, never before**: it has to
  include the message's *own* tool calls, or the first legitimate use of any tool gets flagged as
  unsupported.
- **Audit notes are `role: 'user'` but are NOT user input**: they have to be, because
  `toORMessages()` only emits system messages for the prompt/summary prefix. Everything that cares
  about "what the user last said" must skip `isAuditNote` — currently `buildTurnLedger()`'s
  turn-boundary walk, `MessageBubble`'s user styling, and the compaction transcript (which labels
  them `system-audit-note (generated by the harness, not the user)` so a summary can never record
  "the user demanded a retraction"). Tab titling is safe only because it derives from the user's
  typed text in `runUserTurn` before the loop runs.
- **C3 (artifact existence) needs four precision gates, every one added after a live false
  positive.** C3's premise is "this message claims *it* brought a file into being"; each gate below
  exists because a *truthful* message got hard-flagged in real use.
  1. **Authorship.** A creation verb alone is not a claim of authorship.
     `AUTHORSHIP_CUE_RE`/`ELIDED_AUTHORSHIP_RE` require a first-person subject ("I created X") or an
     elided-subject clause opener ("Created X", "- Wrote X"), and `NON_AUTHORSHIP_RE` bails out on
     passive/attributive/metadata framing ("was generated", "created by esbuild",
     `settings.json (written 14:22)`, "mtime"/"last modified"). The trigger was prose reporting a
     file's **mtime** — someone else's past write, asserting nothing about this message.
  2. **Multi-root resolution.** `DetectorInput.extraRoots` (fed `[userDataDir(), globalKlennyDir()]`
     by `loop.ts`) flags a bare/relative path only when it's missing under *every* plausible root.
     The agent constantly and correctly discusses its own `settings.json`, `SOUL.md` and memory
     notes, which live outside the workspace entirely; resolving those against the workspace alone
     hard-flagged a file that genuinely existed.
  3. **Numeric tokens.** `PATH_TOKEN_RE`'s extension class is `[A-Za-z0-9]{1,8}` — digits allowed —
     so `$78.70` parses as a file `78.70` with extension `70`. `looksLikeRealPath()` requires an
     alphabetic character in the token *and* (when present) its extension, rejecting money amounts,
     version strings (`5.1.2`), sub-second durations (`1.29`) and percentages while still checking
     real digit-bearing extensions like `archive.7z`.
  4. **Hostnames.** A bare domain matches `PATH_TOKEN_RE` exactly like a relative file path, so
     "I generated the report and ran the gate against live dropbox.com" was hard-flagged for
     creating a file named `dropbox.com`. `looksLikeHostname()` rejects a separator-free token whose
     final segment is a known TLD (`TLD_RE`); anything path-qualified (`dropbox.com/index.html`)
     still checks normally, and script-style extensions that happen to also be TLDs — `.sh`, `.pl`,
     `.py` — are deliberately excluded from the TLD list. This one bit hardest during
     `website-replica` runs, which discuss the source URL constantly.

  Do not "simplify" any of these back into the bare `CREATION_CUE_RE` test — each has a named
  regression test in `fabrication-detector.test.ts` / `stall-recovery.test.ts`, including positive
  controls (`warehouse-allocator/manage.py`, `archive.7z`, `build.sh`, `dropbox.com/index.html`)
  that must keep firing so a future fix can't pass by simply blinding C3.
- **`multi_write`'s argument tolerance is the feature, not incidental defensiveness.** The motivating
  failure was an agent repeatedly "trying to batch write" and falling back to one file at a time, so
  the arg shape a model sends is the weak link. `normalizeFilesArg` (`tools/file-ops.ts`) accepts —
  and `tests/multi-write.test.ts` pins — a real array; a JSON-*string*-encoded array/object; a
  single unwrapped `{path, content}`; a `path -> content` **map**; per-entry key aliases
  (`file`/`file_path`/`filename`/`name`, `contents`/`text`/`body`/`source`/`code`); and `content` as
  a line array (joined with `\n`), a number/boolean, or an object (pretty-JSON). Two deliberate
  asymmetries vs `multi_edit`: there is **no** top-level default `path` (every entry targets a
  different file, so a shared default is meaningless — though a bare top-level `{path, content}` is
  accepted as the degenerate single-file call); and missing/null `content` is a **hard error** rather
  than coerced to `''`, because `multi_write` overwrites and silently truncating a file is the one
  failure mode worth being strict about (an explicit `''` is still a valid empty file). The ledger
  (`orchestrator/ledger.ts`) must mirror enough of this tolerance in `collectPathsFromArgs` (alias
  keys + map form), or a file genuinely written via an odd shape gets hard-flagged by C3.
- **Never build YAML frontmatter by string interpolation — and beware gray-matter's content cache.**
  `writeSkill`/`writeSubagentType` used to interpolate `name:`/`description:` lines, so any YAML
  metacharacter in a model-supplied description (colon-space, `#`, `[`, `*`, `&`, `!`, `@`, `%`, a
  leading `-`, an embedded newline, a bare `yes`/`123`) produced an unparseable file. Both writers
  now go through `stringifyFrontmatter` (`agent/frontmatter.ts`), and every read path
  (`scanSkillsDir`, `readSkillBody`, `scanAgents`) uses `parseFrontmatterSafe`, which never throws
  and degrades to line-wise salvage. Two non-obvious parts: (1) `gray-matter` memoizes by content
  string but **only consults that cache when called with no options argument**, so a malformed file
  throws on the first `matter(raw)` then silently returns `{data: {}, content: raw}` on the second —
  exactly why a broken skill appeared in the catalog with an *empty description* and a dirname
  fallback instead of failing loudly; always call `matter(raw, {})`. (2) `scanAgents` needs a
  per-file try/catch — one bad file used to abort the whole directory scan. Covered by
  `frontmatter.test.ts`, including a guard that every bundled SKILL.md parses with a non-empty name
  and description.
- **Vendored skill template files must stay inert**: the `website-replica` template lives under
  `skills/bundled/website-replica-template/` with **`.txt` appended to every filename**, and that
  suffix is load-bearing. Under real extensions inside `src/main/`, `tsconfig.node.json` (which
  includes `src/main/**/*`) would type-check the template against *this* repo's config — where
  `next`/`react`/`vitest` don't resolve — and `bun test` would auto-discover the template's own
  `*.test.ts` files into this suite. `websiteReplicaTemplate.ts` strips the suffix when mapping
  destinations, `src/main/global.d.ts` therefore needs `declare module '*.txt?raw'`
  (tsconfig.node.json doesn't pull in `vite/client`), and a manifest-drift test pins the invariant
  both ways. Because `?raw` inlines content into `out/main/index.js`, no electron-builder
  `files`/`extraResources`/`asarUnpack` entry is needed. Vendor by copying bytes (`cp`), never by
  retyping.
- **`.gitattributes` pins `skills/bundled/**` to `eol=lf`, and that pin is load-bearing.** This repo
  is developed with `core.autocrlf=true`, so without the pin git rewrites those files to CRLF in the
  working tree — and their bytes are both inlined verbatim by `?raw` into what gets seeded to
  `~/.klenny/skills/` *and* content-hashed into `skills-seed-state.json`. Because
  `seedBundledSkills()`/`seedSkillAssets()` skip any file whose on-disk hash differs from the record
  (assuming the user edited it, and a user's edits are never clobbered), an EOL-only flip — a byte
  difference with *zero* content difference — makes a pristine seeded copy look edited and
  **permanently** stops that install from receiving bundled-skill updates. `legacyVariants` matching
  fails the same way. Three traps when auditing this by hand: (1) `diff --strip-trailing-cr` (and
  plain `diff -q`) reports EOL-only differences as **identical**, so use `cmp` when byte equality is
  the actual question; (2) Git Bash's `grep -c` with a carriage-return pattern reports **0** on a
  genuinely CRLF file — count with `tr -cd` piped to `wc -c` instead; (3) to renormalize an
  already-CRLF working-tree file, `git add --renormalize` followed by `git checkout` or
  `git checkout-index -f` is a silent **no-op**, because `git add` refreshes the index stat cache to
  match the CRLF file and checkout then believes it is already current. Delete the file first, then
  `git checkout-index -f` it back (the smudge filter applies `eol=lf`), and restore the index with
  `git reset -- <paths>`. Never hand-rewrite line endings with a shell redirect.
- **Browser tool: unbounded Playwright calls can hang a turn forever.** `page.evaluate` and friends
  have no inherent timeout, so one bad page could stall a turn indefinitely; every such call goes
  through `raceDeadline(promise, ms, label, signal)` (`tools/browser.ts`), e.g. `page.evaluate` under
  `EVALUATE_TIMEOUT_MS`. Keep new actions wrapped the same way. Two more points there:
  - **`resize` is deliberately non-mutating** — it reframes our own viewport and changes nothing on
    the page, like `navigate`, so it needs no approval. `resolveViewport()` validates args *before*
    `ensureSessionAndPage` (mirroring `doClick`'s ref check) so a typo fails instantly instead of
    first downloading ~150 MB of Chromium — which is also what makes it unit-testable with no
    browser. Width alone is valid (height completed from a fallback), because the real request is
    almost always "show me this at a phone width". Note `page.setViewportSize` resizes the viewport,
    not the OS window chrome, so a headed window can look wider than what's rendered.
  - Screenshot token cost is estimated from **viewport pixel area** (`w*h/750`), not byte length —
    vision models bill by pixels, and the old byte-based math advertised a 70 KB capture as "~96
    tokens". `snapshot` sends `tree` only (shipping both `elements` and `tree` double-serialized the
    same data, halving usable page size), capped at `MAX_SNAPSHOT_ELEMENTS = 250` with an **in-band**
    "N more omitted" line, since a silent slice is indistinguishable from "the page has no such
    element".
- **`data.dataUrl` is a cross-file contract, and getting the key wrong fails silently.** A `tool`-role
  message can't carry an image part, so `loop.ts` lifts `result.data.dataUrl` out of a tool result
  into a separate `ImageBlock` and deletes it from the JSON. `doScreenshot` returned the blob under
  `screenshotDataUrl` instead — a key nothing lifts — so ~90 KB of base64 stayed *inside* the
  payload, hit `compactToolResult`'s hard 40 000-char cut (`agent/messages.ts`) and reached the
  model as chopped, invalid base64 with no image attached. Any new tool that wants the model to
  actually *see* an image must use exactly `dataUrl` (plus `imageUiOnly` if the user should see it
  but it shouldn't be re-uploaded), and should pin it with a test: the broken shape still looks like
  a valid tool result, it just quietly becomes garbage. Fixed via `screenshotResultData()`.
- **A diff is a bounded *preview*, never raw file content — this once made a session log
  unloadable.** `delete_file` on a ~20 MB binary `.mov` did `readFile(abs, 'utf8')` (which for
  binary **never throws** — it yields U+FFFD + control bytes, so "did the read throw" is not a
  binary check), handed the mojibake to `makeDiff`, and stored the resulting ~20 MB unified diff in
  `result.data.diff`. `SessionStore.persist()` wrote it verbatim: the workspace session file hit
  61 MB, froze the app on its loading screen, froze external editors, and a sibling `delete_file`
  died with `Maximum call stack size exceeded` (jsdiff is recursive). The model never saw any of it
  (`compactToolResult` caps the wire at 40 000 chars) — it was purely a persistence/UI failure.
  Four independent layers now hold the invariant, and none is redundant:
  1. `makeDiff` (`tools/diff.ts`) is **total and bounded**: `looksBinary()` (NUL/U+FFFD decisive,
     else control-char density in an 8 KB sample; tab/LF/CR excluded so CRLF source isn't flagged)
     → `diffOmitted()` placeholder; `MAX_DIFF_INPUT_CHARS` per side; `try/catch` around
     `createTwoFilesPatch`; output clamped by chars/lines/per-line with **in-band** "N more
     omitted" notes. `joinDiffs()` caps combined batch diffs. `diffOmitted()` keeps the
     `--- `/`+++ ` header shape so `DiffViewer` still renders it and callers need no special case.
  2. `readTextForDiff()` (`tools/file-ops.ts`) stats **before** reading; above the cap it reads
     only a 64 KB EOL probe (all an overwrite still needs from old content) and returns
     `omittedReason`. Used by `delete_file`, `write_file`, **and** both `approval-previews.ts`
     branches — the preview path had the identical bug and shipped the diff over IPC.
  3. `session/sanitize.ts` is the tool-agnostic backstop at persist **and load** time (an
     already-poisoned file self-heals: clamped on read, rewritten once). It clamps every string and
     evicts `result.data` from the **oldest** tool calls over a per-tab budget, which also covers
     slow accumulation of many individually-legal diffs. **It must stay PURE/deep-copying**: the
     live in-memory `TabSession` feeds `toORMessages()`, so clamping in place would silently
     rewrite tool-call args the model already sent. Image `dataUrl`s are deliberately exempt —
     truncating one corrupts a thumbnail instead of saving space.
  4. `DiffViewer.tsx` caps rendered lines/line width: one `<div>` per line means an unbounded diff
     is an unbounded DOM, and pre-fix sessions still hold huge diffs on disk.
  Pinned by `diff-safety.test.ts` + `session-sanitize.test.ts` (including negative controls so a
  future "simplification" can't pass by blinding the binary sniffer).
- **The "writing…" placeholder is renderer-only, and its three prune points are all load-bearing.**
  Tool-call arguments used to stream invisibly: `client.ts` accumulated `delta.tool_calls` and
  yielded nothing until `[DONE]`, so a big `write_file`/`multi_write` payload produced *zero*
  observable output for many seconds and read as a frozen app. The fix relays fragments for UI only
  — mid-stream JSON is invalid by construction, so a `'tool_call_delta'` must never be executed or
  replayed to a provider; the authoritative calls still arrive in the single end-of-stream
  `'tool_calls'` chunk. Placeholders are never persisted and never sent to the model, and because a
  stream can end mid-arguments (abort, provider error, truncation) without a matching
  `tool_call_start`, `dropWritingPlaceholders()` runs at **`message_end`, `error` AND `turn_end`**
  (the last is the Stop/abort backstop, which can unwind with no `message_end`) or a card pulses
  "writing…" forever. Two more non-obvious bits: `sniffWritingTarget()` erases `content`/`new_string`
  values *before* scanning, because such a value routinely contains a literal `"path":"..."` (this
  agent writes code about paths) which would otherwise be shown as the target and inflate a batch's
  file count; and the throttle is **time-only** — a char-delta threshold would fire constantly at
  real streaming rates and defeat the rate limit entirely. Note that within one step a provider
  writes calls *sequentially* and they all launch together afterwards, so "writing" legitimately
  appears one call at a time, then all flip to `'queued'` at once. Pinned by
  `tests/tool-writing-status.test.ts`.
- **`assertMutationAllowed` RETURNS false — it does not throw — so a bare call inside a `try/catch`
  is a silent sandbox escape.** `parallel_write`'s Phase 1 validated each path with
  `resolveWorkspacePath(p, root)` followed by a bare `assertMutationAllowed(resolved, root)` in the
  same `try` block. That reads like a guard but is a no-op: only `resolveWorkspacePath` throws (and
  only for a structurally invalid path — empty/non-string, or relative with no workspace open),
  while a genuine out-of-sandbox path merely *returns* `false`. `../escape.ts` therefore resolved
  outside the workspace and was accepted. Every caller must branch on the return value, exactly as
  `writeFileTool` does. Note `resolveWorkspacePath` does **no** `..`-stripping; it is a plain
  `resolve(base, rel)`, so the boolean check is the only thing standing between a relative path and
  an escape. Caught by `parallel-write.test.ts`'s out-of-sandbox case, which also asserts **zero**
  worker calls were made — the "an invalid call costs nothing" half of the pre-spend guarantee.
- **Fuzzy edit matching** (`edit-match.ts`): handles CRLF, escaped chars and em-dash/hyphen variants
  — but line-number prefixes from `read_file` output are NOT in the real file bytes; never include
  them in `old_string`.
- **Tool JSON schemas are documentation only**: no ajv/zod validation at dispatch time. Real
  enforcement lives in each tool's implementation, and models sometimes send JSON-string-encoded
  nested arrays instead of native arrays — handle that explicitly.
- **Memory/skill/subagent names auto-sanitize illegal filename chars** (`/\:*?"<>|`, control chars,
  leading dots) rather than rejecting — the tool result reports the sanitized name so the model
  doesn't retry the same invalid one.
- **node-pty packaging**: set `npmRebuild: false` + `asarUnpack: ['**/node-pty/**']` in
  electron-builder config; a normal postinstall rebuild fails hard without VS Build Tools even when
  working prebuilt binaries already exist.
- **Global workspace singleton**: `getWorkspace()`/`setWorkspace()` is one process-wide value, not
  per-tab — a scheduled task targeting another workspace can transiently affect a live tab's
  workspace-scoped tool resolution if timings collide (accepted limitation, see follow-ups).

## Known open follow-ups (not yet implemented)

- A **third** cache breakpoint on the compaction-summary system message. Anthropic allows **4**
  explicit breakpoints and we use only **2** (system + advancing). The compaction summary (index 1)
  is safe *because its position is fixed*, but any new breakpoint must obey the caching invariants:
  fixed positions only, never on a `tool` message.
- Compaction-summary manual reset (UX + IPC) — a user-facing "reset conversation summary" button for
  recovery if a summary ever ends up wrong. Not required for the poisoning fix (that's done); purely
  recovery UX. No IPC channel exists yet.
- Mac auto-update (needs code-signing/notarization in CI); Linux `.deb` has no update path by design.
- Per-tab workspace tracking (currently a single global singleton).
- MCP-style tool integration scaling — researched (OpenClaw/OpenCode patterns), not built.
- Confirming OpenRouter's *upstream* translation of consecutive `role: 'tool'` messages. Anthropic
  documents splitting batched tool results across separate/interleaved messages as the #1 cause of
  degraded parallel tool use. Our own wire output is verified correct and pinned by a regression test
  (results strictly adjacent, ids in order, nothing interleaved), but whether OpenRouter coalesces
  them into a single Anthropic `user` turn has only been reasoned about from the docs, never observed
  on the wire. Needs a live capture.
- GitHub integration (`gh` CLI connect/browse/clone) — plan drafted, not started.
- `system-prompt.test.ts` test-isolation weakness (predates the fabrication guard): the "sections are
  separated by a blank line" test passes in a full `bun test` run but fails when the file runs alone,
  because it picks up the real `~/.klenny` global skills instead of its temp fixtures. Harmless
  today, but that file is unreliable in isolation.
