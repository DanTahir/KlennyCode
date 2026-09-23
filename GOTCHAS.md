# Klenny Code — non-obvious gotchas and open follow-ups

Extracted from `KLENNY.md` so the main project-memory file stays short. Every bullet below records
behavior that is counter-intuitive and was learned from a real bug, a live measurement, or a
shipped regression — so the details are load-bearing, not background reading.

**Don't read this file end to end.** It is a long reference, and reading all of it burns context on
areas you aren't touching. Instead `grep` it for whatever you're about to work on and read only the
matching bullet(s), e.g.:

```bash
grep -n -i 'caching\|cache_control\|breakpoint' GOTCHAS.md
grep -n -i 'frontmatter\|gray-matter' GOTCHAS.md
grep -n -i 'diff\|binary\|sanitize' GOTCHAS.md
grep -n -i 'browser\|playwright\|screenshot' GOTCHAS.md
grep -n -i 'eol\|gitattributes\|bundled' GOTCHAS.md
```

When `KLENNY.md` says "see the caching gotcha", "see the stall gotchas", "see the C3 gotcha" or
"see follow-ups", it means a section of this file.

## Non-obvious gotchas worth knowing before touching these areas

- **Prompt caching has four hard invariants, each established by a live ladder and each previously
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
  4. **Freeze the system prompt for the conversation's life — never rebuild it from live disk
     state.** `buildSystemPrompt()` runs on *every* step and reads the auto-memory index, skills
     catalog and `SOUL.md` off disk, so before the fix any `write_memory`/`write_skill` moved the
     **system message** — the one fixed breakpoint every other block is keyed on — and wiped the
     entire conversation's cache. Measured in production beforehand: four mid-session transitions
     where `#0:system`'s `chars`+`wire` changed while `tools=` stayed identical, each
     `cachedTokens=0` with full re-writes of **87 303 / 89 070 / 122 275 / 188 848** tokens.
     `orchestrator/prompt-snapshot.ts` now snapshots the prompt per tab, keyed by
     `buildPromptConfigKey()` over **deliberate user-driven config only** (mode, shellId, tab kind,
     subagent identity, Assistant tool availability) — disk content drift never rebuilds it.
     The freshness signal was *moved, not dropped*: `PROMPT_PREFIX_STALE_NOTE` rides the free,
     always-uncached trailing note and tells the model to `read_memory` for current state. Live
     negative control on claude-opus-5 — appending a single 170-char auto-memory line (system
     16 985 → 17 155 chars, `wire` 510a3f6a → 425a3b2d) took rung 4 from clean read-back to
     `cached=0` plus a **10 090**-token re-write (shortfall 9 067), with rungs 2/3/5 at shortfall
     **0** on either side. Putting freshness back into the cached prefix *is* the bug.

  **Dead theories — each looked compelling and cost a build; do not re-chase.** (a) "an interior
  `cache_control` marker invalidates the prefix" — refuted by a rung that read its block back
  exactly while an interior marker had flipped, so interior churn is benign; (b) "the
  string-vs-parts shape flip at the boundary breaks the match" — refuted by assistant-boundary hits
  that matched exactly *across* that flip; (c) content drift — the content-only hash was
  byte-identical at every repeated index in every session. Also note a real cold-start effect that
  our placement does **not** control: a session's first few requests can read back 0 with a
  byte-stable prefix *and* a stable tools array, then every later transition is exact. Production
  shows this as a precise shape — r1 wrote 47 652, r2 read **0** and re-wrote 47 951 (= 47 652 +
  299), then r3 onward read back the preceding write exactly, forever; identically in a second
  conversation (20 143 → miss → re-wrote 20 547 → read 20 547), with r1→r2 seconds apart inside a
  single turn. Every explanation tried is now **eliminated by measurement or argument — do not
  re-chase**: TTL expiry (would correlate with *typing pauses*, not a clean always-miss-r1→r2);
  prefix byte drift (`wire=` identical r1 vs r2 in both conversations); a manual `provider.order`
  disabling sticky routing (no `providerPreference` is set at all); `session_id` being a fake or
  unsupported field (it is real and documented, and `client.ts` already sends `sessionId: tab.id`
  → `body.session_id` correctly — that code is **not** dead); a provider-routing flip; the
  tool-message shape spanning the transition; and prefix size. The last three were tested on a live
  opus-5 ladder built to reproduce the production shape (real restricted tool defs, an assistant
  `tool_call` + `tool` result between rungs, one `session_id`): at **52 445** prompt tokens — larger
  than production's 48 048 — rung 2 read back rung 1's write **exactly** (51 874, shortfall 0) with
  `provider=Claude` stable across every rung. The cost is therefore bounded at one extra prefix
  write per conversation and self-corrects from r3, and there is no code fix to make without a
  reproduction.

  **Verify whole-session, never by eyeballing the tail** (both must be 0, both scoped to one
  session): `grep 'includeLastMsgBreakpoint=true' process.log | grep -c 'breakpointsAt=\[0\] '`
  (dropped breakpoints) and `awk '/App session started \(vX\.Y\.Z/{f=1} f' process.log | grep -c
  ':tool:parts'` (tool boundaries). Also
  `grep -o 'tools=n=[0-9]* names=[a-f0-9]*' process.log | sort -u` — more than one distinct value
  in a session means the tools array is still mutating (`names` = a tool appearing/disappearing,
  our bug; `defs` = an edited description/schema, legitimately once per build). `fingerprintTools`
  (`cacheDiag.ts`) also `console.warn`s once when it changes mid-conversation. Pinned by
  `tests/tools-cache-stability.test.ts` and `cacheDiag.test.ts`, both with positive controls so
  they cannot pass vacuously. For a suspected cold-start or routing miss, `[cache] usage` now
  carries `provider=` (the upstream endpoint that actually served the request) and `gen=` (the
  generation id, for authoritative `/api/v1/generation` lookup), and `[cache] request` carries
  `sid=` (the sticky-routing key we sent):
  `grep -o 'provider=[^ ]*' process.log | sort -u` returning more than one value within a session
  is a routing flip, which is a *guaranteed* total miss because an Anthropic cache lives on the
  endpoint that wrote it. Without those fields a flip and a genuine upstream cold start are
  **indistinguishable** in the log — both show `cachedTokens=0` with a byte-identical `bp=` prefix
  and an unchanged `tools=`, which is exactly what stalled two investigations.
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
- **A provider REFUSAL used to be indistinguishable from an empty generation.** `client.ts`'s SSE
  delta type carried `content`/`reasoning`/`reasoning_details`/`tool_calls` but **not `refusal`**,
  and a refused stream carries **no usage chunk** — so a content-filtered request reached the
  orchestrator as no text + no tool calls, `isEmptyGeneration` fired, and the turn burned all
  `MAX_TRUNCATION_RETRIES` on requests **guaranteed** to be refused again (the *prompt* is what's
  blocked, so retrying is pure cost), ending with "the model repeatedly returned an empty
  response … usually a provider-side problem" — the wrong cause, while the provider's own
  explanation was discarded. Found live: Anthropic refused a probe's repetitive filler text with
  `finish_reason: content_filter` + `refusal: "…violate Anthropic's Terms of Service restrictions
  on reverse engineering or duplicating model outputs"`. `describeProviderRefusal()` (exported from
  `openrouter/client.ts`, pinned by `tests/provider-refusal.test.ts`) now yields a `'error'` chunk —
  which `loop.ts` already turns into a visible, turn-ending error — from **both** stream exits
  (`[DONE]` *and* the end-of-body/no-sentinel path). Three deliberate constraints: it is gated on
  having produced **nothing usable** (a provider may emit a refusal alongside partial text or tool
  calls, and dropping real content for a notice would be a regression); a bare `content_filter`
  label reports but **never fabricates a quoted reason**; and a genuinely empty generation must
  still fall through to the retry path — that last one is a named negative-control test.
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
- **node-pty's macOS `spawn-helper` ships without its execute bit**: node-pty 1.1.0's npm tarball
  has `prebuilds/darwin-*/spawn-helper` at mode 0644 and its postinstall never fixes it, so every
  `pty.spawn()` on macOS fails with `posix_spawnp failed` (surfaced as a blank terminal panel). This
  happens with dev `bun install` too, not just packaged builds, and has nothing to do with
  signing or quarantine. Two layers fix it: `agent/scripts/after-pack.cjs` (electron-builder
  `afterPack`; chmods 755 and *fails the mac build* if no helper is found) and
  `main/ptySpawnHelper.ts` (runtime self-heal before the first spawn, no-op on Windows). Don't
  remove either when bumping node-pty without re-checking the tarball's modes.
- **minimize-to-tray must not swallow real quits**: `wireMinimizeToTray`'s `close` handler cancels
  the close unless `isQuitting` is set, and every quit path goes through window `close`. macOS
  ⌘Q, Dock → Quit, logout and `autoUpdater.quitAndInstall` don't pass through the tray menu, so
  `index.ts`'s `before-quit` calls `markAppQuitting()` first. Without it they hid the window and
  silently aborted the quit, leaving a process only Force Quit could end. `app.on('activate')`
  likewise re-shows the (hidden) `getMainWindow()` rather than testing "no windows exist".
- **GUI-launched macOS/Linux apps get a bare PATH**: Finder/Dock/launchd start the app with
  `/usr/bin:/bin:/usr/sbin:/sbin`, so `run_command`, the agent's spawned processes and anything
  else inheriting `process.env` can't find Homebrew, nvm, Volta, bun or `~/.local/bin` tools.
  `main/loginShellPath.ts` runs the user's login shell once at startup (`-i -l -c`, output wrapped in
  markers so rc-file banners can't corrupt it, hard timeout, never rejects) and merges **only PATH**
  into `process.env` (login entries first, existing ones kept, deduped). It deliberately does not
  import the rest of the login env: session-only vars would leak into every child. `index.ts`
  starts the probe before `whenReady` and awaits it before `registerIpcHandlers()`, so the first
  terminal/`run_command` already sees the merged PATH (about 0.7–1 s measured). Skipped on Windows,
  where GUI apps inherit the real PATH.
- **`Menu.setApplicationMenu(null)` kills ⌘C/⌘V/⌘X/⌘A on macOS**: on macOS those shortcuts are
  dispatched only through the application menu's Edit roles, so with no menu they silently do
  nothing in text fields. `main/menus.ts` installs a real App/Edit/View/Window menu on darwin only.
  Windows/Linux keep `null` (no menu bar), because Chromium handles Ctrl+C/V/X/A there natively.
  Right-click menus are attached to every window's `webContents` (main + Pawprints) on all
  platforms via `attachEditContextMenu`. The terminal is special: xterm draws its own selection, so
  the generic `context-menu` event can't see it. The renderer sends the selection over
  `terminal:contextMenu` and handles Paste through `xterm.paste()`, never a raw PTY write, so
  bracketed-paste mode is preserved. Template content lives in pure `menuTemplates.ts` (unit-tested);
  the shared `tests/testElectronMock.ts` must export `Menu`/`clipboard`, or every test that loads
  `menus.ts` fails at link time with "Export named 'clipboard' not found".
- **Global workspace singleton**: `getWorkspace()`/`setWorkspace()` is one process-wide value, not
  per-tab — a scheduled task targeting another workspace can transiently affect a live tab's
  workspace-scoped tool resolution if timings collide (accepted limitation, see follow-ups).

## Known open follow-ups (not yet implemented)

- A **third** cache breakpoint on the compaction-summary system message. Anthropic allows **4**
  explicit breakpoints and we use only **2** (system + advancing). The compaction summary (index 1)
  is safe *because its position is fixed*, but any new breakpoint must obey the caching invariants:
  fixed positions only, never on a `tool` message.
- Root-causing the **first-write cold-start miss** — r1's cache write is never read back by r2,
  costing one extra full prefix write per conversation (self-corrects from r3). **The observational
  next step has now been taken and it denies the routing-flip hypothesis**: `/api/v1/generation` on
  both gen ids returned the same `endpoint_id` (`2edf66f3-…`), same `provider_name`,
  `data_region: global`, `native_tokens_cached: 0` on both — and the r1/r2 request lines are
  byte-identical (`bp=#0:system … chars=81760 wire=6489eef6`) with the same `tools=` hash and the
  same `sid=`. A second live round then eliminated five more hypotheses (routing arms interleaved
  9/9 HIT; the 1→2 marker transition; a 67k block — larger than production's 43 567 — at a 0.6 s
  gap; the same at a 60 s gap, so it is *not* size-dependent visibility latency; and a faithful
  replica with the real tool array plus an `on=call` rung-2 marker, HIT with shortfall 0). The one
  datum that reframes it: `rid=r18` later read `cachedTokens=43567` — *exactly* r1's write — off a
  byte-identical prefix ~14 minutes on, so **the write was never lost, just invisible to the request
  7 seconds behind it**. Everything we control is eliminated; there is no client-side fix (skipping
  r2's advancing breakpoint only defers the cost to r3). Treat as an upstream visibility artifact and
  **do not re-chase any eliminated row** — see the "Class 2 first-write cache miss — round-2
  eliminations" memory note for both tables.
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
