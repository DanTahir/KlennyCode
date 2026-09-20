# Prompt cache regression: the advancing breakpoint is silently dropped (cached pinned at 44761)

**Status: FIXED, fully.** The silent drop is gone, and the prose-free gap that the first pass
could only partially close is now closed too: the marker rides the assistant turn's last
`tool_call`, which live testing confirms OpenRouter forwards to Anthropic as a readable cache
entry. End-to-end through the real production path, a prose-free parallel-tool turn writes a
10,426-token block and reads it back with **shortfall 0** on both opus-5 and sonnet-5.

The original diagnosis below was correct and is preserved. Three corrections were added on top
of it by verifying against `process.log` and the persisted session store rather than re-reading
the code, and one of the note's "needs live verification, do not assume" options turned out to
work — see "The prose-free case: resolved by live test".

---

## Correction 1: the regression is `ae4434f`, and now there is a count, not an argument

The original note asserted this from reading diffs. It holds up against the live log. Counting
requests that asked for an advancing breakpoint (`includeLastMsgBreakpoint=true`) against those
that shipped with only `breakpointsAt=[0]`, per app session in `process.log`:

| session   | when              | advancing-bp requests | marker dropped |
|-----------|-------------------|-----------------------|----------------|
| v0.2.153  | before `ae4434f`  | 16                    | **0**          |
| v0.2.154  | before `ae4434f`  | 11                    | **0**          |
| v0.2.155  | after `ae4434f`   | 85                    | **13**         |
| v0.2.156  | after `2a23332`   | 16                    | **7**          |

Zero drops in 27 requests before the tool-role walk-back shipped, 20 drops in 101 after it. That
is the regression, located to the commit.

## Correction 2: why it looked like the compaction animation, and why it isn't

`2a23332` is innocent — re-verified by reading the full diff, including the `KLENNY.md` hunk the
original note didn't mention (it only edits caching documentation and contains no instruction
that would change how much prose the model writes).

The real reason it *looked* like that commit: **the v0.2.155 "live verification" only examined
r1–r5.** Those five rungs are genuinely clean (shortfall 0 on all four transitions, exactly as
recorded in `KLENNY.md`). The first dropped marker in that session is **r30**, and drops continue
intermittently through r83. So the bug was already live and already visible in the log at the
moment it was declared verified; the verification window just stopped 25 requests too early.
By the next session the drop rate happened to be much higher (7/16 vs 13/85), which is when it
became impossible to miss.

**Lesson for the next verification:** check the whole session, not the first few rungs —
`grep 'includeLastMsgBreakpoint=true' process.log | grep -c 'breakpointsAt=\[0\] '` must be 0.

## Correction 3: the failure is intermittent, not permanent

The original note's symptom section implies caching was pinned at 44761 always. It is per-request:
whenever the model wrote a preamble before its tool calls, the marker landed and the ladder was
healthy (v0.2.156 r16/r17/r19, v0.2.155 r81/r84). Only prose-free steps dropped it. Everything
else in the diagnosis — the mechanism, the two code locations, the `''`-content interaction — is
exactly right.

---

## Root cause (unchanged, and confirmed by direct execution)

`agent/src/main/agent/messages.ts` emits `content: ''` for an assistant turn that called tools
with no preamble. `''` serializes to **zero content parts**, and a `cache_control` marker lives
*on* a content part — so that message cannot carry one. The tool-role walk-back added in
`ae4434f` lands on exactly that message in a normal agent step (wire tail
`[..., assistant(tool_calls), tool, tool]`), and `withCacheControlOnLastPart` returned the
message untouched rather than reporting failure. Confirmed by running the real pipeline: a
prose-free turn through `toORMessages` → `applyCacheControl` produced `breakpointsAt=[0]`.

---

## The fix

### `agent/src/main/openrouter/caching.ts`

1. **`isMarkable(m)`** — true when the message has a tool call *or* a content part to carry a
   marker.
2. **`planAdvancingBreakpoint(messages, hasTrailingNote)`**, exported and pure. Walks back past
   `tool` roles *and* unmarkable messages, and returns `{ intendedIdx, index, skippedTool,
   skippedUnmarkable }`. `index === -1` means "no legal position", which is now the only way the
   advancing breakpoint can be absent. Both invariants live here and nowhere else.
3. **`withCacheControlOnLastPart` → `tryMark`, returning `ChatMessage | null`.** The silent
   no-op is now unrepresentable: a caller that ignores failure gets a type error. This is the
   part that makes the bug class non-recurring, rather than just fixing this instance.
4. **`tryMark` prefers the last `tool_call` over the content part** — see below for why that is
   both what makes the prose-free case work and a strict improvement on the prose case.

### `agent/src/main/openrouter/cacheDiag.ts`

`breakpointIndices` / `withoutMarks` / the fingerprints now understand a marker on a tool call,
not just on a content part — otherwise the diagnostic would report `breakpointsAt=[0]` for a
perfectly healthy request and recreate this exact false alarm. `bp=` gained `on=part` / `on=call`
so a regression back to text-marking is greppable. `canonicalText` strips markers before hashing,
so the `text` hash stays marker-independent and the interpretation table still holds.

### `agent/src/main/openrouter/client.ts`

The `[cache] request` line now carries `bpIntended=`, `bpActual=` and
`bpSkipped=tool:N+unmarkable:M`, so the walk-back is visible instead of inferred, and a
`console.warn` fires when the advancing breakpoint could not be placed at all. Logging only the
final positions is what let this hide for two releases: a request that failed to place the
breakpoint looked identical to a first-request-of-a-conversation that deliberately skips it.

---

## Tests

`agent/tests/caching.test.ts`, all seven verified to **fail on the pre-fix logic and pass after**
(checked by disabling only the `isMarkable` branch of the walk-back; the 36 pre-existing tests
pass either way, so nothing already-working changed):

- the exact tail from this bug — `[assistant(content:'', tool_calls), tool]` — now yields two
  breakpoints, with the marker on the tool call and `content` left as `''`;
- the marker lands on the **last** call of a parallel batch, and is preferred over the text part
  when the assistant wrote both;
- the breakpoint advances on **every** step of a prose-free turn, never sliding backwards;
- the same hole reached via `content: []` (no content parts *and* no tool calls) still walks back;
- a property test over five tail shapes asserting the marked indices always equal what
  `planAdvancingBreakpoint` reported — i.e. a planned breakpoint can never silently not appear;
- `planAdvancingBreakpoint` reports both skip causes, returns `-1` rather than a bogus index, and
  re-advances the moment the model writes prose again;
- both invariants across a six-step prose-free turn: never a `tool` role, never the note-bearing
  last message;
- **an end-to-end block that builds the wire with the real `toORMessages`** instead of
  hand-written messages, so `messages.ts` and `caching.ts` cannot drift apart and silently
  reopen the hole.

Plus `agent/tests/cacheDiag.test.ts`: the diagnostic finds a tool-call marker, reports
`on=part`/`on=call`, and keeps the `text` hash marker-independent.

Full suite: 1124 pass / 0 fail. `tsc --noEmit -p tsconfig.node.json` clean.

### Offline replay against the real broken session

Unit tests can't see upstream matching, but they *can* be run over the actual conversation that
produced the bad log. Replaying the persisted session store (the 41-message tab from v0.2.156)
through old vs. new logic at every request point:

```
requests=12  oldDropped=7  newDropped=0  recovered=7  walkbackDistance=5..23
```

`oldDropped=7` matches the 7 drops counted independently in that session's `[cache]` lines, so
the replay is faithful. Both invariants held on every reconstructed request.

---

## The prose-free case: resolved by live test

The walk-back alone left a real gap. Of the 7 requests it recovered in the replay, only **1**
recovered meaningfully (cached prefix 12% → 92%); the other **6** gained ~568 tokens each,
because they were one sustained prose-free run with no markable non-tool position past the last
user message. So the two "needs live verification, do not assume" options were actually tested,
against OpenRouter, with a unique prefix per variant and a second identical request to prove the
entry is **readable** rather than merely billed (the tool-role boundary already showed those are
different things). Results on claude-sonnet-5:

| variant | pass 1 write | pass 2 cached | verdict |
|---|---|---|---|
| no marker (control) | 0 | 0 | measurement is sound |
| marker on system message (control) | 11 821 | 11 821 | readable |
| **marker on `tool_calls[i]`** | **11 952** | **11 952** | **readable** |
| synthesized empty text part | 0 | 0 | silently ignored — no cache at all |
| synthesized single-space text part | 11 903 | 11 903 | readable, but changes model-visible content |

So OpenRouter **does** forward `cache_control` from a `tool_calls` object through to Anthropic's
`tool_use` block, and the resulting entry reads back exactly. Note the tool-call write (11 952)
exceeds the system-marker write (11 821) by exactly the extra prefix — confirming the cut really
is at the later position rather than silently falling back.

Confirmed beyond sonnet: **opus-5** (single and multi tool call, both exact read-back, control
0/0), and **qwen3-coder-plus** / **deepseek-v3.2** accept the marker without error and cache
implicitly regardless, so nothing breaks for the Alibaba explicit-cache family.

### An unexpected bonus: this also beats marking the text

Anthropic orders an assistant turn as `[text, tool_use...]`, and a breakpoint is a prefix cut —
so the old behaviour of marking the text part cut *before* the tool calls and left
`tool_calls.arguments` outside the cached prefix. That contradicts a claim in `KLENNY.md`, which
has been corrected. Measured on the same conversation with an ~8k-token write payload:

| marker on | cache write | uncached tail |
|---|---|---|
| text part (old behaviour) | 7 074 | **8 483** |
| last tool call (new) | 16 208 | **12** |

Both read back exactly. `tryMark` therefore prefers the last tool call whenever one exists, not
just when content is empty — worth ~9 000 extra cached tokens on a single write call. It must be
the *last* call: an earlier one cuts between calls and strands the rest.

### End-to-end, through the real code path

Building the wire with the actual `toORMessages` → `applyCacheControl` for a prose-free parallel
tool-calling turn, then sending it twice:

```
messages=5 breakpointsAt=[0,2] bpIntended=3 bpActual=2
bp=#0:system:parts on=part … | #2:assistant:str on=call …

anthropic/claude-opus-5    pass1 write=10426  |  pass2 cached=10426  shortfall=0
anthropic/claude-sonnet-5  pass1 write=10494  |  pass2 cached=10494  shortfall=0
```

The assistant message still goes out with `content: ''` — nothing model-visible was synthesized.

The third breakpoint on the compaction-summary system message (fixed position, safe) remains a
separate, easy floor-raise.

## How to verify the next live run

1. `grep 'includeLastMsgBreakpoint=true' process.log | grep -c 'breakpointsAt=\[0\] '` → **0**.
   This is the check that would have caught the original bug.
2. `bpIntended` vs `bpActual` on each request line gives the walk-back distance directly. On a
   healthy request the gap should now be small (typically just the trailing tool run), since
   tool-calling assistant messages are markable. A large `unmarkable:` count means something is
   emitting assistant messages with neither content nor tool calls.
3. `bp=` should show `on=call` at the advancing breakpoint on any step with tool calls. `on=part`
   there means the tool-call preference stopped applying and ~8k tokens per write call are
   silently falling outside the cut.
4. Ladder: each `usage` line's `cachedTokens` should equal the previous request's
   `cachedTokens + cacheWriteTokens`, across several consecutive transitions.
5. Session-scoped tool-boundary invariant:
   `awk '/App session started/{f=1} f' process.log | grep -c ':tool:parts'` → **0**.
