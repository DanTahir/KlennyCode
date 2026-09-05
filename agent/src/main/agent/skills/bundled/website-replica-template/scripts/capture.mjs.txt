#!/usr/bin/env node
/**
 * Stage 1 — browser capture.
 *
 * Loads the target URL in a real (cached) Chromium and records everything the
 * later stages need:
 *
 *   scrape/raw/index.html          rendered DOM, PRE-scroll  <- codegen source
 *   scrape/raw/index.scrolled.html rendered DOM, POST-scroll <- reference
 *   scrape/raw/index.static.html   the raw server response    <- reference
 *   scrape/raw/network.json        every request the page made (the asset list)
 *   scrape/raw/head.json           <head> in document order (cascade order!)
 *   scrape/raw/features.json       which JS libraries/effects were detected
 *
 * Why a real browser: an increasing share of sites render their body client
 * side, so the static HTML is a near-empty shell. Rendering also surfaces
 * runtime-injected stylesheets (webfont loaders) and runtime-fetched binaries
 * (.riv, .wasm) that never appear in the markup.
 *
 * Why PRE-scroll is the codegen source: scroll-triggered animations mutate the
 * DOM (adding `faded-in`, inline `opacity`, carousel transforms). Capturing
 * after a full scroll would bake every entrance animation into its finished
 * state. We still capture the post-scroll DOM for diffing, and the network log
 * from the scrolled pass so lazy-loaded assets are not missed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launch } from './lib/chromium.mjs';
import { loadConfig, paths, DESKTOP_UA } from './lib/config.mjs';
import { makeHostBlocker } from './lib/assets.mjs';

/** Runs in the page. Reads <head> in document order so codegen can rebuild the cascade. */
function readHead() {
  const entries = [];
  for (const node of Array.from(document.head.children)) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'link') {
      entries.push({
        kind: 'link',
        rel: node.getAttribute('rel'),
        href: node.href || node.getAttribute('href'),
        media: node.getAttribute('media'),
        type: node.getAttribute('type'),
        sizes: node.getAttribute('sizes'),
      });
    } else if (tag === 'style') {
      entries.push({ kind: 'style', css: node.textContent ?? '' });
    } else if (tag === 'title') {
      entries.push({ kind: 'title', text: node.textContent ?? '' });
    } else if (tag === 'meta') {
      entries.push({
        kind: 'meta',
        name: node.getAttribute('name'),
        property: node.getAttribute('property'),
        httpEquiv: node.getAttribute('http-equiv'),
        content: node.getAttribute('content'),
        charset: node.getAttribute('charset'),
      });
    }
  }

  // <style> blocks can also appear in <body>; they cascade after head styles.
  const bodyStyles = Array.from(document.body.querySelectorAll('style')).map(
    (s) => s.textContent ?? '',
  );

  return {
    lang: document.documentElement.getAttribute('lang'),
    htmlClass: document.documentElement.className,
    bodyClass: document.body.className,
    title: document.title,
    entries,
    bodyStyles,
  };
}

/** Runs in the page. Fingerprints the effects/libraries actually present. */
function detectFeatures() {
  const w = window;
  const has = (sel) => document.querySelectorAll(sel).length;

  const fontFamilies = new Set();
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 4000)) {
    const ff = getComputedStyle(el).fontFamily;
    if (ff) fontFamilies.add(ff.split(',')[0].replace(/["']/g, '').trim());
  }

  const loadedFonts = [];
  try {
    document.fonts.forEach((f) => loadedFonts.push({ family: f.family, weight: f.weight, style: f.style }));
  } catch { /* FontFaceSet not iterable in some builds */ }

  return {
    globals: {
      jQuery: typeof w.jQuery !== 'undefined',
      Webflow: typeof w.Webflow !== 'undefined',
      Swiper: typeof w.Swiper !== 'undefined',
      gsap: typeof w.gsap !== 'undefined',
      ScrollTrigger: Boolean(w.ScrollTrigger || (w.gsap && w.gsap.ScrollTrigger)),
      rive: typeof w.rive !== 'undefined' || typeof w.Rive !== 'undefined',
      lottie: typeof w.lottie !== 'undefined' || typeof w.bodymovin !== 'undefined',
      three: typeof w.THREE !== 'undefined',
      AOS: typeof w.AOS !== 'undefined',
      Lenis: typeof w.Lenis !== 'undefined' || typeof w.lenis !== 'undefined',
      LocomotiveScroll: typeof w.LocomotiveScroll !== 'undefined',
      barba: typeof w.barba !== 'undefined',
      Splitting: typeof w.Splitting !== 'undefined',
      SplitType: typeof w.SplitType !== 'undefined',
      Fancybox: typeof w.Fancybox !== 'undefined' || typeof w.$?.fancybox !== 'undefined',
      Alpine: typeof w.Alpine !== 'undefined',
      React: Boolean(document.querySelector('#__next, [data-reactroot], #root')),
    },
    counts: {
      canvas: has('canvas'),
      video: has('video'),
      svg: has('svg'),
      images: document.images.length,
      links: document.links.length,
      forms: document.forms.length,
      iframes: has('iframe'),
      riveTargets: has('[data-rive-url], canvas[data-rive], canvas[data-animation-type="rive"]'),
      swiperRoots: has('.swiper, [class*="swiper-container"]'),
      swiperSlides: has('.swiper-slide'),
      splideRoots: has('.splide'),
      glideRoots: has('.glide'),
      fadeIn: has('.fade-in, [data-fade], [data-aos], [data-animate], [data-scroll]'),
      marquee: has('marquee, [class*="marquee"], [class*="ticker"]'),
      tabs: has('[role="tablist"], .w-tabs, [data-tabs]'),
      accordions: has('details, [data-accordion], .accordion'),
      dropdowns: has('.w-dropdown, [data-dropdown], nav [aria-haspopup]'),
      navBurger: has('.w-nav-button, [class*="burger"], [class*="hamburger"], [aria-label*="enu"]'),
      lazyImages: has('img[loading="lazy"], img[data-src], [data-bg]'),
      typewriter: has('[data-retype-text], [class*="typewriter"], [class*="typed"]'),
      counters: has('[data-counter], [class*="counter"], [data-count-to]'),
      parallax: has('[data-parallax], [class*="parallax"]'),
    },
    dataAttributes: (() => {
      const census = {};
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        for (const attr of Array.from(el.attributes)) {
          if (!attr.name.startsWith('data-')) continue;
          census[attr.name] = (census[attr.name] ?? 0) + 1;
        }
      }
      return Object.fromEntries(
        Object.entries(census).sort((a, b) => b[1] - a[1]).slice(0, 60),
      );
    })(),
    fontFamilies: [...fontFamilies].slice(0, 40),
    loadedFonts: loadedFonts.slice(0, 60),
    documentHeight: document.documentElement.scrollHeight,
    elementCount: document.querySelectorAll('body *').length,
  };
}

async function main() {
  const cfg = await loadConfig();
  const isBlocked = makeHostBlocker(cfg.blockHosts);

  await mkdir(paths.raw, { recursive: true });

  const browser = await launch(chromium);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    userAgent: DESKTOP_UA,
    // A real locale/timezone avoids geo-redirect interstitials on some sites.
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });

  const requests = [];
  const blocked = [];

  // Abort analytics/consent/chat before they can inject DOM or cookie banners.
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isBlocked(url)) {
      blocked.push(url);
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('response', (res) => {
    const req = res.request();
    requests.push({
      url: res.url(),
      status: res.status(),
      resourceType: req.resourceType(),
      contentType: res.headers()['content-type'] ?? '',
      method: req.method(),
    });
  });

  console.log(`capture: ${cfg.targetUrl}`);
  await page.goto(cfg.targetUrl, { waitUntil: 'load', timeout: 90_000 });

  // Give webfonts, hero animations and deferred bundles time to arrive.
  await page.waitForTimeout(cfg.settleMs);
  try {
    await page.evaluate(() => document.fonts?.ready);
  } catch { /* not supported */ }

  const head = await page.evaluate(readHead);
  const features = await page.evaluate(detectFeatures);
  const preScrollHtml = await page.content();

  // Now scroll the whole page so lazy images / in-view assets get requested.
  await page.evaluate(async (stepDelay) => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, stepDelay));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 400));
  }, cfg.scrollSettleMs);
  await page.waitForTimeout(1200);

  const scrolledHtml = await page.content();

  // The unrendered server response, for reference/diffing.
  let staticHtml = '';
  try {
    const res = await fetch(cfg.targetUrl, { headers: { 'User-Agent': DESKTOP_UA } });
    staticHtml = await res.text();
  } catch (err) {
    staticHtml = `<!-- static fetch failed: ${err.message} -->`;
  }

  await writeFile(paths.rawHtml, preScrollHtml);
  await writeFile(path.join(paths.raw, 'index.scrolled.html'), scrolledHtml);
  await writeFile(paths.rawHtmlStatic, staticHtml);
  await writeFile(paths.head, JSON.stringify(head, null, 2));
  await writeFile(paths.features, JSON.stringify(features, null, 2));
  await writeFile(
    paths.network,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        targetUrl: cfg.targetUrl,
        requests,
        blocked: [...new Set(blocked)],
        consoleErrors,
      },
      null,
      2,
    ),
  );

  await context.close();
  await browser.close();

  const stylesheets = head.entries.filter((e) => e.kind === 'link' && /stylesheet/i.test(e.rel ?? ''));
  const activeLibs = Object.entries(features.globals).filter(([, v]) => v).map(([k]) => k);

  console.log('\n--- capture summary ---');
  console.log(`rendered DOM      : ${preScrollHtml.length} bytes (pre-scroll, codegen source)`);
  console.log(`scrolled DOM      : ${scrolledHtml.length} bytes`);
  console.log(`static HTML       : ${staticHtml.length} bytes`);
  console.log(`elements          : ${features.elementCount}`);
  console.log(`network requests  : ${requests.length} (${blocked.length} blocked)`);
  console.log(`head stylesheets  : ${stylesheets.length}`);
  console.log(`inline <style>    : ${head.entries.filter((e) => e.kind === 'style').length} head + ${head.bodyStyles.length} body`);
  console.log(`libraries detected: ${activeLibs.join(', ') || 'none'}`);
  console.log(`fonts in use      : ${features.fontFamilies.slice(0, 8).join(', ')}`);
  if (consoleErrors.length) console.log(`console errors    : ${consoleErrors.length}`);

  const ratio = staticHtml.length ? preScrollHtml.length / staticHtml.length : 0;
  if (ratio > 3) {
    console.log(
      `\nNOTE: rendered DOM is ${ratio.toFixed(1)}x the static HTML — this page is\n` +
        '      client-rendered. Capturing the rendered DOM was the right call.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
