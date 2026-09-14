import { NOOP, all, claim, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-marquee]';
const MARKER = 'Marquee';
const DEFAULT_DURATION_MS = 26000;

/**
 * Seamless ticker. The original children are cloned exactly once, so
 * translateX(-50%) lands precisely on the start of the duplicate set and the
 * loop has no visible seam. The clones are aria-hidden to avoid duplicate
 * announcements.
 */
export function mountMarquee(): Teardown {
  const tracks = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (tracks.length === 0) return NOOP;

  const animations: Animation[] = [];

  tracks.forEach((track) => {
    const originals = Array.from(track.children);
    if (originals.length === 0) return;

    originals.forEach((child) => {
      const clone = child.cloneNode(true) as HTMLElement;
      clone.setAttribute('aria-hidden', 'true');
      track.appendChild(clone);
    });

    if (prefersReducedMotion() || typeof track.animate !== 'function') return;

    const parsed = Number(track.dataset.marqueeDuration ?? '');
    const duration = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DURATION_MS;

    animations.push(
      track.animate(
        [{ transform: 'translate3d(0, 0, 0)' }, { transform: 'translate3d(-50%, 0, 0)' }],
        { duration, iterations: Infinity, easing: 'linear' },
      ),
    );
  });

  return () => {
    animations.forEach((a) => a.cancel());
    animations.length = 0;
  };
}
