/**
 * Adapters for library-backed effects.
 *
 * The template ships ZERO animation/carousel dependencies, because which ones
 * a given page needs is only known after `npm run extras` reports what the
 * original loaded. Rather than guessing, each adapter takes a `load` callback
 * that dynamically imports the library, so:
 *
 *   - the template type-checks and builds with nothing extra installed;
 *   - installing the exact detected version wires the effect up in one line;
 *   - a missing library degrades to a logged warning, not a crashed page.
 *
 * Usage in ClientRuntime.tsx (only after `npm i swiper`):
 *
 *   createCarousel({ load: () => import('swiper/bundle') })
 */
import { $all, type Teardown } from './runtime';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModule = any;

export interface CarouselOptions {
  /** Dynamic import of the carousel library, e.g. () => import('swiper/bundle'). */
  load: () => Promise<AnyModule>;
  rootSelector?: string;
  /** Passed straight through to the library constructor. */
  params?: Record<string, unknown>;
  /** Pick the constructor out of the module (default: Swiper-shaped). */
  pick?: (mod: AnyModule) => AnyModule;
}

/**
 * Initialises a Swiper-compatible carousel on every matching root.
 * Mirrors the original page's own `new Swiper(el, params)` call.
 */
export function createCarousel(options: CarouselOptions) {
  const {
    load,
    rootSelector = '.swiper, [class*="swiper-container"]',
    params = { slidesPerView: 'auto', loop: true, speed: 600 },
    pick = (mod) => mod.Swiper ?? mod.default ?? mod,
  } = options;

  return function initCarousel(root: ParentNode = document): Teardown | void {
    const roots = $all(rootSelector, root);
    if (!roots.length) return;

    let disposed = false;
    const instances: AnyModule[] = [];

    void load()
      .then((mod) => {
        if (disposed) return;
        const Ctor = pick(mod);
        if (typeof Ctor !== 'function') {
          console.warn('[replica] carousel module had no usable constructor');
          return;
        }
        for (const el of roots) {
          try {
            instances.push(new Ctor(el, params));
          } catch (err) {
            console.warn('[replica] carousel failed to initialise on', el, err);
          }
        }
      })
      .catch((err) => {
        console.warn(
          '[replica] carousel library not installed — slides will render statically.',
          err,
        );
      });

    return () => {
      disposed = true;
      for (const inst of instances) {
        try {
          inst.destroy?.(true, true);
        } catch {
          /* library teardown is best-effort */
        }
      }
    };
  };
}

export interface RiveOptions {
  /** e.g. () => import('@rive-app/webgl2') — MUST match the build the page used. */
  load: () => Promise<AnyModule>;
  canvasSelector?: string;
  /** Local .riv path; defaults to the element's data-rive-url. */
  src?: string;
  /** Self-hosted wasm from `npm run extras`. */
  wasmUrl?: string;
  stateMachines?: string;
  artboard?: string;
  autoplay?: boolean;
}

/**
 * Mounts a Rive animation on a <canvas>.
 *
 * Two hard-won constraints (see the global "website replica lessons" memory):
 *  1. The RENDERER BUILD MUST MATCH. A .riv exported for webgl2 renders blank
 *     under @rive-app/canvas, with no error. Use whatever `npm run extras`
 *     detected.
 *  2. Point RuntimeLoader at the self-hosted wasm, or the page silently
 *     reaches out to unpkg at runtime and breaks the offline guarantee.
 */
export function createRive(options: RiveOptions) {
  const {
    load,
    canvasSelector = 'canvas[data-rive-url], canvas[data-rive]',
    src,
    wasmUrl = '/assets/rive/rive-webgl2.wasm',
    stateMachines,
    artboard,
    autoplay = true,
  } = options;

  return function initRive(root: ParentNode = document): Teardown | void {
    const canvases = $all<HTMLCanvasElement>(canvasSelector, root);
    if (!canvases.length) return;

    let disposed = false;
    const instances: AnyModule[] = [];

    void load()
      .then((rive) => {
        if (disposed) return;

        try {
          rive.RuntimeLoader?.setWasmUrl?.(wasmUrl);
        } catch {
          /* older runtimes lack the setter */
        }

        for (const canvas of canvases) {
          const file = src ?? canvas.dataset.riveUrl;
          if (!file) continue;
          try {
            instances.push(
              new rive.Rive({
                src: file,
                canvas,
                autoplay,
                artboard,
                stateMachines,
                // Required for the webgl2 build to share one GL context.
                useOffscreenRenderer: true,
                onLoad: () => {
                  // Match the canvas backing store to its CSS box, or the
                  // animation renders blurry / at the wrong scale.
                  instances[instances.length - 1]?.resizeDrawingSurfaceToCanvas?.();
                },
              }),
            );
          } catch (err) {
            console.warn('[replica] Rive failed to initialise on', canvas, err);
          }
        }
      })
      .catch((err) => {
        console.warn(
          '[replica] Rive runtime not installed — canvas will stay blank. ' +
            'Install the build reported by `npm run extras`.',
          err,
        );
      });

    return () => {
      disposed = true;
      for (const inst of instances) {
        try {
          inst.cleanup?.();
        } catch {
          /* best-effort */
        }
      }
    };
  };
}

export interface LottieOptions {
  /** e.g. () => import('lottie-web') */
  load: () => Promise<AnyModule>;
  containerSelector?: string;
  /** Local JSON path; defaults to the element's data-lottie. */
  path?: string;
  loop?: boolean;
  autoplay?: boolean;
  renderer?: 'svg' | 'canvas' | 'html';
}

export function createLottie(options: LottieOptions) {
  const {
    load,
    containerSelector = '[data-lottie], [data-animation-url]',
    path,
    loop = true,
    autoplay = true,
    renderer = 'svg',
  } = options;

  return function initLottie(root: ParentNode = document): Teardown | void {
    const containers = $all(containerSelector, root);
    if (!containers.length) return;

    let disposed = false;
    const instances: AnyModule[] = [];

    void load()
      .then((mod) => {
        if (disposed) return;
        const lottie = mod.default ?? mod;
        for (const container of containers) {
          const animationPath = path ?? container.dataset.lottie ?? container.dataset.animationUrl;
          if (!animationPath) continue;
          try {
            instances.push(
              lottie.loadAnimation({ container, renderer, loop, autoplay, path: animationPath }),
            );
          } catch (err) {
            console.warn('[replica] Lottie failed on', container, err);
          }
        }
      })
      .catch((err) => {
        console.warn('[replica] lottie-web not installed — animation container left empty.', err);
      });

    return () => {
      disposed = true;
      for (const inst of instances) {
        try {
          inst.destroy?.();
        } catch {
          /* best-effort */
        }
      }
    };
  };
}
