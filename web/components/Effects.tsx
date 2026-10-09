'use client';

import { useEffect } from 'react';
import { mountEffects, type Teardown } from '@/lib/effects';
import { INTRO_DONE_EVENT } from '@/lib/intro';

/** If the intro never reports back, mount anyway so revealed copy can't stay hidden. */
const INTRO_WAIT_CAP_MS = 25000;

/**
 * Single mount point for the effect registry, rendered once from layout.tsx.
 *
 * It runs inside useEffect -- after hydration, never during render -- so
 * app/page.tsx can stay a server component and keep resolving
 * getLatestRelease() at build time. Renders no DOM of its own.
 *
 * While the intro video is playing (html.intro without intro-out), mounting is
 * deferred until INTRO_DONE_EVENT so the hero's entrance animations play as
 * the page fades in, rather than invisibly underneath the overlay.
 */
export default function Effects() {
  useEffect(() => {
    const root = document.documentElement;
    let teardown: Teardown | null = null;
    let cap: number | undefined;

    const start = () => {
      window.removeEventListener(INTRO_DONE_EVENT, start);
      window.clearTimeout(cap);
      if (!teardown) teardown = mountEffects();
    };

    if (root.classList.contains('intro') && !root.classList.contains('intro-out')) {
      window.addEventListener(INTRO_DONE_EVENT, start);
      cap = window.setTimeout(start, INTRO_WAIT_CAP_MS);
    } else {
      start();
    }

    return () => {
      window.removeEventListener(INTRO_DONE_EVENT, start);
      window.clearTimeout(cap);
      teardown?.();
    };
  }, []);
  return null;
}
