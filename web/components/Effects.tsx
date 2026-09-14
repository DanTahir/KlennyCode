'use client';

import { useEffect } from 'react';
import { mountEffects } from '@/lib/effects';

/**
 * Single mount point for the effect registry, rendered once from layout.tsx.
 *
 * It runs inside useEffect -- after hydration, never during render -- so
 * app/page.tsx can stay a server component and keep resolving
 * getLatestRelease() at build time. Renders no DOM of its own.
 */
export default function Effects() {
  useEffect(() => mountEffects(), []);
  return null;
}
