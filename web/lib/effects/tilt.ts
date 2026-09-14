import { NOOP, all, clamp, claim, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-tilt]';
const MARKER = 'Tilt';
const MAX_DEG = 7;

/**
 * Scroll-linked straighten: the screenshot starts slightly tipped back and
 * rotates flat as it scrolls into view. Writes --tilt, consumed by
 * .tilt-frame. Reduced motion pins it to 0deg (and CSS also hard-disables the
 * transform), so the image is never left skewed.
 */
export function mountTilt(): Teardown {
  const els = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (els.length === 0) return NOOP;

  const flatten = () => els.forEach((el) => el.style.setProperty('--tilt', '0deg'));

  if (prefersReducedMotion()) {
    flatten();
    return NOOP;
  }

  let frame = 0;

  const update = () => {
    frame = 0;
    const vh = window.innerHeight || 1;
    els.forEach((el) => {
      const rect = el.getBoundingClientRect();
      // 0 while the element's top is still at the bottom edge of the viewport,
      // 1 once it has travelled 75% of a viewport height upward.
      const progress = clamp((vh - rect.top) / (vh * 0.75), 0, 1);
      el.style.setProperty('--tilt', `${((1 - progress) * MAX_DEG).toFixed(2)}deg`);
    });
  };

  const onScroll = () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };

  update();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);

  return () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    if (frame !== 0) cancelAnimationFrame(frame);
    flatten();
  };
}
