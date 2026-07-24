# Klenny Code — Marketing Site

Standalone Next.js (App Router, TypeScript, Tailwind) marketing site for Klenny Code, statically
exported and deployed to `klennycode.com` via S3 + CloudFront. Lives alongside `agent/` but is a
fully separate app with its own dependencies — not part of a workspace.

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
