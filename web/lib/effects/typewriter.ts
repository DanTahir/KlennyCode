import { NOOP, all, claim, prefersReducedMotion, type Teardown } from './shared';

const SELECTOR = '[data-typewriter]';
const MARKER = 'Tw';

const TYPE_MS = 52;
const ERASE_MS = 26;
const HOLD_MS = 1700;
const GAP_MS = 320;

function parsePhrases(el: HTMLElement): string[] {
  const raw = el.dataset.phrases;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
  } catch {
    return [];
  }
}

/**
 * Rotating hero line. Under reduced motion it renders the first phrase
 * statically and starts no timers at all.
 */
export function mountTypewriter(): Teardown {
  const els = all(SELECTOR).filter((el) => claim(el, MARKER));
  if (els.length === 0) return NOOP;

  const timers: ReturnType<typeof setTimeout>[] = [];
  const reduced = prefersReducedMotion();

  els.forEach((el) => {
    const phrases = parsePhrases(el);
    if (phrases.length === 0) return;

    const out = el.querySelector<HTMLElement>('[data-typewriter-out]') ?? el;

    if (reduced) {
      out.textContent = phrases[0];
      return;
    }

    let phraseIndex = 0;
    let charIndex = 0;
    let erasing = false;

    const step = (): void => {
      const phrase = phrases[phraseIndex];
      out.textContent = phrase.slice(0, charIndex);

      if (!erasing) {
        if (charIndex < phrase.length) {
          charIndex += 1;
          timers.push(setTimeout(step, TYPE_MS));
        } else {
          erasing = true;
          timers.push(setTimeout(step, HOLD_MS));
        }
        return;
      }

      if (charIndex > 0) {
        charIndex -= 1;
        timers.push(setTimeout(step, ERASE_MS));
      } else {
        erasing = false;
        phraseIndex = (phraseIndex + 1) % phrases.length;
        timers.push(setTimeout(step, GAP_MS));
      }
    };

    step();
  });

  return () => {
    timers.forEach((t) => clearTimeout(t));
    timers.length = 0;
  };
}
