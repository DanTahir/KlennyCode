import { NOOP, all, claim, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-card-glow]';
const MARKER = 'Glow';

/**
 * Pointer-tracking border glow. Writes --mx/--my per card; the gradient ring
 * that reads them is .glow-card::before in globals.css and defaults to the
 * card centre, so this is purely additive polish.
 */
export function mountCardGlow(): Teardown {
  const cards = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (cards.length === 0 || prefersReducedMotion()) return NOOP;

  const cleanups: Teardown[] = [];

  cards.forEach((card) => {
    let frame = 0;
    let cx = 0;
    let cy = 0;

    const flush = () => {
      frame = 0;
      const rect = card.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      card.style.setProperty('--mx', `${((cx - rect.left) / rect.width) * 100}%`);
      card.style.setProperty('--my', `${((cy - rect.top) / rect.height) * 100}%`);
    };

    const onMove = (event: PointerEvent) => {
      cx = event.clientX;
      cy = event.clientY;
      if (frame === 0) frame = requestAnimationFrame(flush);
    };

    card.addEventListener('pointermove', onMove, { passive: true });
    cleanups.push(() => {
      card.removeEventListener('pointermove', onMove);
      if (frame !== 0) cancelAnimationFrame(frame);
    });
  });

  return () => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };
}
