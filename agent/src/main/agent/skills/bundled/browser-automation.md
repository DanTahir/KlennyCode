---
name: browser-automation
description: How to drive the local Playwright browser tool (the "browser" tool) — snapshot-before-act workflow, ref-based element targeting, when to re-snapshot, and when to stop and ask a human instead of pushing through.
---

# Browser automation

The `browser` tool drives a real local Chromium browser via Playwright. It is action-addressed
(one tool, many `action` values) and gated by Settings → Automation → Browser automation. If it
returns `browser_disabled`, tell the user to enable it there — don't try to work around it.

## The core loop: snapshot before you act

Never guess at CSS selectors or coordinates. Instead:

1. `browser({ action: 'open', url: '...' })` — opens a tab (default label `"main"`) and
   navigates there in one call.
2. `browser({ action: 'snapshot' })` — returns a list of visible interactive elements, each
   tagged with a stable ref like `e3`, plus a readable `tree` string. Read this before deciding
   what to click/type/fill next.
3. Act using the ref you just saw: `browser({ action: 'click', ref: 'e3' })`,
   `browser({ action: 'fill', ref: 'e7', text: 'hello@example.com' })`, etc. Never invent a ref
   that wasn't in the most recent snapshot's output.
4. After any navigation, form submission, or action that meaningfully changes the page, take a
   fresh `snapshot` before acting again — old refs point at DOM nodes that may no longer exist
   (a stale ref reliably fails the next click/fill with a clear error telling you to re-snapshot).

## When snapshot's text isn't enough: `inspect`

`snapshot`'s role/name/value fields don't always disambiguate elements (e.g. several
similar-looking buttons, or elements whose meaning only shows up in an attribute/class/data
attribute snapshot doesn't surface). For that, use `inspect` — read-only JavaScript evaluation:

- `browser({ action: 'inspect', code: "document.querySelectorAll('button')" })` — reason about the
  page with real JS (query, filter, read attributes/computed styles/text) instead of guessing.
- To act on something you found, either call `klenny.ref(el)` on it (returns a ref string), or
  just have your code `return` the element/a NodeList/array of elements directly — both are
  auto-tagged with the same kind of ref `snapshot` uses. Then act on that ref exactly like a
  snapshot ref: `browser({ action: 'click', ref: 'e12' })`.
- `inspect` is strictly read-only — it statically rejects code that looks like it mutates the page
  (fetch, XHR, storage writes, `.click()`, `innerHTML =`, form submission, navigation, etc.) and
  additionally sandboxes those APIs at runtime as defense in depth. If you get
  `inspect_denied_pattern`, don't try to word around it — use the ref-based actions (click, fill,
  select, ...) to actually change the page instead.
- Unlike `evaluate`, `inspect` is always available, including inside subagents and scheduled
  tasks, since it can't mutate anything.

## Screenshots are for verification, not exploration

`screenshot` costs real tokens (it returns a base64 image) — prefer `snapshot`'s text-based
element list (or `inspect`, for anything snapshot's fields don't capture) for deciding what to do
next. Reach for `screenshot` mainly to visually confirm a result (e.g. "did the form actually
submit", "what does this chart look like") or to read something neither of those capture well
(visual layout, an image, a canvas-rendered element).

## Multiple tabs

Every action takes an optional `tab` label (default `"main"`) — use distinct labels
(`"main"`, `"2"`, ...) to keep multiple pages open in the same browser session at once, e.g.
comparing two pages side by side. `list_tabs` shows what's currently open.

## Mutating actions and approval

`click`, `type`, `fill`, `select`, `press_key`, `scroll`, `drag`, `submit`, and `evaluate` are
"mutating" — depending on the user's Browser automation policy, they may pause for approval
(with a screenshot preview) before running. This is expected and not an error; just wait for the
result. `open`, `close`, `list_tabs`, `navigate`, `snapshot`, `screenshot`, `inspect`, `wait_for`,
and `wait` never need approval (as long as the feature isn't fully disabled).

## Pausing for something to finish on the page

Two different actions cover "wait" needs — pick the one that fits:
- `wait_for` — polls for a condition (a `ref` or `selector` becoming visible, or falls back to
  the page's load state) and returns as soon as it's met. Prefer this whenever there's something
  concrete to poll for.
- `wait` — a plain fixed-duration sleep (`duration_ms`, default 5000, capped at 300000/5
  minutes), e.g. `browser({ action: 'wait', duration_ms: 120000 })` to pause ~2 minutes. Use this
  only when there's nothing to poll for — e.g. a server-side job/render/export with no visible
  DOM change — since it always waits the full duration instead of returning early.

`evaluate` (running raw, unrestricted JavaScript that CAN mutate/submit/navigate the page) is off
by default and never available at all inside a subagent or scheduled task — if it fails with
`evaluate_disabled`, tell the user they'd need to enable "Allow JavaScript evaluation" in
Settings. In almost every case you actually want `inspect` (to understand the page) plus the
ref-based actions (to act on it) instead — reach for `evaluate` only when the user has it enabled
and no other action can accomplish the specific mutation needed.

## When to stop and ask instead of pushing through

Stop and use `ask_question` rather than trying to power through:
- Login forms, especially anything asking for a password you don't have.
- 2FA / OTP prompts, magic-link flows, or anything requiring a code sent to the user.
- Payment/checkout flows involving real money.
- Anything where a wrong guess (submitting the wrong form, deleting something) would be
  destructive and hard to undo.

## CAPTCHAs: interactive sessions vs. unattended runs

Interactive chat-tab sessions run the browser headed (a real, visible window) specifically so the
user can watch and intervene. Subagents and scheduled tasks always run headless — there is no
window for a human to see or click into, so a CAPTCHA there is a genuine dead end.

- **Interactive session (headed, a real user is present in the chat):** don't declare failure and
  don't try to defeat/bypass the challenge. Use `ask_question` to tell the user a CAPTCHA
  appeared and ask them to solve it in the now-visible browser window, then confirm when done.
  Once they confirm, take a fresh `snapshot` (refs from before the challenge are stale) and
  continue the task from there.
- **Subagent or scheduled task (headless, unattended):** there's no one to solve it — report the
  CAPTCHA as a blocking failure in your summary rather than waiting on a question that can never
  be answered.

## Known limitations

- No PII redaction — screenshots, snapshots, and inspect results can capture whatever's on the
  page, including anything sensitive already visible there (e.g. non-HttpOnly cookies or tokens
  readable via `inspect`, which is read-only but not read-*safe*). Be mindful of what you
  screenshot, snapshot, or inspect and echo back to the user.
- `inspect`'s read-only sandboxing is defense in depth, not an airtight guarantee — it statically
  rejects known-mutating code patterns and neutralizes the common mutating browser APIs at
  runtime, but a sufficiently obfuscated snippet could theoretically still find a gap. Treat it as
  "very unlikely to mutate the page," not "cryptographically incapable of it."
- Headless detection is not specifically mitigated — some sites may behave differently or block
  automated browsers outright, especially for unattended (subagent/scheduled-task) sessions,
  which always run headless regardless of settings.
- Private/local network access (e.g. `localhost` dev servers) follows separate, stricter
  defaults for unattended runs than for interactive chat-tab use — a subagent may get a network
  policy error hitting a local URL that would work fine from an interactive tab.
