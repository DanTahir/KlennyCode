import { NOOP, STAGGER_MS, all, claim, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-reveal]';
const MARKER = 'Reveal';

/**
 * Scroll-in reveals. The hidden state lives in CSS under `html.js`, so this
 * module only ever ADDS the `.revealed` class.
 */
export function mountReveal(): Teardown {
  const els = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (els.length === 0) return NOOP;

  const revealAll = () => els.forEach((el) => el.classList.add('revealed'));

  // Reduced motion (or no IO support): make everything visible immediately.
  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
    revealAll();
    return NOOP;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target as HTMLElement;
        const tier = el.dataset.fadeDelay;
        const delay = tier ? (STAGGER_MS[tier] ?? 0) : 0;
        el.style.setProperty('--reveal-delay', `${delay}ms`);
        el.classList.add('revealed');
        io.unobserve(el);
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
  );

  els.forEach((el) => io.observe(el));
  return () => io.disconnect();
}
