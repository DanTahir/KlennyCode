#!/usr/bin/env node
/**
 * Stage 7 — side-by-side visual comparison against the live page.
 *
 * For every viewport: screenshot the local replica and the live site, then
 * build a single composite image [ local | live | diff ] and report a pixel
 * mismatch percentage.
 *
 * The pixel maths runs inside a headless page on a <canvas> (the screenshots
 * are handed over as base64 data URLs), which means NO image-decoding npm
 * dependency — Chromium is already here and already decodes PNG.
 *
 * Interpreting the numbers
 * ------------------------
 * A replica of a live marketing page will never be 0.00%: many sites A/B-test
 * their own copy, rotate testimonials, or render "N customers" counters, and
 * fonts rasterise a hair differently once self-hosted. What matters is WHERE
 * the difference is. Use the diff column to see whether a delta is text
 * content (expected) or layout/geometry (a real bug).
 *
 * Usage:
 *   node scripts/compare-live.mjs [--url=http://localhost:3300] [--full]
 *                                 [--only=iphone-se,laptop] [--threshold=32]
 */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { launch } from './lib/chromium.mjs';
import { loadConfig, paths, MOBILE_UA } from './lib/config.mjs';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='));
const onlyArg = args.find((a) => a.startsWith('--only='));
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const FULL_PAGE = args.includes('--full');
const THRESHOLD = thresholdArg ? Number(thresholdArg.split('=')[1]) : 32;

async function shoot(browser, url, viewport, scrollSettleMs, fullPage) {
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
  await page.waitForTimeout(3500);

  if (fullPage) {
    // Scroll first so lazy content and entrance animations have resolved,
    // otherwise the full-page shot is half-empty.
    await page.evaluate(async (stepDelay) => {
      const step = window.innerHeight;
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, stepDelay));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 400));
    }, scrollSettleMs);
  }

  const buf = await page.screenshot({ type: 'png', fullPage });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await context.close();
  return { base64: buf.toString('base64'), height };
}

/**
 * Runs in the page: decode both shots, diff them, return a composite PNG.
 * Compared over the overlapping region only, since live/local page heights
 * differ whenever content drifts.
 */
async function diffInPage({ localB64, liveB64, threshold }) {
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
  // Row-level tallies localise a difference to a band of the page.
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
    { img: a, label: 'LOCAL REPLICA', color: '#7dd3fc' },
    { img: b, label: 'LIVE SITE', color: '#a7f3d0' },
    { img: diffCanvas, label: `DIFF (${((differing / (w * h)) * 100).toFixed(2)}%)`, color: '#fca5a5' },
  ];
  panels.forEach((p, i) => {
    const x = gap + i * (w + gap);
    cctx.fillStyle = p.color;
    cctx.fillText(p.label, x, gap + labelH / 2);
    cctx.drawImage(p.img, 0, 0, w, h, x, gap + labelH, w, h);
  });

  // Which 10% bands of the page differ most?
  const bands = 10;
  const bandSize = Math.ceil(h / bands);
  const bandStats = [];
  for (let bi = 0; bi < bands; bi += 1) {
    let sum = 0;
    for (let y = bi * bandSize; y < Math.min(h, (bi + 1) * bandSize); y += 1) sum += rowDiff[y];
    bandStats.push({
      band: `${bi * 10}-${(bi + 1) * 10}%`,
      pct: Number(((sum / (bandSize * w)) * 100).toFixed(2)),
    });
  }

  return {
    width: w,
    height: h,
    localSize: { w: a.width, h: a.height },
    liveSize: { w: b.width, h: b.height },
    diffPct: Number(((differing / (w * h)) * 100).toFixed(3)),
    bands: bandStats,
    composite: comp.toDataURL('image/png'),
  };
}

async function main() {
  const cfg = await loadConfig();
  const localUrl = urlArg ? urlArg.split('=')[1] : `http://localhost:${cfg.port}`;

  let viewports = cfg.viewports;
  if (onlyArg) {
    const wanted = new Set(onlyArg.split('=')[1].split(','));
    viewports = viewports.filter((v) => wanted.has(v.name));
  }

  const outDir = join(paths.shots, 'compare');
  mkdirSync(outDir, { recursive: true });

  const browser = await launch(chromium);
  // A dedicated blank page purely as an image-processing sandbox.
  const workerCtx = await browser.newContext({ viewport: { width: 100, height: 100 } });
  const worker = await workerCtx.newPage();
  await worker.goto('about:blank');

  const results = [];
  console.log(`comparing ${localUrl}  vs  ${cfg.targetUrl}`);
  console.log(`mode: ${FULL_PAGE ? 'full page' : 'above the fold'}, colour threshold ${THRESHOLD}/255\n`);

  for (const viewport of viewports) {
    process.stdout.write(`[${viewport.name}] shooting...`);
    let local;
    let live;
    try {
      local = await shoot(browser, localUrl, viewport, cfg.scrollSettleMs, FULL_PAGE);
      live = await shoot(browser, cfg.targetUrl, viewport, cfg.scrollSettleMs, FULL_PAGE);
    } catch (err) {
      console.log(` FAILED: ${err.message}`);
      results.push({ viewport: viewport.name, error: err.message });
      continue;
    }

    process.stdout.write(' diffing...');
    const diff = await worker.evaluate(diffInPage, {
      localB64: local.base64,
      liveB64: live.base64,
      threshold: THRESHOLD,
    });

    const file = join(outDir, `${viewport.name}.png`);
    await writeFile(file, Buffer.from(diff.composite.split(',')[1], 'base64'));

    const worst = [...diff.bands].sort((x, y) => y.pct - x.pct).slice(0, 3);
    console.log(
      ` diff ${String(diff.diffPct).padStart(6)}%  ` +
        `local ${local.height}px / live ${live.height}px  -> ${file}`,
    );
    console.log(`         worst bands: ${worst.map((b) => `${b.band} (${b.pct}%)`).join(', ')}`);

    results.push({
      viewport: viewport.name,
      diffPct: diff.diffPct,
      comparedRegion: { width: diff.width, height: diff.height },
      localHeight: local.height,
      liveHeight: live.height,
      heightDeltaPct: Number((((local.height - live.height) / live.height) * 100).toFixed(2)),
      bands: diff.bands,
      composite: file,
    });
  }

  await workerCtx.close();
  await browser.close();

  const summary = {
    generatedAt: new Date().toISOString(),
    localUrl,
    liveUrl: cfg.targetUrl,
    mode: FULL_PAGE ? 'fullPage' : 'viewport',
    threshold: THRESHOLD,
    results,
  };
  await writeFile(join(paths.scrape, 'compare-report.json'), JSON.stringify(summary, null, 2));

  const ok = results.filter((r) => !r.error);
  const avg = ok.length ? ok.reduce((s, r) => s + r.diffPct, 0) / ok.length : 0;

  console.log(`\n${'='.repeat(76)}`);
  console.log(`average pixel difference: ${avg.toFixed(2)}%  across ${ok.length} viewport(s)`);
  console.log(`composites: ${outDir}`);
  console.log(`report    : ${join(paths.scrape, 'compare-report.json')}`);
  console.log(
    '\nReminder: nonzero is normal. Check each composite’s diff column — text-shaped\n' +
      'noise is copy drift/AB testing (expected); large solid blocks or shifted edges\n' +
      'mean a real layout or asset bug. Height delta far from 0% is a layout smell.',
  );
  console.log('='.repeat(76));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
