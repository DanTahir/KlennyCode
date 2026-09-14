import { NOOP, all, claim, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-spotlight]';
const MARKER = 'Spot';

/**
 * Cursor-follow glow. Writes --x/--y (percentages) on the host element; the
 * radial mask that consumes them lives in .spotlight-layer in globals.css,
 * which has sensible static defaults, so skipping this under reduced motion
 * simply leaves a centred, non-reactive glow.
 */
export function mountSpotlight(): Teardown {
  const hosts = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (hosts.length === 0 || prefersReducedMotion()) return NOOP;

  const cleanups: Teardown[] = [];

  hosts.forEach((host) => {
    let frame = 0;
    let cx = 0;
    let cy = 0;

    const flush = () => {
      frame = 0;
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      host.style.setProperty('--x', `${((cx - rect.left) / rect.width) * 100}%`);
      host.style.setProperty('--y', `${((cy - rect.top) / rect.height) * 100}%`);
    };

    const onMove = (event: PointerEvent) => {
      cx = event.clientX;
      cy = event.clientY;
      if (frame === 0) frame = requestAnimationFrame(flush);
    };

    host.addEventListener('pointermove', onMove, { passive: true });
    cleanups.push(() => {
      host.removeEventListener('pointermove', onMove);
      if (frame !== 0) cancelAnimationFrame(frame);
    });
  });

  return () => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  };
}
