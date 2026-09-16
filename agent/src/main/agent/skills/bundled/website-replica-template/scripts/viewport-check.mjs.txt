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
 *   - duplicated VISIBLE headings (a rendered-DOM capture can bake runtime-
 *     generated clones into the markup; the sanitizer strips their opacity:0 so
 *     they ship as permanently visible duplicates of real copy)
 *   - INVISIBLE on-screen content: blocks the live site hides in a stylesheet
 *     class until its own IntersectionObserver reveals them. Captured pre-
 *     scroll, they ship permanently transparent and whole sections read as
 *     blank while being present, correctly sized, and silent.
 *
 * Exit code is non-zero if the LOCAL replica has problems, so this doubles as
 * a CI gate. The live site is a reference, never a gate.
 *
 * Usage:
 *   node scripts/viewport-check.mjs [--url=http://localhost:3300] [--live] [--shots]
 *                                   [--only=iphone-se,laptop] [--json]
 *                                   [--lanes=N] [--thorough]
 */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { launch } from './lib/chromium.mjs';
import { loadConfig, loadBaseline, paths, MOBILE_UA } from './lib/config.mjs';
import { resolveLanes, runLanes, waitForSettle } from './lib/perf.mjs';

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='));
const onlyArg = args.find((a) => a.startsWith('--only='));
const lanesArg = args.find((a) => a.startsWith('--lanes='))?.split('=')[1];
const CHECK_LIVE = args.includes('--live');
const SHOTS = args.includes('--shots');
const JSON_OUT = args.includes('--json');
/** Sample the hidden-content walk at full settle on EVERY offset (the original
 *  behaviour) instead of quick-pass-then-confirm. See findHiddenContent. */
const THOROUGH = args.includes('--thorough');

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

  // --- duplicated visible text -------------------------------------------
  // Sites legitimately create transient clones of a heading (fade/retype
  // effects) and leave them in the DOM at opacity:0, so counting NODES gives
  // false positives. Only a heading rendered visibly MORE THAN ONCE is a bug —
  // that is the signature of a runtime clone baked into the captured markup and
  // then un-hidden by style sanitising.
  const isActuallyVisible = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity) <= 0.05) return false;
      node = node.parentElement;
    }
    return true;
  };

  const headingTally = new Map();
  for (const h of Array.from(document.querySelectorAll('h1, h2, h3'))) {
    const text = (h.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 8) continue; // ignore short/generic labels
    const r = h.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!isActuallyVisible(h)) continue;
    headingTally.set(text, (headingTally.get(text) ?? 0) + 1);
  }
  const dupVisibleText = [...headingTally.entries()]
    .filter(([, n]) => n > 1)
    .map(([text, n]) => ({ text: text.slice(0, 70), count: n }));

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
    dupVisibleText: dupVisibleText.slice(0, 8),
    dupVisibleTextCount: dupVisibleText.length,
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

/**
 * Scroll the whole page to trigger IntersectionObserver-driven animations and
 * find content that is ON SCREEN yet INVISIBLE.
 *
 * Sites routinely hide blocks in a stylesheet class (opacity:0 + blur + scale)
 * and reveal them by adding a class from their own IntersectionObserver.
 * Codegen builds from the PRE-scroll DOM, so that hidden state is what gets
 * captured — and unless an effect re-implements the observer, whole sections
 * ship permanently transparent. They are in the DOM, correctly laid out, and
 * the page height is nearly right, so typecheck/build/tests and every other
 * check here pass while a human sees a heading followed by blank space.
 *
 * The question asked is deliberately "is anything ON SCREEN yet invisible?",
 * sampled DURING the scroll rather than after it. That phrasing is what keeps
 * it free of false positives:
 *   - a legitimately closed dropdown/modal/menu is excluded, because such UI
 *     is hidden structurally (display:none / visibility:hidden / aria-hidden /
 *     a menu or dialog role), not by bare opacity on visible-flow content;
 *   - a BIDIRECTIONAL reveal that re-hides when scrolled away is fine, since
 *     it is only ever judged while it is on screen;
 *   - a WORKING one-shot reveal is fine, because sampling waits out the
 *     transition, including a staggered per-item delay, before looking.
 *
 * TWO PASSES, and why
 * -------------------
 * A staggered entrance transition can run ~1s, so a single sampling pass has to
 * wait that long at EVERY offset — on a 9000px page that is ~12s per viewport,
 * and it was the single largest cost in this script. But the bug being hunted
 * is content that is invisible PERMANENTLY, which a short sample detects just
 * as well as a long one. So:
 *
 *   pass 1 (cheap)   walk the page, sampling twice per offset (~300ms and
 *                    ~600ms), and only remember WHICH offsets look suspicious.
 *   pass 2 (strict)  revisit just those offsets, wait out the full settle plus
 *                    a margin, and report only what is STILL invisible.
 *
 * A clean page — the common case while iterating — never runs pass 2 at all.
 * A real frozen reveal is caught by both. And pass 2 makes the result MORE
 * trustworthy than the old single pass, because every reported offender has now
 * been observed twice, at two different settle times, which is exactly the
 * "working reveal caught mid-fade" false positive the old code had to guess
 * about.
 *
 * The trade is narrow and deliberate: content that is visible at ~600ms and
 * only becomes invisible later is no longer flagged in the default mode.
 * `--thorough` restores full-settle sampling at every offset (and still runs
 * the confirmation pass), for a certification run or a disputed finding.
 */
async function findHiddenContent(page, scrollSettleMs, thorough) {
  // Never sample faster than a staggered entrance transition can finish (~.5s
  // duration plus a per-item delay) or a WORKING reveal looks like a frozen one.
  const confirmMs = Math.max(scrollSettleMs, 1200);
  const quickMs = thorough ? confirmMs : Math.max(Math.min(scrollSettleMs, 300), 300);

  return page.evaluate(
    async ({ quickMs: quick, confirmMs: confirm, thorough: strict }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      // Big enough to be real content rather than a decorative sliver.
      const isContentSized = (r, vw) => r.width >= Math.min(240, vw * 0.25) && r.height >= 80;

      const carriesContent = (el) => {
        if ((el.textContent || '').replace(/\s+/g, ' ').trim().length >= 20) return true;
        return Array.from(el.querySelectorAll('img, video, svg, canvas')).some(
          (m) => m.getBoundingClientRect().width > 8,
        );
      };

      // Deliberately-hidden UI is NOT a bug: a closed nav dropdown, a modal, a
      // tooltip. Those are hidden structurally, so exclude their whole subtree.
      const deliberatelyHidden = (el) => {
        let n = el;
        while (n && n.nodeType === 1) {
          const s = getComputedStyle(n);
          if (s.display === 'none' || s.visibility === 'hidden') return true;
          if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden')) return true;
          const role = n.getAttribute('role');
          if (role && /^(menu|menubar|dialog|alertdialog|tooltip|listbox)$/.test(role)) return true;
          if (n.tagName === 'DIALOG') return true;
          n = n.parentElement;
        }
        return false;
      };

      /** Offenders visible on screen at THIS instant, at this scroll offset. */
      const sample = () => {
        const found = [];
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        for (const el of Array.from(document.querySelectorAll('body *'))) {
          const r = el.getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= vh) continue; // off screen: not judged
          if (!isContentSized(r, vw)) continue;
          const s = getComputedStyle(el);
          if (s.position === 'fixed') continue; // sticky banners/overlays
          if (parseFloat(s.opacity) > 0.05) continue; // visible enough
          if (deliberatelyHidden(el)) continue;
          if (!carriesContent(el)) continue;

          // Report only the OUTERMOST offender; descendants inherit the opacity.
          let anc = el.parentElement;
          let nested = false;
          while (anc && anc.nodeType === 1) {
            if (parseFloat(getComputedStyle(anc).opacity) <= 0.05) {
              nested = true;
              break;
            }
            anc = anc.parentElement;
          }
          if (nested) continue;

          const cls =
            el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
              : '';
          found.push({
            key: el.tagName.toLowerCase() + cls,
            size: `${Math.round(r.width)}x${Math.round(r.height)}`,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          });
        }
        return found;
      };

      const step = window.innerHeight;
      const offsets = [];
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) offsets.push(y);

      // PASS 1 — cheap sweep. Also what triggers every IntersectionObserver on
      // the page, which the post-scroll metrics depend on.
      const suspicious = [];
      for (const y of offsets) {
        window.scrollTo(0, y);
        await sleep(quick);
        let hit = sample().length > 0;
        if (!hit && !strict) {
          // Second look a beat later: catches a reveal that is still pending at
          // the first sample without paying the full settle here.
          await sleep(quick);
          hit = sample().length > 0;
        }
        if (hit) suspicious.push(y);
      }

      // PASS 2 — confirm only the suspicious offsets, after a full settle.
      const offenders = new Map();
      for (const y of suspicious) {
        window.scrollTo(0, y);
        await sleep(confirm + 400);
        for (const o of sample()) {
          const entry = offenders.get(o.key) ?? { sel: o.key, count: 0, size: '', text: '' };
          entry.count += 1;
          entry.size = o.size;
          entry.text = o.text;
          offenders.set(o.key, entry);
        }
      }

      window.scrollTo(0, 0);
      await sleep(300);
      return {
        offenders: Array.from(offenders.values()).sort((a, b) => b.count - a.count),
        offsetsWalked: offsets.length,
        offsetsConfirmed: suspicious.length,
      };
    },
    { quickMs, confirmMs, thorough },
  );
}

async function auditPage(browser, label, url, viewport, cfg) {
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
  // Let animations parse, carousels initialise and fonts settle — adaptively,
  // capped at the configured flat value (see lib/perf.mjs).
  const settledMs = await waitForSettle(page, cfg.settleMs ?? 3500);

  const metrics = await page.evaluate(collectMetrics);

  // The scroll walk doubles as the INVISIBLE CONTENT gate, and re-measuring
  // after it matters because overflow often only appears once lower sections
  // lay out.
  const hidden = await findHiddenContent(page, cfg.scrollSettleMs, THOROUGH);

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
  return {
    metrics,
    afterScroll,
    hiddenContent: hidden.offenders,
    hiddenScan: { walked: hidden.offsetsWalked, confirmed: hidden.offsetsConfirmed },
    settledMs,
    consoleErrors,
    failedRequests,
    remoteRequests: [...new Set(remoteRequests)],
  };
}

/**
 * Audit one (target, viewport) pair and return its report entry plus the
 * console block to print. Lanes run these concurrently, so output is buffered
 * and emitted in one write per pair rather than interleaved line by line.
 */
async function auditOne(browser, target, viewport, cfg, baseline) {
  const lines = [];
  const say = (s) => lines.push(s);
  const isLocal = target.label === 'local';

  let result;
  try {
    result = await auditPage(browser, target.label, target.url, viewport, cfg);
  } catch (err) {
    say(`[${target.label} ${viewport.name}] FAILED TO LOAD: ${err.message}`);
    return { lines, failed: isLocal, entry: null, viewport, target };
  }

  const {
    metrics,
    afterScroll,
    hiddenContent,
    hiddenScan,
    settledMs,
    consoleErrors,
    failedRequests,
    remoteRequests,
  } = result;

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
  // Duplicated visible copy => runtime-generated nodes were baked into the
  // capture. Compared against live so genuine site behaviour never fails.
  const liveDupes = baseline.duplicateVisibleText?.[viewport.name] ?? 0;
  if (afterScroll.dupVisibleTextCount > liveDupes) problems.push('duplicate-visible-text');
  // Content on screen yet invisible => a reveal class the live site applies
  // at runtime is not being re-applied here, so a section ships blank.
  // Baseline it ONLY after confirming the live page hides the same block.
  //
  // Baselining matches a CLASS SIGNATURE, not an element's text or a count.
  // Inside a horizontally scrollable card rail, WHICH member sits off-window
  // (and so never gets revealed -- on the live site too) depends on scroll
  // position and timing, so the same faithful behaviour resurfaces under
  // different copy from run to run and a text- or count-keyed baseline never
  // matches twice. The bug this gate exists for is different in kind: a
  // reveal class that NO effect re-applies is frozen at every viewport,
  // under every signature, and live exhibits none of them. Signature
  // matching stays precise about that while absorbing rail noise. A bare
  // number is still honoured for older baselines.
  const baselineHidden = baseline.hiddenContent?.[viewport.name] ?? 0;
  const baselinedSigs = Array.isArray(baselineHidden) ? new Set(baselineHidden) : null;
  const unexplainedHidden = baselinedSigs
    ? hiddenContent.filter((h) => !baselinedSigs.has(h.sel))
    : hiddenContent.length > baselineHidden
      ? hiddenContent
      : [];
  if (isLocal && unexplainedHidden.length) problems.push('hidden-content');

  const flag = unexpectedOverflow
    ? 'OVERFLOW'
    : overflow
      ? `ok (baselined +${quirk.by}px, matches live)`
      : problems.length
        ? problems.join(',')
        : 'ok';

  say(
    `[${target.label} ${viewport.name}] ${viewport.width}x${viewport.height} @${viewport.dpr}x ` +
      `${viewport.mobile ? 'mobile' : 'desktop'} -> ${flag}`,
  );
  say(
    `  scrollWidth   ${afterScroll.scrollWidth} vs innerWidth ${afterScroll.innerWidth}` +
      (overflow ? `  (+${afterScroll.overflowBy}px)` : ''),
  );
  say(`  page height   ${afterScroll.scrollHeight}px`);
  say(`  burger/menu   ${afterScroll.burgerDisplay} / ${afterScroll.menuDisplay}`);
  if (afterScroll.canvases.length) {
    for (const c of afterScroll.canvases.slice(0, 3)) {
      say(`  canvas        ${c.backing} backing, ${c.css} css, painted=${c.painted}`);
    }
  }
  say(`  animations    ${afterScroll.animDone}/${afterScroll.animTargets} triggered after scroll`);
  say(`  carousels     ${afterScroll.carouselsInit} initialised`);
  say(`  images        ${afterScroll.images} (${badImages} broken)`);
  say(`  body font     ${afterScroll.bodyFont} (fonts: ${afterScroll.fontsLoaded})`);
  say(`  h1            ${afterScroll.h1 ?? '(none)'}`);
  say(
    `  settle/scan   settled ${settledMs}ms; walked ${hiddenScan.walked} offset(s),` +
      ` confirmed ${hiddenScan.confirmed}`,
  );

  if (afterScroll.dupVisibleTextCount) {
    say(
      `  DUPLICATE visible headings: ${afterScroll.dupVisibleTextCount}` +
        (liveDupes ? ` (baselined: ${liveDupes})` : ''),
    );
    for (const d of afterScroll.dupVisibleText) {
      say(`    x${d.count}  ${d.text}`);
    }
  }

  if (hiddenContent.length) {
    const matched = hiddenContent.length - unexplainedHidden.length;
    say(
      `  INVISIBLE on-screen content: ${hiddenContent.length} block(s)` +
        (baselinedSigs
          ? ` (${matched} matched a live-verified signature, ${unexplainedHidden.length} unexplained)`
          : baselineHidden
            ? ` (baselined: ${baselineHidden})`
            : ''),
    );
    for (const h of hiddenContent.slice(0, 5)) {
      const tag = baselinedSigs && !unexplainedHidden.includes(h) ? '  [baselined]' : '';
      say(`    opacity~0  ${h.size.padEnd(11)} ${h.sel}${tag}`);
      if (h.text) say(`               "${h.text}"`);
    }
    say('    ^ these were on screen but transparent. Almost always a scroll-reveal');
    say('      class the live site adds at runtime that no effect re-applies. Find it');
    say('      with the class-token diff printed by `npm run analyze`.');
  }

  if (afterScroll.tooWideCount) {
    say(`  elements wider than viewport: ${afterScroll.tooWideCount}`);
    for (const el of afterScroll.tooWide) {
      say(`    - ${el.sel}  w=${el.width} right=${el.right}`);
    }
  }
  for (const src of afterScroll.brokenImages) say(`    broken: ${src.slice(0, 110)}`);
  if (consoleErrors.length) {
    say(`  console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors.slice(0, 4)) say(`    ! ${e}`);
  }
  if (failedRequests.length) {
    const unique = [...new Set(failedRequests)];
    say(`  failed requests: ${unique.length}`);
    for (const r of unique.slice(0, 4)) say(`    ! ${r}`);
  }
  if (isLocal && remoteRequests.length) {
    say(`  REMOTE requests: ${remoteRequests.length} (replica should be fully self-hosted)`);
    for (const r of remoteRequests.slice(0, 5)) say(`    ! ${r}`);
  }

  return {
    lines,
    failed: isLocal && problems.length > 0,
    viewport,
    target,
    entry: {
      viewport,
      problems,
      baselined: isBaselined,
      metrics: afterScroll,
      hiddenContent,
      hiddenScan,
      settledMs,
      consoleErrors: consoleErrors.slice(0, 10),
      failedRequests: [...new Set(failedRequests)].slice(0, 10),
      remoteRequests: remoteRequests.slice(0, 10),
    },
  };
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

  // Every (target, viewport) pair is independent, so the local and live passes
  // no longer run one after the other either.
  const tasks = targets.flatMap((target) => viewports.map((viewport) => ({ target, viewport })));
  const lanes = resolveLanes({ requested: lanesArg, taskCount: tasks.length });
  const startedAt = Date.now();

  console.log(
    `auditing ${tasks.length} (target, viewport) pair(s) across ${lanes} lane(s)` +
      `${THOROUGH ? ', thorough hidden-content sampling' : ''}`,
  );
  for (const t of targets) console.log(`  ${t.label.padEnd(5)} ${t.url}`);

  const outcomes = await runLanes(
    tasks,
    async ({ target, viewport }) => {
      const outcome = await auditOne(browser, target, viewport, cfg, baseline);
      // One write per pair keeps concurrent lanes readable.
      console.log(`\n${outcome.lines.join('\n')}`);
      return outcome;
    },
    lanes,
  );

  await browser.close();

  const report = {
    generatedAt: new Date().toISOString(),
    localUrl,
    lanes,
    thorough: THOROUGH,
    targets: {},
  };
  for (const t of targets) report.targets[t.label] = {};

  let failures = 0;
  for (const outcome of outcomes) {
    if (outcome.failed) failures += 1;
    if (outcome.entry) report.targets[outcome.target.label][outcome.viewport.name] = outcome.entry;
  }

  const elapsedS = (Date.now() - startedAt) / 1000;
  report.failures = failures;
  report.pass = failures === 0;
  report.elapsedSeconds = Number(elapsedS.toFixed(1));

  if (JSON_OUT) {
    mkdirSync(paths.scrape, { recursive: true });
    await writeFile(join(paths.scrape, 'viewport-report.json'), JSON.stringify(report, null, 2));
    console.log(`\nwrote ${join(paths.scrape, 'viewport-report.json')}`);
  }

  console.log(
    `\n${'='.repeat(76)}\n${failures === 0 ? 'PASS' : 'FAIL'}: ` +
      `${failures} local viewport(s) with problems out of ${viewports.length}` +
      `  (${elapsedS.toFixed(1)}s, ${lanes} lane(s))\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
