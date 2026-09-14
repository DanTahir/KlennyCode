import { NOOP, all, claim, easeOutCubic, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-counter]';
const MARKER = 'Counter';
const DURATION_MS = 1500;

function render(el: HTMLElement, value: number): string {
  const decimals = Number(el.dataset.counterDecimals ?? '0');
  const prefix = el.dataset.counterPrefix ?? '';
  const suffix = el.dataset.counterSuffix ?? '';
  const safeDecimals = Number.isFinite(decimals) ? Math.min(3, Math.max(0, decimals)) : 0;
  return `${prefix}${value.toFixed(safeDecimals)}${suffix}`;
}

function target(el: HTMLElement): number {
  const to = Number(el.dataset.counterTo ?? '0');
  return Number.isFinite(to) ? to : 0;
}

/** Count-up stats. Reduced motion renders the final value immediately. */
export function mountCounters(): Teardown {
  const els = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (els.length === 0) return NOOP;

  const settle = (el: HTMLElement) => {
    el.textContent = render(el, target(el));
  };

  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
    els.forEach(settle);
    return NOOP;
  }

  const frames = new Set<number>();

  const run = (el: HTMLElement) => {
    const to = target(el);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      el.textContent = render(el, to * easeOutCubic(t));
      if (t < 1) {
        frames.add(requestAnimationFrame(tick));
      } else {
        settle(el);
      }
    };
    frames.add(requestAnimationFrame(tick));
  };

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        run(entry.target as HTMLElement);
        io.unobserve(entry.target);
      });
    },
    { threshold: 0.4 },
  );

  els.forEach((el) => {
    el.textContent = render(el, 0);
    io.observe(el);
  });

  return () => {
    io.disconnect();
    frames.forEach((id) => cancelAnimationFrame(id));
    frames.clear();
  };
}
