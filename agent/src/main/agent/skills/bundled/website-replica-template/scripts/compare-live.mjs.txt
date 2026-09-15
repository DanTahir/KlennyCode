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
 */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { chromium } from 'playwright-core';
import { launch } from './lib/chromium.mjs';
import { loadConfig, paths, MOBILE_UA } from './lib/config.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const urlArg = flag('url');
const onlyArg = flag('only');
const thresholdArg = flag('threshold');
const slicesArg = flag('slices');
const settleArg = flag('settle');

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
  await page.waitForTimeout(cfg.settleMs ?? 3500);
  return { context, page };
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
 * Runs in the page: decode both shots, diff them, return a composite PNG.
 * Compared over the overlapping region only, since live/local dimensions differ
 * whenever content drifts.
 */
async function diffInPage({ localB64, liveB64, threshold, bands, caption }) {
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
    composite: comp.toDataURL('image/png'),
  };
}

const rel = (p) => relative(paths.root, p).split('\\').join('/');

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
  // A dedicated blank page purely as an image-processing sandbox.
  const workerCtx = await browser.newContext({ viewport: { width: 100, height: 100 } });
  const worker = await workerCtx.newPage();
  await worker.goto('about:blank');

  const directions = MODE === 'sweep' ? (DOWN_ONLY ? ['down'] : ['down', 'up']) : [];
  const results = [];

  console.log(`comparing ${localUrl}  vs  ${cfg.targetUrl}`);
  console.log(
    `mode: ${MODE}${MODE === 'sweep' ? ` (${directions.join(' + ')}, up to ${MAX_SLICES} slices/direction)` : ''}` +
      `, colour threshold ${THRESHOLD}/255\n`,
  );

  for (const viewport of viewports) {
    const vpDir = join(outDir, viewport.name);
    mkdirSync(vpDir, { recursive: true });

    let local;
    let live;
    try {
      process.stdout.write(`[${viewport.name}] loading both pages...`);
      local = await openSession(browser, localUrl, viewport, cfg);
      live = await openSession(browser, cfg.targetUrl, viewport, cfg);
      const localHeight = await warmUp(local.page, cfg.scrollSettleMs);
      const liveHeight = await warmUp(live.page, cfg.scrollSettleMs);
      console.log(` local ${localHeight}px / live ${liveHeight}px`);

      const record = {
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
        localHeight,
        liveHeight,
        heightDeltaPct: Number((((localHeight - liveHeight) / liveHeight) * 100).toFixed(2)),
        slices: [],
      };

      if (MODE !== 'sweep') {
        const fullPage = MODE === 'full';
        const localB64 = fullPage ? await shootFullPage(local.page) : await shootViewport(local.page);
        const liveB64 = fullPage ? await shootFullPage(live.page) : await shootViewport(live.page);
        const diff = await worker.evaluate(diffInPage, {
          localB64,
          liveB64,
          threshold: THRESHOLD,
          bands: 10,
          caption: fullPage ? 'full page' : 'above the fold',
        });
        const file = join(vpDir, `${MODE}.png`);
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
        console.log(`         diff ${String(diff.diffPct).padStart(6)}%  -> ${rel(file)}`);
        console.log(`         worst bands: ${worst.map((bd) => `${bd.band} (${bd.pct}%)`).join(', ')}`);
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

        for (const direction of directions) {
          const sequence = direction === 'down' ? offsets : [...offsets].reverse();
          for (let i = 0; i < sequence.length; i += 1) {
            const y = sequence[i];
            const localY = await scrollToOffset(local.page, y, SLICE_SETTLE_MS);
            const liveY = await scrollToOffset(live.page, y, SLICE_SETTLE_MS);
            const localB64 = await shootViewport(local.page);
            const liveB64 = await shootViewport(live.page);

            const caption = `${direction} y=${y}`;
            const diff = await worker.evaluate(diffInPage, {
              localB64,
              liveB64,
              threshold: THRESHOLD,
              bands: 4,
              caption,
            });

            const file = join(vpDir, `${direction}-${String(i).padStart(2, '0')}-y${y}.png`);
            await writeFile(file, Buffer.from(diff.composite.split(',')[1], 'base64'));

            const misalignedBy = Math.abs(localY - liveY);
            record.slices.push({
              direction,
              index: i,
              requestedY: y,
              localY,
              liveY,
              misalignedBy,
              diffPct: diff.diffPct,
              comparedRegion: { width: diff.width, height: diff.height },
              bands: diff.bands,
              composite: rel(file),
            });

            const worst = [...diff.bands].sort((x, z) => z.pct - x.pct)[0];
            console.log(
              `         ${direction.padEnd(4)} ${String(i + 1).padStart(2)}/${sequence.length}` +
                `  y=${String(y).padStart(6)}  diff ${String(diff.diffPct.toFixed(2)).padStart(6)}%` +
                `  worst band ${worst.band} (${worst.pct}%)` +
                (misalignedBy > 4 ? `  [misaligned ${misalignedBy}px: local ${localY} / live ${liveY}]` : ''),
            );
          }
        }
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
          console.log(
            `         direction-sensitive offsets: ` +
              suspicious
                .slice(0, 3)
                .map((x) => `y=${x.y} (down ${x.down}% vs up ${x.up}%)`)
                .join(', '),
          );
        }
      }

      console.log(
        `         mean ${record.meanDiffPct}% over ${measured.length} slice(s)` +
          (record.coveragePct != null ? `, covering ${record.coveragePct}% of the page` : '') +
          `, height delta ${record.heightDeltaPct}%`,
      );

      results.push(record);
    } catch (err) {
      console.log(` FAILED: ${err.message}`);
      results.push({ viewport: viewport.name, error: err.message });
    } finally {
      await local?.context.close().catch(() => {});
      await live?.context.close().catch(() => {});
    }
  }

  await workerCtx.close();
  await browser.close();

  const summary = {
    generatedAt: new Date().toISOString(),
    localUrl,
    liveUrl: cfg.targetUrl,
    mode: MODE,
    directions,
    maxSlicesPerDirection: MODE === 'sweep' ? MAX_SLICES : 1,
    sliceSettleMs: SLICE_SETTLE_MS,
    threshold: THRESHOLD,
    results,
  };
  const reportPath = join(paths.scrape, 'compare-report.json');
  await writeFile(reportPath, JSON.stringify(summary, null, 2));

  const ok = results.filter((r) => !r.error);
  const avg = ok.length ? ok.reduce((s, r) => s + (r.meanDiffPct ?? 0), 0) / ok.length : 0;

  // The top offenders across the whole run: these are the composites to open
  // first, and the only honest way to review a multi-slice sweep.
  const allSlices = ok.flatMap((r) => r.slices.map((s) => ({ ...s, viewport: r.viewport })));
  const worst = [...allSlices].sort((x, z) => z.diffPct - x.diffPct).slice(0, 6);

  console.log(`\n${'='.repeat(76)}`);
  console.log(`average pixel difference: ${avg.toFixed(2)}%  across ${ok.length} viewport(s), ${allSlices.length} slice(s)`);
  if (worst.length) {
    console.log('\nworst slices (open these first):');
    for (const s of worst) {
      console.log(
        `  ${String(s.diffPct.toFixed(2)).padStart(6)}%  ${s.viewport} ${s.direction}` +
          ` y=${s.requestedY}  ${s.composite}`,
      );
    }
  }
  const drifted = ok.filter((r) => Math.abs(r.heightDeltaPct ?? 0) >= 2);
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
