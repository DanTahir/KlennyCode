/**
 * Shared helpers for the dependency-free effect modules in this directory.
 *
 * Contract every module follows:
 *  - no-op when its target elements are absent
 *  - guard against React strict-mode double-mount via a data-* marker
 *  - return a teardown function
 *  - under prefers-reduced-motion, apply the FINAL VISIBLE STATE rather than
 *    doing nothing (the reveal class is what makes content visible, so
 *    skipping it would permanently hide real copy)
 */

export type Teardown = () => void;
export type EffectFactory = () => Teardown;

export const NOOP: Teardown = () => {};

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Strict-mode double-mount guard. Returns true only the first time a given
 * element is claimed for a given effect, so a second mount doesn't re-split
 * words, re-clone marquee children, or stack duplicate listeners.
 */
export function claim(el: Element, marker: string): boolean {
  const host = el as HTMLElement;
  const key = `klenny${marker}`;
  if (host.dataset[key] === '1') return false;
  host.dataset[key] = '1';
  return true;
}

export function all<T extends HTMLElement>(selector: string): T[] {
  if (typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll<T>(selector));
}

/** data-fade-delay stagger tiers, in milliseconds. */
export const STAGGER_MS: Record<string, number> = {
  s: 400,
  m: 800,
  l: 1200,
  xl: 1600,
};

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
