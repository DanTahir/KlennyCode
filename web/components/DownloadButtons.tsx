'use client';

import { useEffect, useState } from 'react';
import type { LatestReleaseData, PlatformKey } from '@/lib/getLatestRelease';
import GithubIcon from './GithubIcon';

const GITHUB_URL = 'https://github.com/DanTahir/KlennyCode';

interface Props {
  release: LatestReleaseData;
  /** Show a secondary "View on GitHub" button next to the primary download CTA. */
  showGithubButton?: boolean;
  /** Center the whole block (default) or left-align it (used in the hero). */
  align?: 'center' | 'left';
}

const PLATFORM_META: Record<
  PlatformKey,
  { label: string; sub: string; icon: string }
> = {
  windows: { label: 'Windows', sub: '10 / 11 — installer (.exe)', icon: '🪟' },
  macos: { label: 'macOS', sub: 'Apple Silicon — .dmg', icon: '🍎' },
  linux: { label: 'Linux', sub: 'Portable — .AppImage', icon: '🐧' },
};

function detectPlatform(): PlatformKey | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux') || ua.includes('x11')) return 'linux';
  return null;
}

function formatSize(bytes: number | null): string | null {
  if (!bytes) return null;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export default function DownloadButtons({ release, showGithubButton, align = 'center' }: Props) {
  const [detected, setDetected] = useState<PlatformKey | null>(null);

  useEffect(() => {
    setDetected(detectPlatform());
  }, []);

  // Fall back to Windows as the headline CTA on first paint / unknown OS —
  // most visitors land here from a browser we can't sniff or from a link,
  // and Windows is the most common desktop OS among our users.
  const primary = detected ?? 'windows';

  const order: PlatformKey[] = [primary, ...(['windows', 'macos', 'linux'] as PlatformKey[]).filter((p) => p !== primary)];

  const items = align === 'left' ? 'items-start' : 'items-center';
  const justify = align === 'left' ? 'justify-start' : 'justify-center';

  return (
    <div className={`flex flex-col gap-4 ${items}`}>
      <div className={`flex flex-wrap gap-3 ${justify}`}>
        <a
          href={release.platforms[primary].url}
          className="inline-flex items-center gap-2 rounded-full bg-corgi-orange px-8 py-3 text-base font-semibold text-corgi-dark shadow-lg shadow-orange-900/30 transition hover:brightness-110"
        >
          <span aria-hidden>{PLATFORM_META[primary].icon}</span>
          Download for {PLATFORM_META[primary].label}
          {release.version && <span className="text-corgi-dark/70">({release.version})</span>}
        </a>

        {showGithubButton && (
          <a
            href={GITHUB_URL}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-6 py-3 text-base font-medium text-corgi-cream transition hover:border-white/30 hover:bg-white/10"
          >
            <GithubIcon />
            View on GitHub
          </a>
        )}
      </div>

      <div className={`flex flex-wrap gap-3 ${justify}`}>
        {order.map((key) => {
          const asset = release.platforms[key];
          const meta = PLATFORM_META[key];
          const size = formatSize(asset.sizeBytes);
          return (
            <a
              key={key}
              href={asset.url}
              className={`group flex flex-col items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm transition hover:border-corgi-orange/60 hover:bg-white/10 ${
                align === 'left' ? 'min-w-[140px]' : 'min-w-[180px]'
              }`}
            >
              <span className="flex items-center gap-2 font-medium text-corgi-cream">
                <span aria-hidden>{meta.icon}</span>
                {meta.label}
              </span>
              <span className="text-xs text-corgi-cream/60">
                {meta.sub}
                {size ? ` · ${size}` : ''}
              </span>
            </a>
          );
        })}
      </div>

      <a
        href={release.releasesPageUrl}
        className="text-xs text-corgi-cream/50 underline decoration-dotted hover:text-corgi-cream/80"
      >
        Or browse all releases on GitHub →
      </a>
    </div>
  );
}
