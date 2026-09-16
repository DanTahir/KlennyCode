#!/usr/bin/env node
/**
 * Stage 7 — side-by-side visual comparison against the live page, all the way
 * down the page and all the way back up.
 *
 * The pixel maths runs inside a headless page on a <canvas> (the screenshots
 * are handed over as base64 data URLs), which means NO image-decoding npm
 * dependency — Chromium is already here and already decodes PNG.
 *
 * Modes
 * -----
 *   sweep (default)  Scroll BOTH pages through the entire document in
 *                    viewport-height steps, diffing at each step, then repeat
 *                    the same offsets on the way back up. One
 *                    [local | live | diff] composite per slice per direction.
 *   --full           One whole-page (stitched) screenshot per side, diffed as
 *                    a single tall composite.
 *   --fold           Above-the-fold only. Fast smoke check, blind to most of a
 *                    marketing page.
 *
 * Why sweep is the default
 * ------------------------
 * A fold-only diff certifies the hero and nothing else: a broken footer, a
 * mid-page carousel that never initialised, or an entrance animation stuck at
 * `opacity: 0` all still score 0.00%. A single stitched full-page shot covers
 * the page but reads badly — the two pages are never exactly the same height,
 * so a few extra pixels of padding near the top shift EVERYTHING below them and
 * the diff saturates, hiding what is actually wrong; `position: fixed` navs also
 * render once at the top of a stitched shot instead of following the viewport.
 * Slicing at equal scroll offsets keeps every band comparable and localises a
 * regression to "laptop, scrolled to y=3600".
 *
 * Why the upward pass
 * -------------------
 * Plenty of replica bugs only appear when a section is reached while scrolling
 * up: IntersectionObserver reveals that fire once and leave content invisible on
 * the way back, sticky/hide-on-scroll navs, scroll-direction-aware parallax,
 * media that lazy-swapped in late. Re-diffing the same offsets in the other
 * direction surfaces those as a per-slice direction delta instead of averaging
 * them away.
 *
 * Where the time goes (and what was done about it)
 * -----------------------------------------------
 * A 7-viewport, 2-direction, 10-slice sweep is 140 slices, and this script used
 * to do every part of every slice strictly one at a time. Three structural
 * changes, none of which alters what is measured:
 *
 *  1. LOCKSTEP SIDES. The local and live pages are independent, so they now
 *     scroll and shoot together via Promise.all instead of local-then-live.
 *     This is not only ~2x faster on the dominant term, it is more FAITHFUL:
 *     previously the live shot was taken ~700ms after the local one, so live
 *     counters, autoplaying carousels and video frames were compared across a
 *     time gap that had nothing to do with the replica.
 *  2. LANES. Viewports are independent too, so `--lanes=N` runs several at once,
 *     each with its own page pair AND its own diff worker (a single shared
 *     worker page serialised every diff in the run). Roughly half the wall clock
 *     here is a settle timer, which parallelises for free. See lib/perf.mjs for
 *     why the default is capped rather than "all of them".
 *  3. THE COMPOSITE IS OFF THE CRITICAL PATH. The diff NUMBERS come from raw
 *     pixel data; the [local|live|diff] composite is a human-review artifact
 *     produced afterwards. So it is encoded as JPEG (~4x faster to encode and
 *     ~10x smaller to ship back over CDP than PNG) and queued through a bounded
 *     pipeline, overlapping with the next slice's scroll. `--png-composites`
 *     restores lossless output.
 *
 * One thing lanes deliberately do NOT parallelise: the initial cold load of the
 * LIVE page, throttled separately by `--live-lanes` (default 2). Four
 * simultaneous cold loads of a heavy marketing site made one of them fail to
 * lay out at all, which the sweep then reported as a huge replica regression —
 * see createGate in lib/perf.mjs. A live page that still lays out implausibly
 * short is reloaded, and if it stays short the viewport is marked
 * `liveLoadSuspect` and excluded from the average instead of being presented as
 * a finding.
 *
 * The compared SCREENSHOTS remain PNG on purpose. Encoding those as JPEG would
 * inject content-dependent artifacts around text edges that can exceed the
 * colour threshold, inflating diff% on text-heavy pages — that is the one
 * "optimisation" here that would trade away measurement quality.
 *
 * Interpreting the numbers
 * ------------------------
 * A replica of a live marketing page will never be 0.00%: many sites A/B-test
 * their own copy, rotate testimonials, or render "N customers" counters, and
 * fonts rasterise a hair differently once self-hosted. What matters is WHERE the
 * difference is. Open the worst slices' composites and use the diff column to
 * see whether a delta is text content (expected) or layout/geometry (a real
 * bug).
 *
 * Usage:
 *   node scripts/compare-live.mjs [--url=http://localhost:3300]
 *        [--only=iphone-se,laptop] [--threshold=32] [--slices=10]
 *        [--settle=500] [--down-only] [--full] [--fold]
 *        [--lanes=N] [--live-lanes=N] [--png-composites]
 */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { launch } from './lib/chromium.mjs';
import { loadConfig, paths, MOBILE_UA } from './lib/config.mjs';
import { createGate, createPipeline, resolveLanes, runLanes, waitForSettle } from './lib/perf.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const urlArg = flag('url');
const onlyArg = flag('only');
const thresholdArg = flag('threshold');
const slicesArg = flag('slices');
const settleArg = flag('settle');
const lanesArg = flag('lanes');

const THRESHOLD = thresholdArg ? Number(thresholdArg) : 32;
/** Cap per direction. Beyond this the offsets are spread evenly over the page
 *  instead of stepping one viewport at a time, so a 20k-pixel page still
 *  finishes in a sane time while keeping top, middle and bottom covered. */
const MAX_SLICES = slicesArg ? Math.max(1, Number(slicesArg)) : 10;
/** Extra settle after each scroll: reveal animations and lazy media need a
 *  beat, and both sides get exactly the same beat. */
const SLICE_SETTLE_MS = settleArg ? Number(settleArg) : 500;
const DOWN_ONLY = args.includes('--down-only');

const MODE = args.includes('--fold') ? 'fold' : args.includes('--full') ? 'full' : 'sweep';

/** Composites are review artifacts, not measurements — see the header note. */
const COMPOSITE = args.includes('--png-composites')
  ? { mime: 'image/png', quality: undefined, ext: 'png' }
  : { mime: 'image/jpeg', quality: 0.92, ext: 'jpg' };

/** Concurrent COLD LOADS of the live page, independent of --lanes. Kept low on
 *  purpose: see createGate in lib/perf.mjs for the failure it prevents. */
const LIVE_LOAD_LANES = Math.max(1, Math.floor(Number(flag('live-lanes')) || 2));
const liveGate = createGate(LIVE_LOAD_LANES);

/** A live document barely taller than the viewport, while the local replica is
 *  multiples of it, means the live page never laid out. */
const looksUnloaded = (liveHeight, localHeight, viewportHeight) =>
  liveHeight <= viewportHeight * 1.3 && localHeight > liveHeight * 2;

async function openSession(browser, url, viewport, cfg) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    // Force dpr 1: we are comparing geometry, and 2x/3x shots triple the
    // pixel work for no extra signal.
    deviceScaleFactor: 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    userAgent: viewport.mobile ? MOBILE_UA : undefined,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  // Adaptive, capped at the configured flat value: fonts ready + no image still
  // loading + a stable document height. A page that really needs the full
  // settleMs still gets it; a page that is ready in 900ms stops waiting.
  const settledMs = await waitForSettle(page, cfg.settleMs ?? 3500);
  return { context, page, settledMs };
}

/**
 * Walk the whole document once before comparing anything: lazy images, fonts
 * and entrance animations below the fold have otherwise never been asked to
 * resolve, and the first real slice would diff a half-painted page. Returns the
 * document height measured AFTER the walk (lazy content changes it).
 */
async function warmUp(page, stepDelay) {
  const height = await page.evaluate(async (delay) => {
    const step = Math.max(200, window.innerHeight);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, delay));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
    return document.documentElement.scrollHeight;
  }, Math.max(60, stepDelay));
  return height;
}

/**
 * Scroll to an offset and report where we actually landed. Smooth-scroll
 * libraries (Lenis, Locomotive) animate `scrollY` toward the target rather than
 * jumping, and short pages clamp, so the achieved offset is read back instead of
 * assumed — comparing a local slice at y=3000 against a live slice at y=2400
 * would manufacture a diff that means nothing.
 */
async function scrollToOffset(page, y, settleMs) {
  return page.evaluate(
    async ({ target, settle }) => {
      window.scrollTo(0, target);
      let last = -1;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        const now = Math.round(window.scrollY);
        if (now === last) break;
        last = now;
      }
      await new Promise((r) => setTimeout(r, settle));
      return Math.round(window.scrollY);
    },
    { target: y, settle: settleMs },
  );
}

async function shootViewport(page) {
  const buf = await page.screenshot({ type: 'png' });
  return buf.toString('base64');
}

async function shootFullPage(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const buf = await page.screenshot({ type: 'png', fullPage: true });
  return buf.toString('base64');
}

/**
 * The scroll offsets to compare, covering the page from top to bottom.
 * Always includes 0 and the bottom-aligned offset, so the footer is never the
 * band nobody looked at.
 */
export function sliceOffsets(pageHeight, viewportHeight, maxSlices) {
  const maxOffset = Math.max(0, Math.floor(pageHeight - viewportHeight));
  if (maxOffset === 0) return [0];

  const naturalCount = Math.floor(maxOffset / viewportHeight) + 2; // steps + bottom-aligned
  const offsets = [];
  if (naturalCount <= maxSlices) {
    for (let y = 0; y < maxOffset; y += viewportHeight) offsets.push(y);
    offsets.push(maxOffset);
  } else {
    const step = maxOffset / (maxSlices - 1);
    for (let i = 0; i < maxSlices; i += 1) offsets.push(Math.round(i * step));
  }
  return [...new Set(offsets)].sort((a, b) => a - b);
}

/**
 * Runs in the page: decode both shots, diff them, return a composite image.
 * Compared over the overlapping region only, since live/local dimensions differ
 * whenever content drifts.
 */
async function diffInPage({ localB64, liveB64, threshold, bands, caption, mime, quality }) {
  const load = (b64) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = `data:image/png;base64,${b64}`;
    });

  const [a, b] = await Promise.all([load(localB64), load(liveB64)]);

  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);

  const ctxOf = (img) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return ctx;
  };

  const da = ctxOf(a).getImageData(0, 0, w, h);
  const db = ctxOf(b).getImageData(0, 0, w, h);

  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = w;
  diffCanvas.height = h;
  const dctx = diffCanvas.getContext('2d');
  const dimg = dctx.createImageData(w, h);

  let differing = 0;
  // Row-level tallies localise a difference to a band within this slice.
  const rowDiff = new Array(h).fill(0);

  for (let i = 0; i < da.data.length; i += 4) {
    const dr = Math.abs(da.data[i] - db.data[i]);
    const dg = Math.abs(da.data[i + 1] - db.data[i + 1]);
    const dbl = Math.abs(da.data[i + 2] - db.data[i + 2]);
    const delta = (dr + dg + dbl) / 3;

    if (delta > threshold) {
      differing += 1;
      rowDiff[Math.floor(i / 4 / w)] += 1;
      dimg.data[i] = 255;
      dimg.data[i + 1] = 0;
      dimg.data[i + 2] = 80;
      dimg.data[i + 3] = 255;
    } else {
      // Keep a dimmed greyscale of the local render as diff background.
      const grey = (da.data[i] + da.data[i + 1] + da.data[i + 2]) / 3;
      const dim = 40 + grey * 0.22;
      dimg.data[i] = dim;
      dimg.data[i + 1] = dim;
      dimg.data[i + 2] = dim;
      dimg.data[i + 3] = 255;
    }
  }
  dctx.putImageData(dimg, 0, 0);

  const diffPct = (differing / (w * h)) * 100;

  // Composite: local | live | diff, with labels.
  const gap = 12;
  const labelH = 26;
  const comp = document.createElement('canvas');
  comp.width = w * 3 + gap * 4;
  comp.height = h + labelH + gap * 2;
  const cctx = comp.getContext('2d');
  cctx.fillStyle = '#111318';
  cctx.fillRect(0, 0, comp.width, comp.height);
  cctx.font = '600 14px system-ui, sans-serif';
  cctx.textBaseline = 'middle';

  const panels = [
    { img: a, label: `LOCAL REPLICA${caption ? ` — ${caption}` : ''}`, color: '#7dd3fc' },
    { img: b, label: `LIVE SITE${caption ? ` — ${caption}` : ''}`, color: '#a7f3d0' },
    { img: diffCanvas, label: `DIFF (${diffPct.toFixed(2)}%)`, color: '#fca5a5' },
  ];
  panels.forEach((p, i) => {
    const x = gap + i * (w + gap);
    cctx.fillStyle = p.color;
    cctx.fillText(p.label, x, gap + labelH / 2);
    cctx.drawImage(p.img, 0, 0, w, h, x, gap + labelH, w, h);
  });

  // Which horizontal bands of this image differ most?
  const bandCount = Math.max(1, bands);
  const bandSize = Math.ceil(h / bandCount);
  const bandStats = [];
  const pctPerBand = 100 / bandCount;
  for (let bi = 0; bi < bandCount; bi += 1) {
    let sum = 0;
    for (let y = bi * bandSize; y < Math.min(h, (bi + 1) * bandSize); y += 1) sum += rowDiff[y];
    bandStats.push({
      band: `${Math.round(bi * pctPerBand)}-${Math.round((bi + 1) * pctPerBand)}%`,
      pct: Number(((sum / (bandSize * w)) * 100).toFixed(2)),
    });
  }

  return {
    width: w,
    height: h,
    localSize: { w: a.width, h: a.height },
    liveSize: { w: b.width, h: b.height },
    diffPct: Number(diffPct.toFixed(3)),
    bands: bandStats,
    composite: comp.toDataURL(mime, quality),
  };
}

const rel = (p) => relative(paths.root, p).split('\\').join('/');

/**
 * One viewport, end to end. Returns the report record plus the console lines to
 * print as a single block — with lanes running concurrently, interleaving each
 * line as it happens would shred the output, so a viewport's report is emitted
 * atomically when it finishes.
 */
async function compareViewport(browser, viewport, cfg, localUrl, outDir, directions) {
  const lines = [];
  const say = (s) => lines.push(s);

  const vpDir = join(outDir, viewport.name);
  mkdirSync(vpDir, { recursive: true });

  const record = {
    viewport: viewport.name,
    width: viewport.width,
    height: viewport.height,
    slices: [],
  };

  let local;
  let live;
  let workerCtx;

  try {
    // A dedicated blank page purely as an image-processing sandbox. One PER
    // LANE: a single shared worker would serialise every diff in the run.
    workerCtx = await browser.newContext({ viewport: { width: 100, height: 100 } });
    const worker = await workerCtx.newPage();
    await worker.goto('about:blank');

    // Both sides in lockstep from here on. The local side loads freely; the
    // live side's COLD LOAD goes through the gate (see createGate).
    const openLocal = async () => {
      const session = await openSession(browser, localUrl, viewport, cfg);
      return { session, height: await warmUp(session.page, cfg.scrollSettleMs) };
    };
    const openLive = async () => {
      const session = await liveGate.run(() =>
        openSession(browser, cfg.targetUrl, viewport, cfg),
      );
      return { session, height: await warmUp(session.page, cfg.scrollSettleMs) };
    };

    const [localAttempt, firstLive] = await Promise.all([openLocal(), openLive()]);
    local = localAttempt.session;
    const localHeight = localAttempt.height;
    live = firstLive.session;
    let liveHeight = firstLive.height;

    // Retrying a live page that never laid out is far better than reporting a
    // 900% height delta as if the replica had caused it.
    let liveLoadAttempts = 1;
    while (looksUnloaded(liveHeight, localHeight, viewport.height) && liveLoadAttempts < 3) {
      say(
        `[${viewport.name}] live page laid out at only ${liveHeight}px` +
          ` — reloading it (attempt ${liveLoadAttempts + 1}/3)`,
      );
      await live.context.close().catch(() => {});
      live = undefined;
      const retry = await openLive();
      live = retry.session;
      liveHeight = retry.height;
      liveLoadAttempts += 1;
    }

    say(
      `[${viewport.name}] local ${localHeight}px / live ${liveHeight}px` +
        `  (settled in ${local.settledMs}/${live.settledMs}ms of ${cfg.settleMs ?? 3500}ms cap` +
        (liveLoadAttempts > 1 ? `, live reloaded ${liveLoadAttempts - 1}x` : '') +
        ')',
    );

    record.localHeight = localHeight;
    record.liveHeight = liveHeight;
    record.heightDeltaPct = Number((((localHeight - liveHeight) / liveHeight) * 100).toFixed(2));
    record.liveLoadAttempts = liveLoadAttempts;
    record.liveLoadSuspect = looksUnloaded(liveHeight, localHeight, viewport.height);
    if (record.liveLoadSuspect) {
      say(
        `[${viewport.name}] LIVE PAGE NEVER LOADED after ${liveLoadAttempts} attempts.` +
          ` Its numbers below are NOT a replica finding — re-run with --live-lanes=1 --lanes=1.`,
      );
    }

    if (MODE !== 'sweep') {
      const fullPage = MODE === 'full';
      const [localB64, liveB64] = await Promise.all([
        fullPage ? shootFullPage(local.page) : shootViewport(local.page),
        fullPage ? shootFullPage(live.page) : shootViewport(live.page),
      ]);
      const diff = await worker.evaluate(diffInPage, {
        localB64,
        liveB64,
        threshold: THRESHOLD,
        bands: 10,
        caption: fullPage ? 'full page' : 'above the fold',
        mime: COMPOSITE.mime,
        quality: COMPOSITE.quality,
      });
      const file = join(vpDir, `${MODE}.${COMPOSITE.ext}`);
      await writeFile(file, Buffer.from(diff.composite.split(',')[1], 'base64'));
      record.slices.push({
        direction: MODE,
        index: 0,
        requestedY: 0,
        localY: 0,
        liveY: 0,
        diffPct: diff.diffPct,
        comparedRegion: { width: diff.width, height: diff.height },
        bands: diff.bands,
        composite: rel(file),
      });
      const worst = [...diff.bands].sort((x, y) => y.pct - x.pct).slice(0, 3);
      say(`         diff ${String(diff.diffPct).padStart(6)}%  -> ${rel(file)}`);
      say(`         worst bands: ${worst.map((bd) => `${bd.band} (${bd.pct}%)`).join(', ')}`);
    } else {
      // Offsets come from the SHORTER page: past that point one side has no
      // pixels at all, and diffing a slice against whatever the other side
      // clamps to produces a fake 90% mismatch instead of a useful signal.
      // The height delta itself is reported separately — that's the real
      // finding when the pages disagree on length.
      const comparableHeight = Math.min(localHeight, liveHeight);
      const offsets = sliceOffsets(comparableHeight, viewport.height, MAX_SLICES);
      record.comparedHeight = Math.min(comparableHeight, offsets[offsets.length - 1] + viewport.height);
      record.coveragePct = Number(((record.comparedHeight / Math.max(1, localHeight)) * 100).toFixed(1));

      // Diff + encode + write is queued rather than awaited, so it overlaps
      // with the next slice's scroll-and-settle. Slots keep the report and the
      // console output in slice order no matter what order they complete in.
      const pipeline = createPipeline(2);
      const sliceSlots = [];
      const logSlots = [];

      for (const direction of directions) {
        const sequence = direction === 'down' ? offsets : [...offsets].reverse();
        for (let i = 0; i < sequence.length; i += 1) {
          const y = sequence[i];
          const [localY, liveY] = await Promise.all([
            scrollToOffset(local.page, y, SLICE_SETTLE_MS),
            scrollToOffset(live.page, y, SLICE_SETTLE_MS),
          ]);
          const [localB64, liveB64] = await Promise.all([
            shootViewport(local.page),
            shootViewport(live.page),
          ]);

          const slot = sliceSlots.length;
          sliceSlots.push(null);
          logSlots.push(null);
          const index = i;
          const total = sequence.length;

          await pipeline.push(async () => {
            const caption = `${direction} y=${y}`;
            const diff = await worker.evaluate(diffInPage, {
              localB64,
              liveB64,
              threshold: THRESHOLD,
              bands: 4,
              caption,
              mime: COMPOSITE.mime,
              quality: COMPOSITE.quality,
            });

            const file = join(
              vpDir,
              `${direction}-${String(index).padStart(2, '0')}-y${y}.${COMPOSITE.ext}`,
            );
            await writeFile(file, Buffer.from(diff.composite.split(',')[1], 'base64'));

            const misalignedBy = Math.abs(localY - liveY);
            sliceSlots[slot] = {
              direction,
              index,
              requestedY: y,
              localY,
              liveY,
              misalignedBy,
              diffPct: diff.diffPct,
              comparedRegion: { width: diff.width, height: diff.height },
              bands: diff.bands,
              composite: rel(file),
            };

            const worst = [...diff.bands].sort((x, z) => z.pct - x.pct)[0];
            logSlots[slot] =
              `         ${direction.padEnd(4)} ${String(index + 1).padStart(2)}/${total}` +
              `  y=${String(y).padStart(6)}  diff ${String(diff.diffPct.toFixed(2)).padStart(6)}%` +
              `  worst band ${worst.band} (${worst.pct}%)` +
              (misalignedBy > 4 ? `  [misaligned ${misalignedBy}px: local ${localY} / live ${liveY}]` : '');
          });
        }
      }

      await pipeline.drain();
      record.slices = sliceSlots.filter(Boolean);
      for (const line of logSlots) if (line) say(line);
    }

    const measured = record.slices.filter((s) => typeof s.diffPct === 'number');
    record.meanDiffPct = measured.length
      ? Number((measured.reduce((s, x) => s + x.diffPct, 0) / measured.length).toFixed(3))
      : 0;
    record.worstSlice = measured.length
      ? [...measured].sort((x, z) => z.diffPct - x.diffPct)[0]
      : null;

    // Same offset, opposite direction: a large gap means the page renders
    // differently depending on how the reader got there (one-shot reveals,
    // hide-on-scroll navs, direction-aware parallax).
    record.directionDeltas = [];
    if (directions.length === 2) {
      for (const y of new Set(record.slices.map((s) => s.requestedY))) {
        const d = record.slices.find((s) => s.direction === 'down' && s.requestedY === y);
        const u = record.slices.find((s) => s.direction === 'up' && s.requestedY === y);
        if (!d || !u) continue;
        const delta = Number(Math.abs(d.diffPct - u.diffPct).toFixed(3));
        record.directionDeltas.push({ y, down: d.diffPct, up: u.diffPct, delta, composites: [d.composite, u.composite] });
      }
      record.directionDeltas.sort((x, z) => z.delta - x.delta);
      const suspicious = record.directionDeltas.filter((x) => x.delta >= 1);
      if (suspicious.length) {
        say(
          `         direction-sensitive offsets: ` +
            suspicious
              .slice(0, 3)
              .map((x) => `y=${x.y} (down ${x.down}% vs up ${x.up}%)`)
              .join(', '),
        );
      }
    }

    say(
      `         mean ${record.meanDiffPct}% over ${measured.length} slice(s)` +
        (record.coveragePct != null ? `, covering ${record.coveragePct}% of the page` : '') +
        `, height delta ${record.heightDeltaPct}%`,
    );
  } catch (err) {
    say(`[${viewport.name}] FAILED: ${err.message}`);
    return { record: { viewport: viewport.name, error: err.message }, lines };
  } finally {
    await local?.context.close().catch(() => {});
    await live?.context.close().catch(() => {});
    await workerCtx?.close().catch(() => {});
  }

  return { record, lines };
}

async function main() {
  const cfg = await loadConfig();
  const localUrl = urlArg ?? `http://localhost:${cfg.port}`;

  let viewports = cfg.viewports;
  if (onlyArg) {
    const wanted = new Set(onlyArg.split(','));
    viewports = viewports.filter((v) => wanted.has(v.name));
  }
  if (!viewports.length) throw new Error(`--only matched no configured viewport (${onlyArg})`);

  const outDir = join(paths.shots, 'compare');
  mkdirSync(outDir, { recursive: true });

  const browser = await launch(chromium);

  const directions = MODE === 'sweep' ? (DOWN_ONLY ? ['down', 'up'].slice(0, 1) : ['down', 'up']) : [];
  const lanes = resolveLanes({ requested: lanesArg, taskCount: viewports.length });
  const startedAt = Date.now();

  console.log(`comparing ${localUrl}  vs  ${cfg.targetUrl}`);
  console.log(
    `mode: ${MODE}${MODE === 'sweep' ? ` (${directions.join(' + ')}, up to ${MAX_SLICES} slices/direction)` : ''}` +
      `, colour threshold ${THRESHOLD}/255, ${lanes} lane(s), ${COMPOSITE.ext} composites\n`,
  );

  const results = await runLanes(
    viewports,
    async (viewport) => {
      const { record, lines } = await compareViewport(
        browser,
        viewport,
        cfg,
        localUrl,
        outDir,
        directions,
      );
      // One write per viewport keeps concurrent lanes readable.
      console.log(lines.join('\n'));
      return record;
    },
    lanes,
  );

  await browser.close();

  const elapsedS = (Date.now() - startedAt) / 1000;

  const summary = {
    generatedAt: new Date().toISOString(),
    localUrl,
    liveUrl: cfg.targetUrl,
    mode: MODE,
    directions,
    maxSlicesPerDirection: MODE === 'sweep' ? MAX_SLICES : 1,
    sliceSettleMs: SLICE_SETTLE_MS,
    threshold: THRESHOLD,
    // Recorded so a suspiciously noisy run can be explained (and re-run at
    // --lanes=1) months later, rather than argued about.
    lanes,
    liveLoadLanes: LIVE_LOAD_LANES,
    compositeFormat: COMPOSITE.ext,
    elapsedSeconds: Number(elapsedS.toFixed(1)),
    results,
  };
  const reportPath = join(paths.scrape, 'compare-report.json');
  await writeFile(reportPath, JSON.stringify(summary, null, 2));

  const ok = results.filter((r) => !r.error);
  // A viewport whose live page never loaded measures nothing about the replica,
  // so it is kept out of the average and the worst-slice list rather than
  // silently dominating both.
  const measured = ok.filter((r) => !r.liveLoadSuspect);
  const suspect = ok.filter((r) => r.liveLoadSuspect);
  const avg = measured.length
    ? measured.reduce((s, r) => s + (r.meanDiffPct ?? 0), 0) / measured.length
    : 0;

  // The top offenders across the whole run: these are the composites to open
  // first, and the only honest way to review a multi-slice sweep.
  const allSlices = measured.flatMap((r) => r.slices.map((s) => ({ ...s, viewport: r.viewport })));
  const worst = [...allSlices].sort((x, z) => z.diffPct - x.diffPct).slice(0, 6);

  console.log(`\n${'='.repeat(76)}`);
  console.log(`average pixel difference: ${avg.toFixed(2)}%  across ${measured.length} viewport(s), ${allSlices.length} slice(s)`);
  if (suspect.length) {
    console.log(
      `\nLIVE PAGE NEVER LOADED at ${suspect.length} viewport(s) — excluded above, and NOT a replica finding:`,
    );
    for (const r of suspect) {
      console.log(
        `  ${r.viewport}: live laid out at ${r.liveHeight}px vs local ${r.localHeight}px` +
          ` after ${r.liveLoadAttempts} attempt(s). Re-run: --only=${r.viewport} --lanes=1 --live-lanes=1`,
      );
    }
  }
  console.log(`elapsed: ${elapsedS.toFixed(1)}s with ${lanes} lane(s)`);
  if (worst.length) {
    console.log('\nworst slices (open these first):');
    for (const s of worst) {
      console.log(
        `  ${String(s.diffPct.toFixed(2)).padStart(6)}%  ${s.viewport} ${s.direction}` +
          ` y=${s.requestedY}  ${s.composite}`,
      );
    }
  }
  const drifted = measured.filter((r) => Math.abs(r.heightDeltaPct ?? 0) >= 2);
  if (drifted.length) {
    console.log('\npage-height drift >= 2% (a layout smell, and it shrinks compared coverage):');
    for (const r of drifted) {
      console.log(`  ${r.viewport}: local ${r.localHeight}px vs live ${r.liveHeight}px (${r.heightDeltaPct}%)`);
    }
  }
  console.log(`\ncomposites: ${rel(outDir)}`);
  console.log(`report    : ${rel(reportPath)}`);
  console.log(
    '\nReminder: nonzero is normal. Open the worst slices above and check their diff\n' +
      'column — text-shaped noise is copy drift/AB testing (expected); large solid\n' +
      'blocks, shifted edges or a whole slice lit up mean a real layout or asset bug.\n' +
      'A slice that is clean going down but dirty coming up is a scroll-direction bug\n' +
      '(one-shot reveal, sticky nav, parallax), not noise.',
  );
  console.log('='.repeat(76));

  if (results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
