#!/usr/bin/env node
/**
 * Stage 6 — responsive / mobile verification.
 *
 * Drives the cached Playwright Chromium (via playwright-core, no browser
 * download) against the local replica and, optionally, the live site. For each
 * viewport it records the layout metrics that catch failure modes a
 * desktop-only eyeball check misses:
 *
 *   - horizontal overflow (documentElement.scrollWidth > innerWidth)
 *   - every element wider than the viewport (the usual culprit behind it)
 *   - whether the burger button / desktop menu swap at the right breakpoint
 *   - <canvas> having a real, dpr-scaled backing store (dead Rive/WebGL check)
 *   - scroll-triggered animations actually firing
 *   - carousels initialising
 *   - broken images, console errors, failed requests, remote (non-self-hosted)
 *     requests
 *
 * Exit code is non-zero if the LOCAL replica has problems, so this doubles as
 * a CI gate. The live site is a reference, never a gate.
 *
 * Usage:
 *   node scripts/viewport-check.mjs [--url=http://localhost:3300] [--live] [--shots]
 *                                   [--only=iphone-se,laptop] [--json]
 */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { launch } from './lib/chromium.mjs';
import { loadConfig, loadBaseline, paths, MOBILE_UA } from './lib/config.mjs';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='));
const onlyArg = args.find((a) => a.startsWith('--only='));
const CHECK_LIVE = args.includes('--live');
const SHOTS = args.includes('--shots');
const JSON_OUT = args.includes('--json');

/** Collected inside the page; must be entirely self-contained. */
function collectMetrics() {
  const de = document.documentElement;
  const vw = window.innerWidth;

  const tooWide = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Only flag things that actually extend past the right edge; a wide element
    // scrolled off-screen inside a carousel is fine and normal.
    if (r.width > vw + 1 && r.right > vw + 1) {
      const style = getComputedStyle(el);
      if (style.position === 'fixed') continue;
      const cls =
        el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
          : '';
      tooWide.push({
        sel: el.tagName.toLowerCase() + cls,
        width: Math.round(r.width),
        right: Math.round(r.right),
      });
    }
  }

  const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => {
    const r = c.getBoundingClientRect();
    return {
      backing: `${c.width}x${c.height}`,
      css: `${Math.round(r.width)}x${Math.round(r.height)}`,
      painted: c.width > 0 && c.height > 0,
    };
  });

  const burger = document.querySelector(
    '.w-nav-button, [class*="burger"], [class*="hamburger"], button[aria-label*="enu"]',
  );
  const menu = document.querySelector('.w-nav-menu, nav ul, [class*="nav-menu"], [role="menubar"]');

  // Animation-state selectors, kept broad so this works across stacks.
  const animTargets = document.querySelectorAll(
    '.fade-in, [data-fade], [data-aos], [data-animate], [data-scroll]',
  );
  const animDone = document.querySelectorAll(
    '.fade-in.faded-in, .faded-in, .aos-animate, [data-aos].aos-animate, .is-visible, .in-view, .animated, .revealed',
  );

  return {
    innerWidth: vw,
    dpr: window.devicePixelRatio,
    scrollWidth: de.scrollWidth,
    scrollHeight: de.scrollHeight,
    overflowX: de.scrollWidth > vw + 1,
    overflowBy: de.scrollWidth - vw,
    tooWide: tooWide.slice(0, 8),
    tooWideCount: tooWide.length,
    burgerDisplay: burger ? getComputedStyle(burger).display : null,
    menuDisplay: menu ? getComputedStyle(menu).display : null,
    canvases,
    animTargets: animTargets.length,
    animDone: animDone.length,
    carouselsInit: document.querySelectorAll(
      '.swiper-initialized, .splide.is-initialized, .glide--ltr, .flickity-enabled, .embla__container',
    ).length,
    images: document.images.length,
    brokenImages: Array.from(document.images)
      .filter((i) => i.complete && i.naturalWidth === 0)
      .map((i) => i.currentSrc || i.src)
      .slice(0, 6),
    h1: document.querySelector('h1')?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) ?? null,
    fontsLoaded: (() => {
      try {
        return document.fonts.status;
      } catch {
        return 'unknown';
      }
    })(),
    bodyFont: getComputedStyle(document.body).fontFamily.split(',')[0].replace(/["']/g, ''),
  };
}

async function auditPage(browser, label, url, viewport, scrollSettleMs) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    userAgent: viewport.mobile ? MOBILE_UA : undefined,
  });

  const consoleErrors = [];
  const failedRequests = [];
  const remoteRequests = [];
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url().slice(0, 120)}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url().slice(0, 120)}`);
  });
  page.on('request', (req) => {
    // A self-hosted replica should make zero third-party requests.
    if (label !== 'local') return;
    const u = req.url();
    if (!/^https?:/i.test(u)) return;
    if (u.startsWith('http://localhost') || u.startsWith('http://127.0.0.1')) return;
    remoteRequests.push(u.slice(0, 140));
  });

  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  // Let animations parse, carousels initialise and fonts settle.
  await page.waitForTimeout(3500);

  const metrics = await page.evaluate(collectMetrics);

  // Scroll the whole page to trigger IntersectionObserver-driven animations,
  // then re-measure: overflow often only appears once lower sections lay out.
  await page.evaluate(async (stepDelay) => {
    const step = window.innerHeight;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, stepDelay));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  }, scrollSettleMs);

  const afterScroll = await page.evaluate(collectMetrics);

  if (SHOTS) {
    mkdirSync(paths.shots, { recursive: true });
    await page.screenshot({
      path: join(paths.shots, `${label}-${viewport.name}.jpg`),
      type: 'jpeg',
      quality: 72,
      fullPage: false,
    });
  }

  await context.close();
  return { metrics, afterScroll, consoleErrors, failedRequests, remoteRequests: [...new Set(remoteRequests)] };
}

async function main() {
  const cfg = await loadConfig();
  const baseline = await loadBaseline();
  const localUrl = urlArg ? urlArg.split('=')[1] : `http://localhost:${cfg.port}`;

  let viewports = cfg.viewports;
  if (onlyArg) {
    const wanted = new Set(onlyArg.split('=')[1].split(','));
    viewports = viewports.filter((v) => wanted.has(v.name));
  }

  const browser = await launch(chromium);

  const targets = [{ label: 'local', url: localUrl }];
  if (CHECK_LIVE) targets.push({ label: 'live', url: cfg.targetUrl });

  let failures = 0;
  const report = { generatedAt: new Date().toISOString(), localUrl, targets: {} };

  for (const target of targets) {
    console.log(
      `\n${'='.repeat(76)}\n${target.label.toUpperCase()}  ${target.url}\n${'='.repeat(76)}`,
    );
    report.targets[target.label] = {};

    for (const viewport of viewports) {
      let result;
      try {
        result = await auditPage(browser, target.label, target.url, viewport, cfg.scrollSettleMs);
      } catch (err) {
        console.log(`\n[${viewport.name}] FAILED TO LOAD: ${err.message}`);
        if (target.label === 'local') failures += 1;
        continue;
      }

      const { metrics, afterScroll, consoleErrors, failedRequests, remoteRequests } = result;
      const isLocal = target.label === 'local';

      const overflow = metrics.overflowX || afterScroll.overflowX;
      const badImages = afterScroll.brokenImages.length;

      // Overflow the LIVE site also exhibits is fidelity, not a bug — but only
      // if it was verified and written into replica.baseline.json on purpose.
      const quirk = baseline.overflow?.[viewport.name];
      const isBaselined =
        Boolean(quirk) && Math.abs(afterScroll.overflowBy - quirk.by) <= (quirk.tolerance ?? 2);
      const unexpectedOverflow = overflow && !isBaselined;

      const problems = [];
      if (unexpectedOverflow) problems.push('overflow');
      if (badImages) problems.push('broken-images');
      if (consoleErrors.length) problems.push('console-errors');
      if (isLocal && remoteRequests.length) problems.push('remote-requests');

      if (isLocal && problems.length) failures += 1;

      const flag = unexpectedOverflow
        ? 'OVERFLOW'
        : overflow
          ? `ok (baselined +${quirk.by}px, matches live)`
          : problems.length
            ? problems.join(',')
            : 'ok';

      console.log(
        `\n[${viewport.name}] ${viewport.width}x${viewport.height} @${viewport.dpr}x ` +
          `${viewport.mobile ? 'mobile' : 'desktop'} -> ${flag}`,
      );
      console.log(
        `  scrollWidth   ${afterScroll.scrollWidth} vs innerWidth ${afterScroll.innerWidth}` +
          (overflow ? `  (+${afterScroll.overflowBy}px)` : ''),
      );
      console.log(`  page height   ${afterScroll.scrollHeight}px`);
      console.log(`  burger/menu   ${afterScroll.burgerDisplay} / ${afterScroll.menuDisplay}`);
      if (afterScroll.canvases.length) {
        for (const c of afterScroll.canvases.slice(0, 3)) {
          console.log(`  canvas        ${c.backing} backing, ${c.css} css, painted=${c.painted}`);
        }
      }
      console.log(`  animations    ${afterScroll.animDone}/${afterScroll.animTargets} triggered after scroll`);
      console.log(`  carousels     ${afterScroll.carouselsInit} initialised`);
      console.log(`  images        ${afterScroll.images} (${badImages} broken)`);
      console.log(`  body font     ${afterScroll.bodyFont} (fonts: ${afterScroll.fontsLoaded})`);
      console.log(`  h1            ${afterScroll.h1 ?? '(none)'}`);

      if (afterScroll.tooWideCount) {
        console.log(`  elements wider than viewport: ${afterScroll.tooWideCount}`);
        for (const el of afterScroll.tooWide) {
          console.log(`    - ${el.sel}  w=${el.width} right=${el.right}`);
        }
      }
      for (const src of afterScroll.brokenImages) console.log(`    broken: ${src.slice(0, 110)}`);
      if (consoleErrors.length) {
        console.log(`  console errors: ${consoleErrors.length}`);
        for (const e of consoleErrors.slice(0, 4)) console.log(`    ! ${e}`);
      }
      if (failedRequests.length) {
        const unique = [...new Set(failedRequests)];
        console.log(`  failed requests: ${unique.length}`);
        for (const r of unique.slice(0, 4)) console.log(`    ! ${r}`);
      }
      if (isLocal && remoteRequests.length) {
        console.log(`  REMOTE requests: ${remoteRequests.length} (replica should be fully self-hosted)`);
        for (const r of remoteRequests.slice(0, 5)) console.log(`    ! ${r}`);
      }

      report.targets[target.label][viewport.name] = {
        viewport,
        problems,
        baselined: isBaselined,
        metrics: afterScroll,
        consoleErrors: consoleErrors.slice(0, 10),
        failedRequests: [...new Set(failedRequests)].slice(0, 10),
        remoteRequests: remoteRequests.slice(0, 10),
      };
    }
  }

  await browser.close();

  report.failures = failures;
  report.pass = failures === 0;
  if (JSON_OUT) {
    mkdirSync(paths.scrape, { recursive: true });
    await writeFile(join(paths.scrape, 'viewport-report.json'), JSON.stringify(report, null, 2));
    console.log(`\nwrote ${join(paths.scrape, 'viewport-report.json')}`);
  }

  console.log(
    `\n${'='.repeat(76)}\n${failures === 0 ? 'PASS' : 'FAIL'}: ` +
      `${failures} local viewport(s) with problems out of ${viewports.length}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
