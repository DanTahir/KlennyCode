---
name: pawprint-authoring
description: How to write a working Pawprint (single-file TSX widget app) via create_pawprint/update_pawprint/read_pawprint_source — SDK contract, sandbox restrictions, network/CSP model (including a non-obvious img-src gotcha), and a troubleshooting checklist for common runtime failures. Read this BEFORE calling create_pawprint/update_pawprint.
---

# Authoring Pawprints

A Pawprint is a small, sandboxed single-file React (TSX) app that runs in its own isolated
Electron `BrowserWindow` (like a desktop widget) — created/updated via the `create_pawprint` /
`update_pawprint` tools, inspected via `read_pawprint_source`. Every create/update is hard-blocked
pending human approval regardless of approval mode: the user reviews the full source diff, any
extra npm packages, and any requested network domains together in one combined review before
anything is written to disk or run. `update_pawprint` is a **destructive full replacement** —
there is no version history — so always call `read_pawprint_source` first to fetch the current
source before editing it, exactly like you'd `read_file` before `edit_file`.

The renderer has **no Node/Electron access at all**: sandboxed, context-isolated, no Node
integration. It cannot read/write files, spawn processes, use the clipboard, or reach the
OpenRouter API key or any other secret — it is a pure browser environment talking only to the host
app through one narrow SDK, plus `fetch()` to whatever HTTPS domains were explicitly approved.
There is also no console/devtools access for you as the author — if something breaks at runtime,
you are debugging blind from the user's description alone (see Troubleshooting below).

## The SDK — the ONLY import from the host app

```ts
import { getState, setState, getTheme, onThemeChange, closeWindow, requestNewInstance } from 'klenny-pawprint-sdk'
```

- `getState(): Promise<any>` — reads this instance's persisted JSON state (undefined/null on first run).
- `setState(next: any): Promise<void>` — overwrites this instance's persisted JSON state. Use this
  for anything that should survive a close/reopen (last search, cached data, user input, etc).
  Always `await` it in an async handler rather than firing-and-forgetting, so a state write that
  fails doesn't silently look like it succeeded.
- `getTheme(): Promise<{ mode?: 'light' | 'dark'; ... }>` — current host theme tokens.
- `onThemeChange(cb): () => void` — subscribes to live theme changes; **returns an unsubscribe
  function synchronously** (not a Promise) — call it in a `useEffect` cleanup, don't await it.
- `closeWindow(): void` — closes this Pawprint's own window.
- `requestNewInstance(label?: string): void` — asks the host to open a new independent instance
  (only meaningful for `instanceModel: 'per-item'` Pawprints).

There is no other host API surface. No filesystem, no clipboard, no notifications, no other IPC —
if a feature needs something beyond this list, it cannot currently be built as a Pawprint; say so
rather than trying to fake it.

## Hard source restrictions (statically enforced — write TSX that avoids ALL of these)

- No dynamic imports (`import()`), no `require`, no `eval`.
- No `process`, `__dirname`, `__filename`, `globalThis` identifiers anywhere (checked by parsing
  the actual syntax tree, not a plain string search — using any of these as a bare identifier
  fails validation even sitting in unreachable/dead code; plain text in a comment or string
  literal is fine, it's real code identifiers that are checked).
- No imports beyond `react` and `klenny-pawprint-sdk`, plus whatever packages you explicitly listed
  in the `packages` param of `create_pawprint`/`update_pawprint` — and those exact package names
  must match, so don't import a package you didn't declare.
- Default-export a single React component (`export default function App() { ... }`) — the bundler
  mounts it to the DOM itself; never call `ReactDOM.createRoot`/`render` yourself.

## Tool contract

- `create_pawprint({ name, description, instanceModel, source, domains?, packages? })`
  - `instanceModel`: `'single'` for one shared instance (e.g. a calendar/settings widget) vs
    `'per-item'` if the user might want several independent instances open at once (e.g. sticky
    notes) — each instance gets its own window and its own persisted state.
  - `domains`: exact hostnames only — no `https://` scheme, no port, no path, no wildcard, no raw
    IP literal. Max 10. Omit entirely for a Pawprint with no network access. Plan out every domain
    the app will ever need up front where possible — adding one later means another full
    `update_pawprint` review cycle.
  - `packages`: extra npm deps as `{ name, version }`, resolved and integrity-checked against the
    real npm registry at approval time (never at runtime) — use real, existing versions; don't
    guess or invent one.
- `update_pawprint({ pawprintId, source, domains?, packages? })` — full replacement of source (and,
  if provided, packages/domains); omitting `domains`/`packages` in the call does NOT necessarily
  mean "keep existing" depending on how the host wires it through, so when in doubt pass the
  complete current lists back explicitly (from a fresh `read_pawprint_source` call) alongside your
  edited source, rather than assuming omitted fields are preserved.
- `read_pawprint_source({ pawprintId })` — read-only; returns the current `source`/`packages`/
  `approvedDomains`, plus an `instances` list, each with `instanceId`, a `statePath` (a real JSON
  file on disk), and whether that instance currently has a live window open. You can
  `read_file`/`edit_file`/`write_file` directly under that `statePath` to inspect or hand-edit one
  instance's persisted state (e.g. seed a calendar with an appointment) — an open instance's window
  reloads itself automatically when its state file changes on disk. Nothing else under the
  Pawprint's own storage (its source or manifest) is writable this way — use `update_pawprint` for
  those.

## The network/CSP model — read this closely before writing ANY fetch() call

Approving `domains` wires up two layers that both explicitly allow those exact HTTPS hostnames for
`fetch()`/XHR: a request-level allowlist (the real hard gate) and a `connect-src`
Content-Security-Policy directive, kept in sync with each other automatically. You do not need to
do anything extra for `fetch()` itself to work against an approved domain — plain
`fetch('https://approved-domain/...')` just works once the domain is approved.

**The gotcha that WILL bite you if you don't know it: `img-src` is only `'self' data:` — it is NOT
extended by your approved domains, and no `domains` list can change that.** The effective CSP is
shaped like:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src <your approved https:// hosts, or 'none'>
```

Anything not explicitly listed (fonts, media, frames, objects) falls back to `default-src 'none'`.
Concretely:

- **You cannot do `<img src="https://some-approved-domain/pic.png" />`** — that request is
  governed by `img-src`, not `connect-src`, and is silently blocked no matter what domains you
  approved. This reliably looks like a "domain approval" bug (broken image, generic network
  failure) when it's actually an `img-src` restriction with no override.
- If you genuinely need a remote image/icon: use emoji/inline SVG/unicode instead (simplest fix,
  and usually good enough — e.g. weather conditions as emoji, not icon sprites), OR `fetch()` the
  image as a blob (allowed — that's `connect-src`), convert it to a base64 `data:` URI, and set
  that as the `<img src>` — `data:` is allowed by `img-src`.
- The same shape of restriction applies to remote stylesheets/fonts (`style-src`/`font-src` have no
  remote-host allowance either) — all styling must be inline `style={{...}}` objects or an inline
  `<style>` tag, `'unsafe-inline'` is explicitly allowed for exactly that reason.
- Prefer APIs that return `fetch()`-able JSON over anything that wants a remote `<img>`/`<iframe>`/
  font/video URL embedded directly in markup.

**Pick free, keyless, CORS-friendly APIs whenever the task allows it.** The sandbox has no access
to any API-key/secrets store, so anything requiring a bearer token or API key has no safe place to
live — don't hardcode a key into the source (it would be visible to the user in the approval
review anyway, and Pawprints aren't a safe place to keep one regardless). An API that requires a
server-side proxy or blocks CORS cannot be called directly from a Pawprint at all — check
CORS-friendliness before committing to an API, not after writing the whole app around it. Good
prior examples: Open-Meteo (weather + geocoding, no key, CORS-enabled) and Zippopotam.us
(zip/postal-code → lat/lon, no key, CORS-enabled).

## Practical patterns

- **Persist meaningful state via `setState`** so the widget shows something useful immediately on
  reopen instead of a blank slate — save the user's last input plus the last successfully fetched
  result, restore both in a mount-time `useEffect` via `getState()`, and optionally kick off a
  background refetch if the data might be stale.
- **Theme via `getTheme()`/`onThemeChange()`** — build a small `colors` object keyed off
  `theme.mode === 'dark'` rather than hardcoding light-mode-only styling; subscribe once in a
  mount-time `useEffect` and clean up the returned unsubscribe function.
- **Keep the UI widget-sized** — Pawprint windows default to compact dimensions; design
  single-purpose, scrollable-if-needed layouts, not full desktop-app-sized dashboards.
- Third-party JSON response shapes have no runtime schema validation — narrow/guard fields you
  actually depend on (e.g. check an array exists and has length before indexing into it) so one
  malformed/empty API response degrades to a visible error message instead of a blank crash with
  no console for you to inspect afterward.

## Troubleshooting — common runtime symptoms and their real causes

Since you have no console access once a Pawprint is running, use this table to jump straight to
the likely cause from what the user describes, rather than guessing blindly:

| Symptom the user reports | Likely cause | What to check/fix |
|---|---|---|
| "Failed to fetch" on every network call | Domain not actually approved, or a typo/subdomain mismatch (e.g. approved `api.example.com` but code fetches `www.api.example.com`) | Re-check the exact hostname in `domains` vs. every `fetch()` URL in source — must match exactly, no scheme/port/path in the `domains` entry itself |
| Broken image icon / image never loads, but other fetches work fine | `img-src` restriction (see CSP section above) — this is NOT a domain-approval bug | Switch to emoji/inline SVG, or fetch-as-blob → base64 `data:` URI |
| Blank white window, nothing renders | A runtime error before first paint — most often a source restriction violation that somehow got approved, or a thrown error in top-level component code with no error boundary | Re-read the source for any of the hard restrictions above; wrap risky rendering logic in a try/catch or add basic guards around data that might be missing |
| State doesn't persist across close/reopen | `setState` never actually awaited/called on the relevant code path (e.g. only inside a `.then()` that's never reached because of an earlier thrown error) | Trace the exact code path that should call `setState` and confirm it isn't skipped by an earlier failure |
| Multiple windows interfere with each other / user wanted independent copies but got one shared widget | `instanceModel` was set to `'single'` when `'per-item'` was actually wanted (or vice versa) | This requires recreating rather than just editing source — confirm with the user before assuming it's a source bug |
| A new package import fails to resolve | Package wasn't declared in `packages`, or the declared version doesn't actually exist on npm | Confirm the import statement's package name exactly matches an entry in `packages`, and that the version is real |
| User says something used to work but broke after an edit | Almost certainly the most recent `update_pawprint` call — remember it's a full replacement, not a patch | `read_pawprint_source` to see current state, diff mentally against what you intended to change, look for anything unintentionally dropped |

When the cause isn't obvious from this table, ask the user a specific, narrow question (e.g. "does
the button do nothing, or does it show an error message?") rather than re-writing large chunks of
source speculatively — you're debugging without logs, so narrowing down the failure mode from the
user's real observed behavior is more reliable than guessing.
