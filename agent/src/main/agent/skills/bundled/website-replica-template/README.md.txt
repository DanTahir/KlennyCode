# __SLUG__

A pixel-faithful Next.js + TypeScript replica of [__TARGET_URL__](__TARGET_URL__).

Everything is self-hosted: fonts, images, CSS, wasm. The page makes **zero remote
requests** at runtime, and the verification harness fails the build if that ever
stops being true.

## Quick start

```bash
npm install
npm run pipeline     # capture -> scrape -> extras -> analyze -> codegen
npm run dev          # http://localhost:__PORT__
```

`npm run pipeline` is safe to re-run: asset downloads are cached (`--force` to
bypass), and codegen fully overwrites `app/generated/`.

## How it works

The original page is turned into React in seven stages. Each stage writes its
output to `scrape/` and only reads the previous stage's artifacts, so any stage
can be re-run alone.

| # | Command | What it does |
|---|---------|--------------|
| 1 | `npm run capture` | Loads the page in headless Chromium; saves the **rendered** DOM pre-scroll (the codegen source), the post-scroll DOM, raw static HTML, the full network log, `<head>` in document order, and detected library/effect features. |
| 2 | `npm run scrape` | Downloads every asset (from the network log, the markup, and one recursion pass into downloaded CSS/JS) into `public/assets/`, writing `scrape/asset-map.json`. |
| 3 | `npm run extras` | Self-hosts runtime-only binaries (e.g. Rive `.wasm`) and reports which JS libraries + versions the original loaded, in `scrape/runtime-requirements.json`. |
| 4 | `npm run analyze` | Read-only recon: head order, inline style/script dumps, body outline, section census, data-attribute census, `scrape/analysis/summary.json`. Emits no app code. |
| 5 | `npm run codegen` | Parses the captured DOM, **sanitizes runtime artifacts**, and emits per-section `.tsx` components, `PageBody.tsx`, `metadata.ts`, the cascade-ordered CSS, and `manifest.json`. |
| 6 | `npm run viewports` | Browser audit across 7 viewports, run in parallel lanes (the CI gate). |
| 7 | `npm run compare` | Side-by-side screenshot diff against the live page, swept down the whole page and back up, viewports in parallel lanes. |

### Why the DOM is captured twice

The **pre-scroll** DOM is the codegen source, because it has the least runtime
mutation baked into it. Asset discovery instead uses the network log from a
**post-scroll** pass, so lazy-loaded images and runtime-fetched fonts are still
discovered. Capturing markup post-scroll would freeze every scroll animation in
its finished state; discovering assets pre-scroll would miss half of them.

### The sanitizer (the part that is easy to get wrong)

A rendered-DOM capture contains state the page's JavaScript added after load:
classes like `faded-in` / `aos-animate` / `swiper-initialized`, and inline
`opacity` / `transform` / `transition` styles. Shipped as-is, every entrance
animation renders already-finished (or worse, frozen at `opacity: 0` and
invisible). Codegen strips them, `app/ClientRuntime.tsx` re-applies them at the
right moment, and `tests/generated.test.ts` fails if any survive.

Strip lists are configurable per site in `replica.config.json` under `codegen`.

## Layout

```
app/
  layout.tsx            root layout; re-exports generated metadata
  page.tsx              mounts <PageBody />
  ClientRuntime.tsx     THE file you hand-tune: which effects to enable
  lib/                  generic, dependency-free effect modules
  generated/            codegen output - do not hand-edit, it is overwritten
scripts/                the 7 pipeline stages + shared lib/
public/assets/          every self-hosted asset (committed)
scrape/                 capture artifacts + reports (mostly gitignored)
tests/                  effect unit tests + generated-output integrity tests
replica.config.json     the only site-specific configuration
```

## Tuning the replica

All site-specific knowledge lives in `replica.config.json` and
`app/ClientRuntime.tsx`. The scripts themselves are URL-agnostic.

**Something invisible / animations frozen?** The site's finished-state class is
probably not `faded-in`. Find the real one in the captured CSS and pass it:

```ts
{ name: 'fadeIn', init: createFadeIn({ activeClass: 'is-visible' }) }
```

**A carousel/Rive/Lottie is static?** Those are opt-in adapters, since the
template ships no animation dependencies. Install the version `npm run extras`
detected, then uncomment the matching line in `ClientRuntime.tsx`.

**Stray widget in the capture?** (cookie banner, chat bubble, analytics pixel.)
Add its selector to `codegen.dropSelectors`, or its host to `blockHosts`, then
re-run `npm run capture && npm run codegen`.

## Verification

```bash
npm run verify        # tsc --noEmit + vitest + next build
npm run viewports     # 7-viewport browser audit (must exit 0)
npm run compare       # visual diff vs. the live page, whole page, down and up
```

`npm run viewports` checks, at every viewport: horizontal overflow, oversized
elements, the burger/desktop nav swap, canvas backing-store and paint state,
animation trigger counts pre/post scroll, carousel init, broken images, console
errors, failed requests, and that **nothing** is fetched from a remote origin.

Known upstream quirks (the live site overflows too) go in `replica.baseline.json`
rather than being "fixed" — a replica that fixes the original's bugs is no longer
a replica.

### Reading the visual diff

`npm run compare` compares the **entire page**, not just the fold. For every
viewport it loads the local replica and the live page side by side, walks both
through the whole document in viewport-height steps, diffs at each step, then
repeats the same offsets on the way back up. Output:

- `scrape/shots/compare/<viewport>/<direction>-<index>-y<offset>.jpg` — one
  `[local | live | diff]` composite per slice per direction. The compared
  screenshots are always PNG; only this review composite is JPEG, because JPEG
  artifacts near text edges would inflate the diff percentage itself.
- `scrape/compare-report.json` — per-slice diff %, per-slice band breakdown,
  achieved scroll offsets, page-height delta, compared coverage, the per-offset
  **direction delta** (down vs. up), plus the lane count and elapsed seconds.
- A console summary listing the worst slices with their file paths.

Useful flags: `--only=iphone-se,laptop`, `--slices=N` (max slices per
direction, default 10), `--settle=ms`, `--down-only`, `--threshold=N`,
`--lanes=N` (viewports in parallel, default capped near half the cores),
`--live-lanes=N` (concurrent *cold loads of the live page*, default 2 — see
below), `--png-composites` (lossless composites).

Live page loads are throttled separately from lanes on purpose. With four
viewports cold-loading a heavy third-party page at once, one of those live loads
can fail to lay out at all — it reports a document height of exactly one
viewport even after spending its whole settle budget. The sweep would then diff a
blank shell against the replica and report a ~900% height delta as if the
replica were at fault. So: a live page that lays out implausibly short is
reloaded (up to 3 attempts), and if it stays short that viewport is reported as
`liveLoadSuspect` and left out of the average rather than presented as a
finding. Lower `--live-lanes` on a slow connection.

`npm run compare:fold` is the old above-the-fold smoke check and
`npm run compare:full` diffs one stitched full-page shot per side.

The two verification scripts are deliberately fast enough to run on every
iteration; `npm run compare:certify` and `npm run viewports:certify` are the
slow, fully-serial (`--lanes=1`) re-runs to reach for when a specific number or
hidden-content finding is in dispute.

**A non-zero diff percentage is normal**: A/B-tested copy, live counters, cookie
banners and font rasterization all differ run to run. Judge *where* the diff is
concentrated, not the headline number — a 0.4% diff spread evenly is fine; a
0.4% diff all in one slice is a real bug. Two signals are worth more than the
average:

- **A slice that is clean going down but dirty coming up** is a scroll-direction
  bug (a one-shot reveal that leaves content invisible, a hide-on-scroll nav,
  direction-aware parallax), not noise.
- **Page-height drift** shifts every section below the difference, so fix that
  before reading the lower slices at all.

## Scope

Single page only. Internal links point at the live site (absolute URLs) so
navigation still works; in-page `#anchors` stay local. Forms are intercepted
locally and never POST anywhere — a replica must not send real submissions to
someone else's CRM.
