/**
 * Miscellaneous pure-DOM effects that recur across marketing pages.
 * Every one is dependency-free and no-ops when its targets are absent.
 */
import { $all, prefersReducedMotion, rafThrottle, type Teardown } from './runtime';

/** CSS-driven infinite marquee: duplicates children so the loop is seamless. */
export function createMarquee(
  options: { selector?: string; trackSelector?: string; copies?: number } = {},
) {
  const {
    selector = '[class*="marquee"], [class*="ticker"], [data-marquee]',
    trackSelector = '[class*="track"], [class*="inner"], [data-marquee-track]',
    copies = 2,
  } = options;

  return function initMarquee(root: ParentNode = document): Teardown | void {
    const marquees = $all(selector, root);
    if (!marquees.length) return;

    const restore: Array<() => void> = [];

    for (const marquee of marquees) {
      const track = marquee.querySelector<HTMLElement>(trackSelector) ?? marquee;
      // Idempotency guard: strict mode would otherwise duplicate twice.
      if (track.dataset.marqueeCloned === 'true') continue;

      const originals = Array.from(track.children);
      if (!originals.length) continue;

      for (let i = 1; i < copies; i += 1) {
        for (const child of originals) {
          const clone = child.cloneNode(true) as HTMLElement;
          clone.setAttribute('aria-hidden', 'true');
          clone.dataset.marqueeClone = 'true';
          track.appendChild(clone);
        }
      }
      track.dataset.marqueeCloned = 'true';

      restore.push(() => {
        for (const clone of $all('[data-marquee-clone="true"]', track)) clone.remove();
        delete track.dataset.marqueeCloned;
      });
    }

    return () => restore.forEach((r) => r());
  };
}

/** Tabbed panels: Webflow `.w-tab-*` and generic role=tab markup. */
export function createTabs(
  options: {
    tabSelector?: string;
    paneSelector?: string;
    activeTabClass?: string;
    activePaneClass?: string;
  } = {},
) {
  const {
    tabSelector = '.w-tab-link, [role="tab"], [data-tab]',
    paneSelector = '.w-tab-pane, [role="tabpanel"], [data-tab-pane]',
    activeTabClass = 'w--current',
    activePaneClass = 'w--tab-active',
  } = options;

  return function initTabs(root: ParentNode = document): Teardown | void {
    const tabs = $all(tabSelector, root);
    const panes = $all(paneSelector, root);
    if (tabs.length < 2 || !panes.length) return;

    const activate = (index: number) => {
      tabs.forEach((t, i) => {
        t.classList.toggle(activeTabClass, i === index);
        t.setAttribute('aria-selected', String(i === index));
      });
      panes.forEach((p, i) => p.classList.toggle(activePaneClass, i === index));
    };

    const handlers = tabs.map((tab, i) => {
      const h = (e: Event) => {
        e.preventDefault();
        activate(i);
      };
      tab.addEventListener('click', h);
      return { tab, h };
    });

    // Only assert an initial tab if the captured markup had none.
    if (!tabs.some((t) => t.classList.contains(activeTabClass))) activate(0);

    return () => handlers.forEach(({ tab, h }) => tab.removeEventListener('click', h));
  };
}

/** Accordions built from divs (native <details> needs no JS). */
export function createAccordion(
  options: {
    itemSelector?: string;
    triggerSelector?: string;
    contentSelector?: string;
    openClass?: string;
    single?: boolean;
  } = {},
) {
  const {
    itemSelector = '[data-accordion-item], .accordion-item, .faq-item',
    triggerSelector = '[data-accordion-trigger], .accordion-trigger, button, .accordion-header',
    contentSelector = '[data-accordion-content], .accordion-content, .accordion-body',
    openClass = 'is-open',
    single = true,
  } = options;

  return function initAccordion(root: ParentNode = document): Teardown | void {
    const items = $all(itemSelector, root);
    if (!items.length) return;

    const cleanups: Array<() => void> = [];

    items.forEach((item) => {
      const trigger = item.querySelector<HTMLElement>(triggerSelector);
      const content = item.querySelector<HTMLElement>(contentSelector);
      if (!trigger) return;

      const onClick = (e: Event) => {
        e.preventDefault();
        const willOpen = !item.classList.contains(openClass);
        if (single && willOpen) {
          for (const other of items) {
            other.classList.remove(openClass);
            const oc = other.querySelector<HTMLElement>(contentSelector);
            if (oc) oc.style.maxHeight = '';
          }
        }
        item.classList.toggle(openClass, willOpen);
        trigger.setAttribute('aria-expanded', String(willOpen));
        // Only drive max-height when the CSS did not already handle it.
        if (content) content.style.maxHeight = willOpen ? `${content.scrollHeight}px` : '';
      };

      trigger.addEventListener('click', onClick);
      cleanups.push(() => trigger.removeEventListener('click', onClick));
    });

    return () => cleanups.forEach((c) => c());
  };
}

/** Numeric count-up when a stat scrolls into view. */
export function createCounters(
  options: { selector?: string; durationMs?: number; attribute?: string } = {},
) {
  const {
    selector = '[data-counter], [data-count-to]',
    durationMs = 1600,
    attribute = 'data-count-to',
  } = options;

  return function initCounters(root: ParentNode = document): Teardown | void {
    const targets = $all(selector, root);
    if (!targets.length) return;

    const parseTarget = (el: HTMLElement) => {
      const raw = el.getAttribute(attribute) ?? el.textContent ?? '0';
      return Number(String(raw).replace(/[^0-9.-]/g, '')) || 0;
    };

    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      for (const el of targets) el.textContent = String(parseTarget(el));
      return;
    }

    const frames: number[] = [];

    const run = (el: HTMLElement) => {
      const end = parseTarget(el);
      const suffix = (el.dataset.counterSuffix ?? '').toString();
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / durationMs);
        // easeOutCubic: fast then settling, which reads as "counting up".
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = `${Math.round(end * eased).toLocaleString()}${suffix}`;
        if (p < 1) frames.push(requestAnimationFrame(tick));
      };
      frames.push(requestAnimationFrame(tick));
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          run(entry.target as HTMLElement);
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.4 },
    );
    for (const el of targets) observer.observe(el);

    return () => {
      observer.disconnect();
      for (const f of frames) cancelAnimationFrame(f);
    };
  };
}

/** Transform-based parallax driven by scroll position. */
export function createParallax(
  options: { selector?: string; speedAttribute?: string; defaultSpeed?: number } = {},
) {
  const {
    selector = '[data-parallax], [class*="parallax"]',
    speedAttribute = 'data-parallax-speed',
    defaultSpeed = 0.2,
  } = options;

  return function initParallax(root: ParentNode = document): Teardown | void {
    const targets = $all(selector, root);
    if (!targets.length || prefersReducedMotion()) return;

    const onScroll = rafThrottle(() => {
      const viewportH = window.innerHeight;
      for (const el of targets) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > viewportH) continue;
        const speed = Number(el.getAttribute(speedAttribute)) || defaultSpeed;
        const centreOffset = rect.top + rect.height / 2 - viewportH / 2;
        el.style.transform = `translate3d(0, ${(-centreOffset * speed).toFixed(2)}px, 0)`;
      }
    });

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      for (const el of targets) el.style.transform = '';
    };
  };
}

/** Promotes data-src/data-srcset to real attributes as images approach. */
export function createLazyImages(options: { selector?: string; rootMargin?: string } = {}) {
  const { selector = 'img[data-src], img[data-srcset], [data-bg]', rootMargin = '200px' } = options;

  return function initLazyImages(root: ParentNode = document): Teardown | void {
    const targets = $all(selector, root);
    if (!targets.length) return;

    const promote = (el: HTMLElement) => {
      const src = el.dataset.src;
      const srcset = el.dataset.srcset;
      const bg = el.dataset.bg;
      if (src && el instanceof HTMLImageElement) el.src = src;
      if (srcset && el instanceof HTMLImageElement) el.srcset = srcset;
      if (bg) el.style.backgroundImage = `url(${bg})`;
      el.classList.add('is-loaded');
    };

    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach(promote);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          promote(entry.target as HTMLElement);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin },
    );
    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  };
}

/** Character-by-character typewriter cycling through phrases. */
export function createTypewriter(
  options: {
    selector?: string;
    phrasesAttribute?: string;
    typeMs?: number;
    eraseMs?: number;
    holdMs?: number;
  } = {},
) {
  const {
    selector = '[data-typewriter]',
    phrasesAttribute = 'data-typewriter',
    typeMs = 70,
    eraseMs = 35,
    holdMs = 1800,
  } = options;

  return function initTypewriter(root: ParentNode = document): Teardown | void {
    const targets = $all(selector, root);
    if (!targets.length) return;

    const timers: number[] = [];

    for (const el of targets) {
      const raw = el.getAttribute(phrasesAttribute) ?? '';
      const phrases = raw.split('|').map((s) => s.trim()).filter(Boolean);
      if (phrases.length === 0) continue;

      if (prefersReducedMotion()) {
        el.textContent = phrases[0];
        continue;
      }

      let phraseIndex = 0;
      let charIndex = 0;
      let erasing = false;

      const step = () => {
        const phrase = phrases[phraseIndex];
        if (!erasing) {
          charIndex += 1;
          el.textContent = phrase.slice(0, charIndex);
          if (charIndex >= phrase.length) {
            erasing = true;
            timers.push(window.setTimeout(step, holdMs));
            return;
          }
          timers.push(window.setTimeout(step, typeMs));
        } else {
          charIndex -= 1;
          el.textContent = phrase.slice(0, Math.max(0, charIndex));
          if (charIndex <= 0) {
            erasing = false;
            phraseIndex = (phraseIndex + 1) % phrases.length;
          }
          timers.push(window.setTimeout(step, eraseMs));
        }
      };

      timers.push(window.setTimeout(step, typeMs));
    }

    return () => timers.forEach((t) => window.clearTimeout(t));
  };
}

export const initMarquee = createMarquee();
export const initTabs = createTabs();
export const initAccordion = createAccordion();
export const initCounters = createCounters();
export const initParallax = createParallax();
export const initLazyImages = createLazyImages();
export const initTypewriter = createTypewriter();
