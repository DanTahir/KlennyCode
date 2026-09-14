# Klenny Code — Marketing Site

Standalone Next.js (App Router, TypeScript, Tailwind) marketing site for Klenny Code, statically
exported and deployed to `klennycode.com` via S3 + CloudFront. Lives alongside `agent/` but is a
fully separate app with its own dependencies — not part of a workspace.

## Structure

```
app/layout.tsx        next/font (Inter + Sora), metadata/OG, mounts <Effects />
app/page.tsx          server component — composes components/sections/* in order
app/globals.css       CSS custom props, reveal states, keyframes, reduced-motion + .no-js
components/sections/  Nav, Hero, ModelMarquee, PrimaryScreenshot, Stats, HowItWorks,
                      FeatureGrid, PawprintsSpotlight, ScreenshotPair, DownloadCta, Footer
components/           Effects.tsx ('use client' effect mount), ScreenshotFrame.tsx,
                      Feature.tsx (size-variant feature card), DownloadButtons.tsx
lib/effects/          9 dependency-free effect modules + shared.ts + index.ts registry
```

`app/page.tsx` must stay a **server** component so `getLatestRelease()` resolves at build time
via `readFileSync`. All interactivity lives in `components/Effects.tsx`.

## Animation system

No animation libraries. `lib/effects/` holds one small module per effect — `reveal`,
`wordReveal`, `typewriter`, `counters`, `marquee`, `spotlight`, `navScroll`, `tilt`, `cardGlow` —
built on IntersectionObserver, CSS and the Web Animations API. Each module no-ops when its
targets are absent, guards against React strict-mode double-mount with a `data-*` marker, and
returns a teardown. `index.ts` runs them all from a single `useEffect` after hydration.

Two invariants worth knowing before editing them:

- **Under `prefers-reduced-motion`, reveals apply their final *visible* state immediately** rather
  than doing nothing. The reveal class is what makes content visible, so skipping it would
  permanently hide real copy.
- **`.no-js` in `globals.css` keeps everything visible when JS never runs.** `layout.tsx` has an
  inline script that swaps `no-js` for `js` on `<html>`; if you remove it, content stays visible
  (fail-open), which is the intended direction.

## Assets

Generated artwork in `public/`: `hero-aurora.png` (hero backdrop), `og-card.png` (1536×864 social
card — keep the `width`/`height` in `layout.tsx` metadata in sync with the real file),
`pawprints-art.png`, `memory-art.png`, `scheduler-art.png`. Film grain is an inline SVG
`feTurbulence` data URI in `globals.css`, not a bitmap — `stitchTiles="stitch"` makes it seamless
for free.

Product screenshots (`KlennyScreenshot1/2/3.png`, `KlennyCodePawprints.png`) all go through
`components/ScreenshotFrame.tsx`. **Every one of them already contains a real Windows titlebar**,
so that component deliberately has no fixed height, no `object-fit` crop and no negative offsets —
`overflow-hidden` is there only so the border radius clips the corners. Don't add fake macOS
traffic-light chrome back on top of authentic product chrome, and don't crop the titlebars off.

Feature icons are emoji on purpose: crisp at every DPI, zero bytes, and they read correctly to
screen readers.

## Local development

```bash
bun install
bun run fetch-latest-release   # writes generated/latest-release.json (gitignored)
bun run dev
```

`generated/latest-release.json` is required by `app/page.tsx` at build/render time. It's
regenerated automatically as part of `bun run build` (see `"prebuild"` in `package.json`), but for
`next dev` you need to run `fetch-latest-release` once yourself first. If the file is missing,
`lib/getLatestRelease.ts` falls back to generic GitHub releases-page links so the app still
renders.

## Production build

```bash
bun run build   # fetch-latest-release -> next build (static export to out/)
```

Outputs a static site to `out/`. No server runtime — the whole thing is deployed to S3 behind
CloudFront (see `.github/workflows/deploy-web.yml` at the repo root).

## How download links work

`scripts/fetch-latest-release.ts` calls the GitHub Releases API for `DanTahir/KlennyCode` and
matches the latest release's assets against per-platform filename patterns (electron-builder
stamps the app version into every filename, so there's no static "latest" URL that works). The
result is written to `generated/latest-release.json` and read at build time by
`lib/getLatestRelease.ts` — resolution happens once, at build time, not client-side on every page
load.

## Deployment

Handled entirely by `.github/workflows/deploy-web.yml`, which redeploys whenever:

- `web/**` changes on `main`,
- a new GitHub release is published (so download links stay current),
- the app's release build workflow (`Build Klenny Code`) finishes successfully, or
- it's triggered manually via `workflow_dispatch`.

Auth to AWS uses GitHub OIDC (no stored access keys). Required repo secrets:
`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `S3_BUCKET_NAME`, `CLOUDFRONT_DISTRIBUTION_ID`.
