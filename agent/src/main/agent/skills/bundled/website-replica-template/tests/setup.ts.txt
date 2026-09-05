/**
 * Shared jsdom setup.
 *
 * jsdom implements neither IntersectionObserver nor ResizeObserver, and both
 * are load-bearing for the effect modules. The IO mock keeps a registry so a
 * test can drive intersection deterministically instead of waiting on scroll:
 *
 *   const el = document.querySelector('.fade-in')!;
 *   initFadeIn(document);
 *   triggerIntersection(el);            // element enters the viewport
 *   expect(el.classList.contains('faded-in')).toBe(true);
 */

type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void;

interface MockRecord {
  callback: IOCallback;
  observer: IntersectionObserver;
  targets: Set<Element>;
}

const records: MockRecord[] = [];

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [0];

  private record: MockRecord;

  constructor(callback: IOCallback, options?: IntersectionObserverInit) {
    this.rootMargin = options?.rootMargin ?? '';
    this.record = { callback, observer: this, targets: new Set() };
    records.push(this.record);
  }

  observe(target: Element): void {
    this.record.targets.add(target);
  }
  unobserve(target: Element): void {
    this.record.targets.delete(target);
  }
  disconnect(): void {
    this.record.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** Fires an intersection event for `target` on every observer watching it. */
export function triggerIntersection(target: Element, isIntersecting = true): void {
  for (const record of records) {
    if (!record.targets.has(target)) continue;
    const entry = {
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      time: Date.now(),
    } as IntersectionObserverEntry;
    record.callback([entry], record.observer);
  }
}

/** Number of live observers — useful for asserting teardown actually ran. */
export function observedElementCount(): number {
  return records.reduce((n, r) => n + r.targets.size, 0);
}

export function resetObservers(): void {
  records.length = 0;
}

class MockResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// jsdom has no matchMedia; default to "motion allowed" so effects run.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Run rAF callbacks immediately so effects need no fake timers.
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  cb(performance.now());
  return 1;
}) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
