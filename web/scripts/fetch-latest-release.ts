/**
 * Build-time script: looks up the latest published GitHub release for
 * DanTahir/KlennyCode and resolves a direct download URL for each platform
 * (Windows installer, macOS DMG, Linux AppImage).
 *
 * Runs before `next build` (see package.json "prebuild"/"build" scripts) so
 * the resulting links are baked into the static export — no client-side
 * fetch, no CORS/rate-limit concerns for site visitors.
 *
 * electron-builder stamps the version number into every asset filename
 * (e.g. Klenny-Code-Setup-0.2.50.exe), so a static "latest/download/<name>"
 * URL would break the moment the version changes. Instead we ask the GitHub
 * API for the actual latest release and match asset filenames by pattern.
 *
 * If anything goes wrong (network error, no matching asset, GitHub API
 * down), we fall back to linking every platform at the generic releases
 * page so a GitHub hiccup never breaks the site build.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OWNER = 'DanTahir';
const REPO = 'KlennyCode';
const RELEASES_PAGE_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

type PlatformKey = 'windows' | 'macos' | 'linux';

interface ResolvedAsset {
  url: string;
  fileName: string | null;
  sizeBytes: number | null;
}

interface LatestReleaseData {
  version: string | null;
  publishedAt: string | null;
  releasesPageUrl: string;
  resolvedAt: string;
  platforms: Record<PlatformKey, ResolvedAsset>;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  published_at: string;
  assets: GithubAsset[];
}

function fallbackData(): LatestReleaseData {
  const fallbackAsset: ResolvedAsset = {
    url: RELEASES_PAGE_URL,
    fileName: null,
    sizeBytes: null,
  };
  return {
    version: null,
    publishedAt: null,
    releasesPageUrl: RELEASES_PAGE_URL,
    resolvedAt: new Date().toISOString(),
    platforms: {
      windows: { ...fallbackAsset },
      macos: { ...fallbackAsset },
      linux: { ...fallbackAsset },
    },
  };
}

function pickAsset(assets: GithubAsset[], patterns: RegExp[]): GithubAsset | null {
  for (const pattern of patterns) {
    const match = assets.find((asset) => pattern.test(asset.name));
    if (match) return match;
  }
  return null;
}

function resolvePlatformAssets(assets: GithubAsset[]): Record<PlatformKey, ResolvedAsset> {
  const windows = pickAsset(assets, [
    /Setup.*\.exe$/i,
    /^(?!.*\.blockmap$).*\.exe$/i,
  ]);
  const macos = pickAsset(assets, [/-arm64\.dmg$/i, /\.dmg$/i]);
  const linux = pickAsset(assets, [/\.AppImage$/i]);

  const toResolved = (asset: GithubAsset | null): ResolvedAsset =>
    asset
      ? { url: asset.browser_download_url, fileName: asset.name, sizeBytes: asset.size }
      : { url: RELEASES_PAGE_URL, fileName: null, sizeBytes: null };

  return {
    windows: toResolved(windows),
    macos: toResolved(macos),
    linux: toResolved(linux),
  };
}

async function fetchLatestRelease(): Promise<LatestReleaseData> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'klennycode-web-build',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(API_URL, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API responded with ${res.status} ${res.statusText}`);
  }

  const release = (await res.json()) as GithubRelease;
  const platforms = resolvePlatformAssets(release.assets ?? []);

  return {
    version: release.tag_name ?? null,
    publishedAt: release.published_at ?? null,
    releasesPageUrl: RELEASES_PAGE_URL,
    resolvedAt: new Date().toISOString(),
    platforms,
  };
}

async function main() {
  let data: LatestReleaseData;
  try {
    data = await fetchLatestRelease();
    console.log(
      `[fetch-latest-release] Resolved release ${data.version ?? '(unknown)'}:`,
      JSON.stringify(data.platforms, null, 2),
    );
  } catch (err) {
    console.warn(
      '[fetch-latest-release] Falling back to generic releases page — could not resolve latest release:',
      err instanceof Error ? err.message : err,
    );
    data = fallbackData();
  }

  const outDir = path.resolve(import.meta.dirname, '..', 'generated');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, 'latest-release.json'),
    JSON.stringify(data, null, 2) + '\n',
    'utf-8',
  );
  console.log('[fetch-latest-release] Wrote web/generated/latest-release.json');
}

main().catch((err) => {
  console.error('[fetch-latest-release] Unexpected fatal error:', err);
  process.exit(1);
});
