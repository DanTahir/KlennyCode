/** Content for SKILL.md files bundled with the app and seeded into the global skills dir on
 *  first launch (see manager.ts's seedBundledSkills). Kept in a separate module (rather than
 *  inline in manager.ts) purely so the sizeable markdown blobs don't crowd out the actual
 *  seeding logic. */

export const BROWSER_AUTOMATION_SKILL_MD = `---
name: browser-automation
description: How to drive the local Playwright browser tool (the "browser" tool) — snapshot-before-act workflow, ref-based element targeting, when to re-snapshot, and when to stop and ask a human instead of pushing through.
---

# Browser automation

The \`browser\` tool drives a real local Chromium browser via Playwright. It is action-addressed
(one tool, many \`action\` values) and gated by Settings → Automation → Browser automation. If it
returns \`browser_disabled\`, tell the user to enable it there — don't try to work around it.

## The core loop: snapshot before you act

Never guess at CSS selectors or coordinates. Instead:

1. \`browser({ action: 'open', url: '...' })\` — opens a tab (default label \`"main"\`) and
   navigates there in one call.
2. \`browser({ action: 'snapshot' })\` — returns a list of visible interactive elements, each
   tagged with a stable ref like \`e3\`, plus a readable \`tree\` string. Read this before deciding
   what to click/type/fill next.
3. Act using the ref you just saw: \`browser({ action: 'click', ref: 'e3' })\`,
   \`browser({ action: 'fill', ref: 'e7', text: 'hello@example.com' })\`, etc. Never invent a ref
   that wasn't in the most recent snapshot's output.
4. After any navigation, form submission, or action that meaningfully changes the page, take a
   fresh \`snapshot\` before acting again — old refs point at DOM nodes that may no longer exist
   (a stale ref reliably fails the next click/fill with a clear error telling you to re-snapshot).

## Screenshots are for verification, not exploration

\`screenshot\` costs real tokens (it returns a base64 image) — prefer \`snapshot\`'s text-based
element list for deciding what to do next. Reach for \`screenshot\` mainly to visually confirm a
result (e.g. "did the form actually submit", "what does this chart look like") or to read
something a snapshot's role/name/value fields don't capture well (visual layout, an image, a
canvas-rendered element).

## Multiple tabs

Every action takes an optional \`tab\` label (default \`"main"\`) — use distinct labels
(\`"main"\`, \`"2"\`, ...) to keep multiple pages open in the same browser session at once, e.g.
comparing two pages side by side. \`list_tabs\` shows what's currently open.

## Mutating actions and approval

\`click\`, \`type\`, \`fill\`, \`select\`, \`press_key\`, \`scroll\`, \`drag\`, \`submit\`, and \`evaluate\` are
"mutating" — depending on the user's Browser automation policy, they may pause for approval
(with a screenshot preview) before running. This is expected and not an error; just wait for the
result. \`open\`, \`close\`, \`list_tabs\`, \`navigate\`, \`snapshot\`, \`screenshot\`, \`wait_for\`, and
\`wait\` never need approval (as long as the feature isn't fully disabled).

## Pausing for something to finish on the page

Two different actions cover "wait" needs — pick the one that fits:
- \`wait_for\` — polls for a condition (a \`ref\` or \`selector\` becoming visible, or falls back to
  the page's load state) and returns as soon as it's met. Prefer this whenever there's something
  concrete to poll for.
- \`wait\` — a plain fixed-duration sleep (\`duration_ms\`, default 5000, capped at 300000/5
  minutes), e.g. \`browser({ action: 'wait', duration_ms: 120000 })\` to pause ~2 minutes. Use this
  only when there's nothing to poll for — e.g. a server-side job/render/export with no visible
  DOM change — since it always waits the full duration instead of returning early.

\`evaluate\` (running raw JavaScript in the page) is off by default and never available at all
inside a subagent — if it fails with \`evaluate_disabled\`, tell the user they'd need to enable
"Allow JavaScript evaluation" in Settings, and prefer accomplishing the task with the other
actions instead of insisting on it.

## When to stop and ask instead of pushing through

Stop and use \`ask_question\` rather than trying to power through:
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
  don't try to defeat/bypass the challenge. Use \`ask_question\` to tell the user a CAPTCHA
  appeared and ask them to solve it in the now-visible browser window, then confirm when done.
  Once they confirm, take a fresh \`snapshot\` (refs from before the challenge are stale) and
  continue the task from there.
- **Subagent or scheduled task (headless, unattended):** there's no one to solve it — report the
  CAPTCHA as a blocking failure in your summary rather than waiting on a question that can never
  be answered.

## Known limitations

- No PII redaction — screenshots and snapshots can capture whatever's on the page, including
  anything sensitive already visible there. Be mindful of what you screenshot.
- Headless detection is not specifically mitigated — some sites may behave differently or block
  automated browsers outright, especially for unattended (subagent/scheduled-task) sessions,
  which always run headless regardless of settings.
- Private/local network access (e.g. \`localhost\` dev servers) follows separate, stricter
  defaults for unattended runs than for interactive chat-tab use — a subagent may get a network
  policy error hitting a local URL that would work fine from an interactive tab.
`
