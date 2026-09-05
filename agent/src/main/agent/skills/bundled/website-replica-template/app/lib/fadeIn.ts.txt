/**
 * Scroll-triggered entrance animations.
 *
 * The captured CSS almost always already contains the transition and the
 * finished state (e.g. `.fade-in { opacity: 0 } .fade-in.faded-in { opacity: 1 }`).
 * The original page's JS added `faded-in` via IntersectionObserver; codegen
 * strips that class from the captured DOM, and this puts it back at the right
 * moment. Without this, everything with a fade class stays invisible forever.
 */
import { $all, prefersReducedMotion, type Teardown } from './runtime';

export interface FadeInOptions {
  /** Elements to observe. */
  selector?: string;
  /** Class the site's CSS uses for the finished state. */
  activeClass?: string;
  /** Fraction of the element that must be visible. */
  threshold?: number;
  /** Shift the trigger line; negative bottom fires slightly before entry. */
  rootMargin?: string;
  /** Per-item delay for a stagger effect, in ms. 0 disables. */
  staggerMs?: number;
  /** Re-hide when scrolled back out (most sites animate once). */
  repeat?: boolean;
}

export function createFadeIn(options: FadeInOptions = {}) {
  const {
    selector = '.fade-in, [data-fade], [data-animate]',
    activeClass = 'faded-in',
    threshold = 0.15,
    rootMargin = '0px 0px -10% 0px',
    staggerMs = 0,
    repeat = false,
  } = options;

  return function initFadeIn(root: ParentNode = document): Teardown | void {
    const targets = $all(selector, root);
    if (!targets.length) return;

    // With reduced motion, show everything immediately rather than animating.
    if (prefersReducedMotion()) {
      for (const el of targets) el.classList.add(activeClass);
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      for (const el of targets) el.classList.add(activeClass);
      return;
    }

    const timers: number[] = [];

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            if (staggerMs > 0) {
              const index = targets.indexOf(el);
              timers.push(
                window.setTimeout(() => el.classList.add(activeClass), index * staggerMs),
              );
            } else {
              el.classList.add(activeClass);
            }
            if (!repeat) observer.unobserve(el);
          } else if (repeat) {
            el.classList.remove(activeClass);
          }
        }
      },
      { threshold, rootMargin },
    );

    for (const el of targets) {
      // Already-visible elements (above the fold) must not wait for a scroll.
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      for (const t of timers) window.clearTimeout(t);
    };
  };
}

export const initFadeIn = createFadeIn();
