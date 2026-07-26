---
name: prompt-caching-safety
description: Before adding anything to the system prompt or the start of the message array in this codebase, check whether it breaks Anthropic/Qwen-style explicit prompt caching — a real regression that shipped once (see project memory "System prompt caching regression..."). Use this whenever touching buildSystemPrompt, toORMessages, applyCacheControl, or anything that runs on every agent turn.
---

# Prompt caching safety

This app relies on explicit prompt-caching (`cache_control` breakpoints, Anthropic/Qwen-style) to
keep per-turn cost down. It works by resending an **identical** prefix (system prompt + early
messages) on every request — the provider hashes/matches that prefix and skips re-processing it.
The cache breakpoint logic lives in `agent/src/main/openrouter/caching.ts`
(`applyCacheControl`) and only ever marks the *first* system message as the stable breakpoint.

**The failure mode:** any byte that changes between turns inside that cached prefix — a live
timestamp, a random id, a per-call counter, anything computed fresh on every call — silently
turns off caching for the whole prefix, every single turn, with no error and no obvious symptom
in normal use. It just quietly costs more (visible in the UI as `cache-write` on every turn
instead of `... cached (saved $...)`).

## What actually happened (real regression, now fixed)

A "current date/time" note was added so the agent could compute relative/absolute schedule times
without looking things up externally. It was first implemented by folding a freshly-computed
`new Date().toString()` directly into the string returned by `buildSystemPrompt()` — which is the
cached prefix. Because that string is never identical twice, every turn stopped hitting the cache.
See project memory "System prompt caching regression — Current date/time note broke prompt
caching" for the full writeup.

**The fix:** keep the live timestamp completely out of `buildSystemPrompt()`'s return value.
Instead:
- `buildCurrentTimeNote()` (in `agent/src/main/agent/orchestrator/system-prompt.ts`) is a separate
  function computing just that one line.
- `toORMessages()` (in `agent/src/main/agent/messages.ts`) takes it as an optional
  `currentTimeNote` param and appends it as its **own trailing system message**, after the real
  (cacheable) system prompt and after the compaction-summary system message.
- Because `applyCacheControl` only marks the *first* system message as the breakpoint, this
  trailing message rides along uncached each turn without invalidating the big, genuinely static
  prefix (persona, memory, skills/subagent catalogs, workspace path, shell info).

## Checklist before adding anything to the hot prompt path

Ask this before adding *anything* to `buildSystemPrompt()`, `buildAgentModePrompt`/
`buildPlanModePrompt`, or the first N messages sent via `toORMessages`:

1. **Is this value identical across turns within the same session/task run?** If yes (soul text,
   memory notes, skills catalog, workspace path, shell name, subagent catalog) — safe to fold into
   the cached prefix as normal.
2. **Does this value change on every call** (timestamps, random ids, counters, "N tokens used so
   far", anything from `Date.now()`/`Math.random()` computed fresh each time)? If yes — it must
   NOT go into `buildSystemPrompt()`'s return string or anywhere before the cache breakpoint.
   Instead:
   - Compute it separately (its own small function, like `buildCurrentTimeNote()`).
   - Pass it into `toORMessages()`/wherever messages are assembled as its own **trailing** system
     message (or otherwise strictly after the cached breakpoint) — never prepended, never merged
     into the cached string.
3. **If genuinely unsure**, check `agent/src/main/openrouter/caching.ts` to see exactly which
   message `applyCacheControl` marks as the breakpoint (currently: the first system message), and
   make sure your new content lands on the correct side of that line.
4. After the change, sanity-check in the app itself: send two messages in the same chat tab and
   confirm the cost readout under the second one still shows "N cached (saved $...)" rather than
   "cache-write" every time. A permanent switch from cached to cache-write turn-over-turn is the
   signature of this bug.

## Second real regression, now fixed (note/breakpoint message collision)

A third regression shipped on top of the first two (see project memory "Prompt caching regression
#3 fix — trailing note moved off the cache breakpoint message entirely"): even after moving the
live time note to the tail of the *current* last message (structurally after its cache_control
marker), that message's shape still differed between the turn it was marked (content + note, 2
parts) and every later turn it was replayed as history (content only, 1 part, no note) — a dead
breakpoint the instant it stopped being "last". Symptom: `cachedTokens` permanently flat at
system-prompt size, no matter how many turns passed.

**The fix:** never let the same message carry both a live/dynamic trailing value AND a
`cache_control` breakpoint. `applyCacheControl` now reserves the true last wire message
exclusively for `trailingNote` (never marked), and places the advancing breakpoint one message
earlier instead — a message that never has anything appended to it, so its shape is stable across
every turn. Confirmed via live `[cache]` logs: cache reads now start on turn 2 (the earliest
possible turn — you can't read before something's been written once), growing correctly turn over
turn with no ramp-up.

**General rule this generalizes to:** if you ever append/mutate a message to carry a
per-request-changing value, that exact message must never also be the one marked with
`cache_control` — being marked one turn and unmarked/differently-shaped the next silently kills
future cache matches for that position, even though the *current* request's own marked content is
byte-identical to what was cached before.

## Where to look

- `agent/src/main/openrouter/caching.ts` — `applyCacheControl`, the actual breakpoint logic.
- `agent/src/main/agent/messages.ts` — `toORMessages`, where system messages are assembled in
  order; read its doc comment, it explains the ordering contract in detail.
- `agent/src/main/agent/orchestrator/system-prompt.ts` — `buildSystemPrompt` (must stay
  turn-to-turn stable for a given session state) vs. `buildCurrentTimeNote` (deliberately kept
  separate because it's not stable).

## Second real regression, now fixed: the "last message" breakpoint never got read hits

Even after the timestamp fix above, cached tokens still never grew past the system prompt —
every turn re-wrote the entire conversation-since-system from scratch. Root cause was different
from the first bug and easy to miss because the code *looked* correct and matched Anthropic's
documented pattern.

**What Anthropic's docs say:** mark only the system message (stable) and the new last message
(advances each turn) with `cache_control`; the API is documented to implicitly look backward from
a cache-marked position and find whatever the previous turn wrote, so you never need to re-mark
old positions.

**What actually happens through OpenRouter:** that implicit backward lookback does not find prior
non-system breakpoints in practice. Only the system breakpoint (identical every request) ever got
a read hit; a "last message" breakpoint that moves forward each turn without being re-marked was
never picked up as a hit on the next request. Confirmed via added `[cache]` debug logging in
`agent/src/main/openrouter/client.ts` (logs request breakpoint indices and response
`cached_tokens`/`cache_write_tokens`).

**The fix (commit "hopefully an actual fix for the caching bug"):** explicitly re-mark the exact
wire-message index where the *previous* request's last-message breakpoint landed, in addition to
marking the new last message — turning a hopeful implicit walk-back into a direct breakpoint hit.
- `agent/src/main/agent/orchestrator/state.ts` — new `lastCacheBreakpointIdx: Map<tabId, number>`,
  tracked per tab across turns.
- `agent/src/main/agent/orchestrator/loop.ts` — records the current turn's last-message index into
  that map (before the call, since `orMessages.length` is already final), reads the *previous*
  turn's value out as `priorCacheBreakpointIdx`, and passes it through to `streamChatCompletion`.
  Also **deletes** the map entry whenever compaction runs that turn — compaction reshuffles wire
  message indices, so a stale index would silently point at unrelated content.
- `agent/src/main/openrouter/client.ts` — `streamChatCompletion` takes `priorCacheBreakpointIdx`
  and threads it into `applyCacheControl`.
- `agent/src/main/openrouter/caching.ts` — `applyCacheControl` gained a `priorBreakpointIdx`
  param; it now marks up to **3 breakpoints** total (system, prior-turn's last-message position,
  new last message) instead of 2, skipping duplicates (e.g. if `priorBreakpointIdx` equals the
  system index or the new last index). This uses 3 of Anthropic's 4 available breakpoint slots.

**Takeaway if you touch this again:** don't trust "the API is documented to do X" for
cross-request cache behavior through OpenRouter without checking the `[cache]` log lines
(request `breakpointsAt` vs. the next response's `cachedTokens`) — verify empirically, not just
by re-reading the provider's docs. If `cachedTokens` in the usage log stays flat while
`promptTokens` grows turn over turn, the breakpoint isn't actually being hit even if the code
places it at what looks like the right position.
