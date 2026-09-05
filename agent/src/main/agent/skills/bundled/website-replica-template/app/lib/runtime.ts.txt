/**
 * Effect registry.
 *
 * The captured markup is static: every behaviour the original page's JavaScript
 * provided has to be re-implemented here. Each effect is an independent
 * `EffectInit` that finds its own targets by selector and returns a teardown
 * function, so effects can be enabled per-site without touching this file.
 *
 * Two rules every effect must follow:
 *  1. No-op silently when its targets are absent (a site without a carousel
 *     must not throw).
 *  2. Be idempotent — React strict mode mounts effects twice in development.
 */

export type Teardown = () => void;
export type EffectInit = (root?: ParentNode) => Teardown | void;

export interface RegisteredEffect {
  name: string;
  init: EffectInit;
}

/** True when the visitor asked for reduced motion; several effects honour it. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** rAF-throttled wrapper for scroll/resize handlers. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void) {
  let queued = false;
  let lastArgs: A;
  return (...args: A) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

export function $all<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/**
 * Runs every effect, collecting teardowns. A throwing effect is logged and
 * skipped rather than taking the whole page down with it.
 */
export function initEffects(effects: RegisteredEffect[], root: ParentNode = document): Teardown {
  const teardowns: Teardown[] = [];
  for (const { name, init } of effects) {
    try {
      const t = init(root);
      if (typeof t === 'function') teardowns.push(t);
    } catch (err) {
      console.error(`[replica] effect "${name}" failed to initialise:`, err);
    }
  }
  return () => {
    for (const t of teardowns) {
      try {
        t();
      } catch {
        /* teardown must never throw during unmount */
      }
    }
  };
}
