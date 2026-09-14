import { NOOP, all, claim, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-word-reveal]';
const MARKER = 'Wr';

/**
 * Wraps every word in a `.wr-word` span carrying its index in `--wr-i`, which
 * CSS turns into a staggered blur-to-sharp entrance. Walks nested elements so
 * inline markup (a coloured <span>, a <br/>) survives intact.
 */
function wrapWords(node: Node, counter: { i: number }): void {
  Array.from(node.childNodes).forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (text.trim() === '') return;
      const frag = document.createDocumentFragment();
      // Keep whitespace runs as real text nodes so spacing is preserved.
      text.split(/(\s+)/).forEach((part) => {
        if (part === '') return;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
          return;
        }
        const span = document.createElement('span');
        span.className = 'wr-word';
        span.style.setProperty('--wr-i', String(counter.i));
        span.textContent = part;
        counter.i += 1;
        frag.appendChild(span);
      });
      node.replaceChild(frag, child);
      return;
    }

    if (child.nodeType === Node.ELEMENT_NODE) {
      // Don't re-split spans we already created.
      if ((child as HTMLElement).classList?.contains('wr-word')) return;
      wrapWords(child, counter);
    }
  });
}

export function mountWordReveal(): Teardown {
  const els = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (els.length === 0) return NOOP;

  els.forEach((el) => wrapWords(el, { i: 0 }));

  const runAll = () => els.forEach((el) => el.classList.add('wr-run'));

  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
    runAll();
    return NOOP;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('wr-run');
        io.unobserve(entry.target);
      });
    },
    { threshold: 0.2 },
  );

  els.forEach((el) => io.observe(el));
  return () => io.disconnect();
}
