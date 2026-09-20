---
name: caching-live-verification
description: >-
  MANDATORY for any change touching prompt caching (openrouter/caching.ts,
  cacheDiag.ts, client.ts request building, the tools array, toORMessages, the
  trailing time note, compaction): write a throwaway script that runs a REAL
  live OpenRouter request ladder, run it, confirm read-back, then delete the
  script. Unit tests cannot observe upstream cache behavior.
---

# Live verification for prompt-caching changes

## The rule

**Any change that can affect prompt caching must be verified with a real, live OpenRouter request
ladder before it is called done.** Write a throwaway script, run it against the gitignored key,
read the measured numbers, then delete the script. Green unit tests are necessary but **never
sufficient**, and saying "the logic is correct, tests pass" is not verification here.

### Why (this is not ceremony)

Caching is decided **upstream**. Our code only chooses which positions carry a `cache_control`
marker; whether the provider actually *reads a block back* is invisible to every unit test we can
write. Every prompt-cache defect in this repo's history was found from live measurements and was
missed by a fully green suite:

- The "interior marker invalidates the prefix" theory — plausible, unit-testable, **wrong**.
  Cost a build.
- The "string-vs-parts shape flip breaks the match" theory — same story, **wrong**.
- The real cause (a breakpoint on a `tool`-role message never yields a matchable entry) was only
  visible in live `[cache]` lines.
- A "live-verified" claim that read only rungs 1-5 of a session missed that drops began at r30.
  **Whole-session or whole-ladder, never a glance at the tail.**
- The tools-array invalidation was measured live as a 53 456-token full rewrite while every
  message fingerprint was byte-identical — a shape no message-level test can see.

## When this applies

Triggered by edits to any of:

- `agent/src/main/openrouter/caching.ts` — marker placement, `isMarkable`, `planAdvancingBreakpoint`
- `agent/src/main/openrouter/cacheDiag.ts` — fingerprints/diagnostics
- `agent/src/main/openrouter/client.ts` — request body building, the `[cache]` log lines
- `agent/src/main/agent/tools/definitions.ts` — **any** change to which tools are offered or their
  descriptions/schemas (the `tools` array is hashed *ahead* of the system prompt)
- `agent/src/main/agent/messages.ts` (`toORMessages`) — wire shape of messages
- `agent/src/main/agent/orchestrator/system-prompt.ts` — especially the trailing time note
- `agent/src/main/agent/compaction/compactor.ts` — changes the prefix wholesale

## Procedure

### 1. Write a throwaway script

Put it at `agent/tmp-live-cache-test.ts`. Constraints:

- The filename must **not** match `*.test.ts` / `*_test.ts` / `*.spec.ts`, or `bun test` will
  auto-discover it and try to spend money on every suite run.
- Read the key from the gitignored `cachetestingkey.txt` in the repo root
  (`join(import.meta.dir, '..', 'cachetestingkey.txt')`, first line, trimmed). **Never** inline a
  key, never echo it, never paste it into chat or a log.
- Import `./tests/testElectronMock` **first** if anything you import reaches Electron
  (`tools/definitions.ts` does).
- Call `streamChatCompletion` from `src/main/openrouter/client` directly — it pulls in no Electron
  and needs no app running.
- Prefer the **real** production artifacts over synthetic ones (e.g. `getToolDefinitions('agent')`
  rather than a hand-written 2-tool array); a synthetic fixture can pass while production breaks.

### 2. Design the ladder

A ladder is a sequence of requests on **one** model and **one** `sessionId`, each growing the
conversation as a real turn would, with `supportsExplicitCaching: true` and a per-rung
`currentTimeNote` (mirrors production's volatile trailing slot).

Non-negotiable properties:

- **At least 4-5 rungs.** Two rungs cannot distinguish a real fix from a cold-start coincidence.
- **Byte-identical filler.** Build padding deterministically so a miss can never be explained by a
  changed prefix. Each rung must clear the provider's minimum cacheable block (~1024 tokens for
  Anthropic) — pad turns to ~1200+ tokens each, system to ~2400.
- **`includeLastMessageCacheBreakpoint: false` on rung 1 only** (nothing to read back yet).
- **A negative control.** Include a rung that deliberately performs the failure the change
  prevents, and assert that it *fails*. Without it the test can pass by simply measuring nothing.
- **`maxTokens: 16`** and a terse system instruction — you are measuring the prompt, not paying
  for output.

### 3. Assert, don't eyeball

Collect the `usage` chunk (`promptTokens`, `cachedTokens`, `cacheWriteTokens`, `costUsd`) per rung
by capturing `console.log`/`console.warn` into an array, then print a PASS/FAIL list and
`process.exit(1)` on any failure. Assert at minimum:

- **shortfall 0** on every stable transition: `cachedTokens[n]` must equal
  `cachedTokens[n-1] + cacheWriteTokens[n-1]` (for rung 2, just rung 1's write).
- the negative-control rung missed (`cachedTokens === 0`) and emitted its expected warning.
- recovery after the control rung (caching resumes).
- no spurious warnings on the stable rungs.
- every `[cache] request` line carries the fields you rely on for diagnosis.

### 4. Interpret

| observation | meaning |
|---|---|
| `cachedTokens` == prior `cached + write` | exact read-back, healthy |
| `cachedTokens` > 0 but short | partial match — inspect `bpActual` and the boundary role |
| `cachedTokens` == 0, `bp=` hashes identical, `tools=` identical | genuine upstream/cold-start miss; not ours |
| `cachedTokens` == 0, `bp=` identical, **`tools=` changed** | the tools array mutated — total invalidation, our bug |
| `bpActual=-1` while `includeLastMsgBreakpoint=true` | no advancing breakpoint placed at all |
| `breakpointsAt=[0]` when an advancing one was wanted | the marker had nowhere to live |

Cross-check `names=` vs `defs=`: `names` moving means a tool appeared/disappeared (our bug);
only `defs` moving means a description/schema edit (legitimate once per build).

### 5. Clean up

**Delete the script when done** (`delete_file`) and confirm `git status` is clean. It is throwaway
by design: it costs money on every run, and a committed money-spending script in `agent/` is a
trap for the next person. Record the *measured numbers* in the memory note / `KLENNY.md` instead —
the numbers are the durable artifact, not the script.

## Reference baseline (measured 2026-09-20, `anthropic/claude-sonnet-5`)

Tools-array stability ladder; rungs 1-3 used a 35-def array, rung 4 switched to 36 defs
mid-conversation (replaying the old `update_checklist` gate), rung 5 held stable:

| rung | tools | promptTokens | cached | cacheWrite | shortfall |
|---|---|---|---|---|---|
| r1 | 35 | 14440 | 0 | 12970 | — |
| r2 | 35 | 15813 | 12970 | 1443 | 0 |
| r3 | 35 | 17186 | 14413 | 1373 | 0 |
| r4 | **36 (changed)** | 19016 | **0** | 17616 | total miss |
| r5 | 36 | 20389 | 17616 | 1373 | 0 |

Total cost: **$0.1103** for 5 rungs. Budget roughly $0.10-0.15 per ladder; if a run is about to
cost materially more than that, the filler is too big.

The load-bearing observation: the system block's fingerprint was byte-identical on all five
requests (`wire=e9cb6aed`) while r4 read back **zero**. That is precisely the pattern that reads as
"upstream miss" and is not — it is why `tools=` exists in the log line.

## Alternative when the change is already shipped in a running build

If the code is live in the running app, you can verify from real usage instead of a script, via
`read_app_log` with `filter: '[cache]'`. Rules:

- Scope to the session:
  `awk '/App session started \(vX.Y.Z/{f=1} f' process.log`
- Never judge from the tail alone. Count over the whole session, e.g.
  `grep 'includeLastMsgBreakpoint=true' process.log | grep -c 'breakpointsAt=\[0\] '` → must be `0`,
  and `grep -o 'tools=n=[0-9]* names=[a-f0-9]*' process.log | sort -u` → exactly one value per
  session.
- A brand-new log field cannot appear until the app is rebuilt and restarted. If you only changed
  the logging, say so plainly rather than implying it was observed live.
