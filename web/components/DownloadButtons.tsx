'use client';

import { useEffect, useState } from 'react';
import type { LatestReleaseData, PlatformKey } from '@/lib/getLatestRelease';

interface Props {
  release: LatestReleaseData;
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

export default function DownloadButtons({ release }: Props) {
  const [detected, setDetected] = useState<PlatformKey | null>(null);

  useEffect(() => {
    setDetected(detectPlatform());
  }, []);

  const order: PlatformKey[] = detected
    ? [detected, ...(['windows', 'macos', 'linux'] as PlatformKey[]).filter((p) => p !== detected)]
    : ['windows', 'macos', 'linux'];

  return (
    <div className="flex flex-col items-center gap-4">
      {detected && (
        <a
          href={release.platforms[detected].url}
          className="inline-flex items-center gap-2 rounded-full bg-corgi-orange px-8 py-3 text-base font-semibold text-corgi-dark shadow-lg shadow-orange-900/30 transition hover:brightness-110"
        >
          <span aria-hidden>{PLATFORM_META[detected].icon}</span>
          Download for {PLATFORM_META[detected].label}
          {release.version && (
            <span className="text-corgi-dark/70">({release.version})</span>
          )}
        </a>
      )}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {order.map((key) => {
          const asset = release.platforms[key];
          const meta = PLATFORM_META[key];
          const size = formatSize(asset.sizeBytes);
          return (
            <a
              key={key}
              href={asset.url}
              className="group flex min-w-[180px] flex-col items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm transition hover:border-corgi-orange/60 hover:bg-white/10"
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
