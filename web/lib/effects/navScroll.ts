import { NOOP, all, claim, type Teardown } from './shared';

const SELECTOR = '[data-nav]';
const MARKER = 'Nav';
const THRESHOLD_PX = 50;

/**
 * Transparent -> frosted nav. Runs once on mount so a page restored mid-scroll
 * (or a reload with a hash) gets the correct state immediately. Not gated on
 * reduced motion: this is a state change, not motion, and the transition is
 * already neutralised by the global reduced-motion block.
 */
export function mountNavScroll(): Teardown {
  const navs = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (navs.length === 0) return NOOP;

  let frame = 0;

  const apply = () => {
    frame = 0;
    const scrolled = window.scrollY > THRESHOLD_PX;
    navs.forEach((nav) => nav.classList.toggle('is-scrolled', scrolled));
  };

  const onScroll = () => {
    if (frame === 0) frame = requestAnimationFrame(apply);
  };

  apply();
  window.addEventListener('scroll', onScroll, { passive: true });

  return () => {
    window.removeEventListener('scroll', onScroll);
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
