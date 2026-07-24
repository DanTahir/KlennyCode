import { readFileSync } from 'node:fs';
import path from 'node:path';

export type PlatformKey = 'windows' | 'macos' | 'linux';

export interface ResolvedAsset {
  url: string;
  fileName: string | null;
  sizeBytes: number | null;
}

export interface LatestReleaseData {
  version: string | null;
  publishedAt: string | null;
  releasesPageUrl: string;
  resolvedAt: string;
  platforms: Record<PlatformKey, ResolvedAsset>;
}

const RELEASES_PAGE_URL = 'https://github.com/DanTahir/KlennyCode/releases/latest';

function emptyFallback(): LatestReleaseData {
  const asset: ResolvedAsset = { url: RELEASES_PAGE_URL, fileName: null, sizeBytes: null };
  return {
    version: null,
    publishedAt: null,
    releasesPageUrl: RELEASES_PAGE_URL,
    resolvedAt: new Date(0).toISOString(),
    platforms: { windows: asset, macos: { ...asset }, linux: { ...asset } },
  };
}

/**
 * Reads the build-time-generated latest-release.json (written by
 * scripts/fetch-latest-release.ts, which always runs before `next build`
 * via the "prebuild" script). Falls back to generic release-page links if
 * the file is missing, e.g. during local `next dev` before the script has
 * been run once — this never happens in CI, where prebuild always runs
 * first.
 */
export function getLatestRelease(): LatestReleaseData {
  try {
    const filePath = path.resolve(process.cwd(), 'generated', 'latest-release.json');
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as LatestReleaseData;
  } catch {
    return emptyFallback();
  }
}

export function formatBytes(bytes: number | null): string | null {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}
