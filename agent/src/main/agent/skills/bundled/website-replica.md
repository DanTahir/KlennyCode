---
name: website-replica
description: "Build a pixel-faithful Next.js + TypeScript replica of a single live web page (animations, fonts, hero canvas graphics, mobile responsiveness, all assets self-hosted) into a new subfolder of the current repo. TRIGGER: read this whenever the user's message contains `website_url:` followed by a URL, or asks to clone/replicate/rebuild a specific web page. Handles memory read/write, folder slugging, the 7-stage capture→codegen pipeline, and the full verification gate."
---

## When this skill applies

The user's message contains `website_url:` followed by a URL, e.g.

```
website_url: https://www.example.com/product/analytics
```

or they ask in prose to clone / replicate / rebuild a specific live page. Either
way, run the procedure below. There is no separate confirmation step: the
`website_url:` prefix *is* the instruction.

Deliverable: a new subfolder of the **current workspace** containing a Next.js +
TypeScript app that reproduces that one page as faithfully as a careful human
front-end engineer would — layout, type, colour, spacing, entrance animations,
scroll behaviour, canvas/Rive/Lottie graphics, carousels, and responsive
behaviour from 320px to 2560px — with every asset self-hosted so the page makes
**zero remote requests**.

---

## Step 0 — Load memory first (mandatory)

Before touching anything, load both scopes. This is what stops you rediscovering
the same gotchas every run.

1. `read_memory({ scope: 'global', topic: 'Website replica lessons' })` — durable
   cross-site gotchas (renderer-build mismatches, sanitizer traps, cascade
   ordering, font hosting, viewport quirks). If it doesn't exist yet, note that
   and continue.
2. `list_memory({ scope: 'project' })`, then read any note whose title mentions
   replicas, scraping, this skill, or the target domain. A previous run's
   **note** on the same site is the single most valuable thing you can find —
   the note, never that run's code (see "Never build from another run" below).

Apply what you learn — if the global note says "always check the Rive renderer
build", check it *this* run, don't rediscover it.

---

## Step 1 — Derive the folder slug

Strict, deterministic rule:

1. Strip the scheme and any leading `www.`.
2. Drop the query string and hash entirely.
3. Remove **every** non-alphanumeric character (dots, slashes, hyphens,
   underscores all vanish).
4. Lowercase.
5. Append `-1`. If `<slug>-1` already exists in the workspace, try `-2`, `-3`, …
   and use the first free one. Never reuse or overwrite an existing folder.

| Input URL | Folder |
|---|---|
| `https://url.com/page` | `urlcompage-1` |
| `https://www.foo-bar.com/a/b?x=1` | `foobarcomab-1` |
| `https://example.com/` | `examplecom-1` |
| `https://example.com` (taken) | `examplecom-2` |

Verify with `glob` before creating.

---

## Step 2 — Copy the template

The vendored template lives beside this skill:

```
~/.klenny/skills/website-replica/template/
```

Copy the whole tree into `<workspace>/<slug>/`. On Windows/Git Bash:

```bash
mkdir -p "<slug>" && cp -r ~/.klenny/skills/website-replica/template/. "<slug>/"
```

Then fill in the placeholders (use `edit_file`, never shell substitution):

- `package.json` — `__SLUG__` → the slug; `__TARGET_URL__` → the URL.
- `README.md` — `__SLUG__`, `__TARGET_URL__`, `__PORT__`.

Never edit the template in-place for a specific site. If you discover a genuine
**general** improvement, fix the template too — but do it as a separate,
deliberate edit, and say so in your summary.

The pristine template and the folder you are creating are the **only** code you
may read this run — see the next section.

---

## Never build from another run in this repo (hard requirement)

The workspace may already contain replicas from earlier runs — `examplecom-1`,
`examplecom-2`, a half-finished attempt, or a different site entirely. Treat
every one of them as off-limits for the whole run:

- **Do not read** another replica folder's source — no `read_file`, `grep`,
  `glob`, `codebase_search`, or shell `cat` into `<other-slug>/**`. The only
  code you may open is the pristine
  `~/.klenny/skills/website-replica/template/` and the folder you are building
  right now.
- **Do not copy** files, components, CSS, `replica.config.json` values, effect
  modules, or `ClientRuntime.tsx` wiring out of another run.
- **Do not** diff your output against another run, or use one to "check" your
  work.

Exactly two inputs are legitimate: **memory notes** (Step 0) and **this run's
own capture of the live site** (`scrape/**` and the `app/generated/**` your own
pipeline produced). Every line you write must be justified by what this run
actually observed on the target page.

Why this is a hard rule and not a preference: a neighbouring replica is a
plausible-looking but unverified answer to a *different* question. Copying from
it silently imports that run's assumptions — its fade-in active class, its Rive
renderer build, its stripped-class list, its port, its section names — none of
which were derived from *this* URL. That converts a capture-driven replica into
a guess that merely compiles, and the resulting defects are precisely the kind
that clear every gate and surface only as "it doesn't quite look right".
Knowledge is supposed to travel between runs through memory notes, which are
written deliberately and reviewed; code is not.

If you find yourself wanting a neighbour's file, the correct move is to re-read
this run's `scrape/analysis/**` and look at the live page again.

---

## Step 3 — Write `replica.config.json`

Copy `replica.config.example.json` → `replica.config.json` and set at minimum:

```json
{
  "targetUrl": "https://www.example.com/product/analytics",
  "slug": "examplecomproductanalytics",
  "port": 3300
}
```

Pick a port unlikely to collide (3300+). Everything else has defaults in
`scripts/lib/config.mjs`; only add keys when a site actually needs them. This
file is the **only** place site-specific knowledge belongs — never hardcode a
URL, selector, or class name into a script.

---

## Step 4 — Install and run the pipeline

```bash
cd "<slug>" && npm install
npm run pipeline     # capture → scrape → extras → analyze → codegen
```

Chromium comes from the cached `ms-playwright` install via `playwright-core`. If
`scripts/lib/chromium.mjs` reports it missing, run the install command it prints
(`npx playwright install chromium`) and retry.

Then **read the artifacts before writing any code** — this is the recon step that
determines whether the replica is faithful or merely approximate:

| File | What to look for |
|---|---|
| `scrape/features.json` | Which libraries and effect classes the page actually uses. |
| `scrape/runtime-requirements.json` | Exact library + version to `npm i`, and the suggested command. |
| `scrape/analysis/summary.json` | Section census, data-attribute census, inline script/style dumps. |
| `app/generated/manifest.json` | Sections emitted, stylesheet cascade order, asset counts, sanitizer stats. |

The sanitizer stats matter: if `strippedClasses` is empty on an obviously
animated page, the strip list is wrong for this site and every entrance
animation will ship frozen. Add the real class names to
`codegen.stripClasses` and re-run `npm run codegen`.

### `captureMode` — which markup codegen builds from (read this)

The capture writes **two** HTML files, and choosing wrong causes a whole class
of visible duplication bugs:

| File | What it is |
|---|---|
| `scrape/raw/index.static.html` | The pre-JS server response. Pristine. |
| `scrape/raw/index.html` | The **rendered** DOM after the page's JS ran. |

A rendered capture contains whatever the site's own JS had already *done*:
clone nodes appended into containers, headings split into per-word spans,
absolutely-positioned overlay clones left mid-animation. **Stripping runtime
classes and inline styles does not remove those — they are nodes, not state.**
They then ship as permanent copies *and* get regenerated at runtime, so the
replica renders animated elements twice. Worse, the sanitizer strips the
`opacity: 0` that was keeping a transient clone invisible, so a clone the real
site never shows becomes permanently visible.

`captureMode` (top level of `replica.config.json`) controls the source:

- `"auto"` (default) — uses the static file only when it passes **two**
  independent ratio tests against the rendered DOM: ≥70% as many elements, and
  ≥90% as many *asset-bearing* nodes (`img`/`video`/`source`/`iframe` etc.).
  Right for nearly every server-rendered site (Webflow, WordPress, Framer,
  Astro, Next SSG).

  The asset ratio exists because element count alone is a bad proxy. On
  cash.app/bank the static file had 97% of the elements (comfortably over the
  element threshold) but only **5 of 31** images — the promo-card `<img>` nodes
  are injected after hydration into `<figure>` hosts that carry
  `background-color:#000000`. `auto` picked `static` and shipped five hero/promo
  cards as **solid black empty boxes**. Nothing errored; `typecheck`, `test`,
  `build` and even `viewports` all passed, because the boxes were laid out
  correctly — they just had no image in them. Only the pixel diff caught it.
  A near-perfect element ratio therefore proves nothing about assets; judge them
  separately.
- `"static"` — always use the pre-JS response. Best when you have confirmed
  the site is server-rendered.
- `"rendered"` — always use the rendered DOM. Necessary for genuine
  client-rendered SPAs where the static file is an empty shell.

Codegen prints the choice and **both** ratios every run; check that line. If it
used `rendered` on a site you believe is server-rendered, investigate before
building on top of it. If it used `static` and any hero/card area renders as a
flat block of one colour, suspect the asset ratio first.

Switching to `rendered` on a Next.js target can bake in that framework's own
runtime a11y node, `<next-route-announcer>`, as a bogus top-level section — it
fails `tsc` as an unknown JSX intrinsic. It is in `DEFAULT_DROP_SELECTORS`; if
you meet another framework's equivalent, add it there rather than hand-editing
generated output.

When you are stuck on `rendered` (real SPA), two config-driven escape hatches
remove baked runtime nodes generically:

- `codegen.emptySelectors` — elements that are pure **hosts** for runtime
  children (a clone container). Shipped childless and stripped of inline
  `style`.
- `codegen.unwrapSelectors` — runtime-generated **wrappers** around authored
  content (per-word/per-letter split spans, typewriter carets). Replaced by
  their own children, restoring the pristine text so the site's JS can re-split
  it at runtime.

Both default to a marker attribute only (`[data-replica-empty]` /
`[data-replica-unwrap]`), so they are inert until you name real selectors.

---

## Step 5 — Tune `app/ClientRuntime.tsx`

This is the one file you are expected to hand-edit. The captured markup is inert;
this is where the page comes back to life.

1. Enable the effects `features.json` says the site uses. The pure-DOM ones
   (fade-in, nav toggle/scroll/dropdown, tabs, accordion, counters, marquee,
   lazy images, forms, smooth anchors) are already listed and self-disable when
   their targets are absent.
2. Fix the fade-in active class if the site's isn't `faded-in`:
   `createFadeIn({ activeClass: 'is-visible' })`. Get the real name from the
   captured CSS — guessing here is the #1 cause of an invisible page.
3. For library-backed effects, install the exact detected version, then
   uncomment the adapter line:
   - `createCarousel({ load: () => import('swiper/bundle') })`
   - `createRive({ load: () => import('@rive-app/webgl2') })` — **the renderer
     build must match what the site used**; a webgl2 `.riv` renders blank under
     `@rive-app/canvas` with no error at all.
   - `createLottie({ load: () => import('lottie-web') })`
4. Add site-specific effects as new modules in `app/lib/`, keeping the
   `EffectInit` contract (no-op without targets, return a teardown, idempotent
   under React strict mode).

### Viewport-swapped assets: the capture only ever saw one width

The capture runs at **one** viewport (desktop). Any asset the site chooses
*client-side by media query* is therefore captured in its desktop variant only,
and the other variants were never even requested — so they are not in
`asset-map.json` and not on disk. The replica then shows desktop media at phone
widths. This is invisible to `typecheck`/`test`/`build`/`viewports` (the images
load fine, they are simply the wrong ones); only `compare` at a phone viewport
reveals it.

Two flavours, both seen on cash.app/bank:

- **`<video>` with `sources[{mediaQuery, src}]`** — the elements ship with no
  `src` at all, so the replica shows blank boxes until you re-implement the
  chooser.
- **`<img>` swapped to a genuinely different file** — the mobile hero was a
  *different photograph*, not a rescale or a smart crop. Do not assume
  responsive images are the same picture at another size.

Handling it:

1. Confirm it is a real swap, not CSS. Probe the **live** page at several widths
   with a throwaway script in `scrape/` (gitignored) and read back
   `img.currentSrc` / `naturalWidth`. Import Playwright from
   `scripts/lib/chromium.mjs` (`findChromium()`/`launch()`) — the project
   vendors `playwright-core`, so a bare `import 'playwright'` fails.
2. Pin the breakpoint from the site's **own source**, not by bisecting. Grep the
   captured JS for the breakpoint table; cash.app defined
   `let i="760px"` then `parseInt(i,10)-1`, giving `max-width:759px`, which also
   appears verbatim in its CSS. A guessed breakpoint is a permanent 1px-off bug.
3. Add every missing variant URL to `extraAssets` in `replica.config.json` (with
   a `_extraAssets` comment saying why) and re-run `npm run scrape`. Confirm the
   file count on disk actually grew.
4. Derive the desktop→variant path mapping **mechanically** from
   `scrape/asset-map.json`, never by hand. Filenames lie: the mobile asset for
   one card was literally named `Bank_Desktop_2UP_001_2.png`.
5. Write the effect with a `matchMedia` listener so it also reacts to live
   resize/rotation, keying off a `data-` attribute that remembers the original
   src so repeated init is idempotent.
6. Add a drift test that re-derives the table from the build artifacts: assert
   every desktop path is actually present in `app/generated/*.tsx` (asset hashes
   change on re-scrape, and a stale path silently matches nothing), every
   variant resolves through `asset-map.json`, every file exists in `public/`, and
   every variant is listed in `extraAssets` so a future scrape cannot drop it.

### Beware: the sanitizer strips `webflow.js`, and it was suppressing clicks

Webflow widget controls are anchors whose href names an element to *reveal*, not
a place to scroll: a tab link is `<a href="#w-tabs-0-data-w-pane-0" role="tab">`,
and lightbox/dropdown triggers have the same shape. On the live site `webflow.js`
binds these and calls `preventDefault()`. The sanitizer drops `webflow.js`, so in
the replica **nothing suppresses that href any more**. Two failure modes follow,
and they are easy to miss because neither logs an error:

1. **A generic smooth-anchor effect will bind them.** `initSmoothAnchors` now
   excludes `.w-tab-link, [role="tab"], [data-w-tab], [aria-controls]`,
   `[data-tab], .w-dropdown-toggle, .w-lightbox, [data-fancybox]`. Keep that
   exclusion list in sync if you add widget effects.
2. **Any handler you hand-write for a widget control must call
   `preventDefault()` itself** to stand in for the `webflow.js` that no longer
   exists, or the browser performs native fragment navigation.

This is nastier than a normal cosmetic bug because carousel/tab autoplay scripts
routinely synthesise `tab.click()` on a timer (coframe.com fires one every 4s).
Either failure mode then re-scrolls the page to that widget *forever*, so a
reader who scrolls past it is dragged back every few seconds and effectively
cannot read the rest of the page. Nothing in `tsc`, the unit tests, or the
viewport gate catches it — the page is structurally perfect and simply refuses to
stay scrolled.

**How to check:** with the section's autoplay confirmed *armed* (park on it until
the active tab advances on its own — the `IntersectionObserver` usually needs it
50% visible), scroll well past it, wait through 3+ autoplay ticks, then assert
`window.scrollY` has not moved and `location.hash` is still empty. Verifying from
a cold jump past the section proves nothing: autoplay never armed, so the timer
that causes the bug never ran.

---

## Step 6 — The verification gate (all of it, in order)

Everything below must pass. Do not report success on a partial gate.

```bash
npm run verify      # tsc --noEmit + vitest + next build, all clean
npm run viewports   # 7-viewport browser audit — must exit 0
```

`npm run viewports` gates on: horizontal overflow, oversized elements, the
burger/desktop nav swap, canvas backing-store and paint state, animation trigger
counts pre/post scroll, carousel init, broken images, console errors, failed
requests, **duplicated visible headings**, and **any remote (non-self-hosted)
request**.

The `duplicate-visible-text` check is the gate for the baked-runtime-node bug
described under `captureMode` in Step 4. It tallies `h1/h2/h3` text and flags
any string rendered **visibly more than once**, walking ancestors for
`display`/`visibility`/`opacity` so transient clones parked at `opacity: 0`
(which real sites legitimately keep in the DOM) do not false-positive. If the
live site genuinely shows duplicate headings, baseline it in
`replica.baseline.json` under `duplicateVisibleText` per viewport.

Then the side-by-side visual comparison:

```bash
npm run dev &       # server must be up for the local screenshots
npm run compare     # writes [local | live | diff] composites per viewport
```

Read the composites with `read_image` and actually look at them. **A non-zero
diff percentage is expected** — A/B-tested copy, live counters, cookie banners
and font rasterization all differ between runs. Judge *where* the diff is
concentrated: 0.4% spread evenly is fine, 0.4% concentrated in the hero is a real
bug. Iterate until the remaining diff is explainable, and say in your summary
what remains and why.

If the live site itself overflows or has a layout quirk, record it in
`replica.baseline.json` rather than "fixing" it. A replica that fixes the
original's bugs is no longer a replica.

### Definition of done

- `tsc --noEmit` clean.
- `next build` clean.
- Generated vitest suite green.
- 7/7 viewports pass (`npm run viewports` exits 0).
- Zero broken images, zero remote requests, zero console errors.
- Zero duplicated visible headings beyond what live itself shows.
- **Verify duplication against the live site, in the browser, not by counting
  nodes.** Element/attribute counts are not evidence: the site's own JS creates
  transient clones, so a raw count differs from live for entirely correct
  reasons. Measure whether text is *visibly* rendered twice, run the identical
  measurement on the live page, and treat live as the arbiter. Also check the
  live DOM, not just generated JSX — codegen and the runtime port can each
  produce this symptom independently.
- Side-by-side comparison screenshots produced, reviewed, and any residual
  difference explained.

---

## Step 7 — Tear everything down

Before writing your final message:

- Stop the dev server (kill the background `next dev`; confirm the port is free).
- Close every browser window/tab the pipeline or your own `browser` tool calls
  opened. Nothing should be left running.

---

## Step 8 — Write memory (mandatory, both scopes)

1. **Project scope** — a per-site note titled e.g.
   `Website replica — example.com/product/analytics`, covering: the URL and
   folder slug; the port; libraries installed and why; the exact
   `replica.config.json` overrides needed; which effects were enabled and any
   custom active-class names; every bug hit and its fix; the final gate results
   and residual visual diff; anything a future run against this same site should
   know first.
2. **Global scope** — append genuinely **cross-site** lessons to
   `Website replica lessons`. Read it first and merge; never clobber it. Only
   durable, transferable knowledge belongs here (a new runtime-artifact class
   worth stripping by default, a font-hosting trap, a renderer-build mismatch) —
   site-specific trivia stays in the project note.

If you improved the vendored template, record that in the global note too.

Write both notes as if the folder you just built will be **unreadable** to your
successor — because under the rule above, it will be. Anything a future run
needs must be stated *in the note*, not left to be inferred from the code.

---

## Step 9 — Final message requirements

The last message must include, explicitly:

1. The exact command to launch the server, with the directory:
   ```bash
   cd <slug> && npm run dev
   ```
2. The localhost URL **including the port**: `http://localhost:3300`
3. The full gate results (typecheck / build / tests / viewports / visual diff).
4. Any residual visual difference and why it's acceptable.
5. Confirmation that the dev server and browser windows were shut down.
6. Which memory notes you wrote.

---

## Hard rules

- **Never** read or copy code from another replica folder in this workspace.
  Memory notes and this run's own capture are the only legitimate inputs (see
  "Never build from another run in this repo").
- **Never** hardcode site-specific values into `scripts/**`. They stay
  URL-agnostic; site knowledge lives in `replica.config.json`.
- **Never** hand-edit `app/generated/**` — codegen overwrites it. Fix the config
  or the generator instead.
- **Never** reorder the CSS `@import` list. Cascade order is load-bearing and
  reordering silently breaks layout in ways that are painful to debug.
- **Never** let a form POST to the original endpoint. `app/lib/forms.ts`
  intercepts submissions locally; keep it that way.
- Single page only. Internal links are rewritten to absolute live-site URLs;
  in-page `#anchors` stay local.
- Use `read_file`/`edit_file`/`write_file`/`multi_write` for all file authoring.
  Shell redirection into files is blocked on Windows.
