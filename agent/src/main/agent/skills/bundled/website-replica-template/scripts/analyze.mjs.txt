#!/usr/bin/env node
/**
 * Stage 3 — structural reconnaissance (read-only, emits no app code).
 *
 * Codegen does its own parse; this exists so a human (or agent) can see what
 * the page is actually made of before hand-porting behaviour: which inline
 * scripts exist, what data-attributes drive them, and where the section
 * boundaries are.
 *
 *   scrape/analysis/head-order.txt   cascade order of stylesheets + <style>
 *   scrape/analysis/style-NN.css     each inline <style>, verbatim
 *   scrape/analysis/script-NN.js     each inline <script>, verbatim
 *   scrape/analysis/body-tree.txt    DOM outline to --depth (default 4)
 *   scrape/analysis/sections.txt     top-level blocks + element counts
 *   scrape/analysis/attrs.txt        census of data-, aria-, id and role attrs
 *   scrape/analysis/scroll-reveals.json  classes the page's JS adds on scroll
 *   scrape/analysis/summary.json     machine-readable roll-up
 *
 * Usage: node scripts/analyze.mjs [--depth=6]
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';
import { paths } from './lib/config.mjs';

const DEPTH = Number(
  process.argv.find((a) => a.startsWith('--depth='))?.split('=')[1] ?? 4,
);

const isEl = (n) => Boolean(n.tagName);
const isText = (n) => n.nodeName === '#text';
const kids = (n) => (n.childNodes ?? []).filter(isEl);
const attrOf = (n, name) => n.attrs?.find((a) => a.name === name)?.value;
const classesOf = (n) => (attrOf(n, 'class') ?? '').trim().split(/\s+/).filter(Boolean);
const textOf = (n) => (n.childNodes ?? []).filter(isText).map((t) => t.value).join('');

function findAll(node, pred, acc = []) {
  if (isEl(node) && pred(node)) acc.push(node);
  for (const c of node.childNodes ?? []) findAll(c, pred, acc);
  return acc;
}

const countEls = (n) => findAll(n, () => true).length;

function describe(n) {
  const id = attrOf(n, 'id');
  const cls = classesOf(n);
  return `${n.tagName}${id ? `#${id}` : ''}${cls.length ? '.' + cls.slice(0, 4).join('.') : ''}`;
}

function outline(node, depth, maxDepth, lines, indent = '') {
  for (const child of kids(node)) {
    lines.push(`${indent}${describe(child)}  (${countEls(child)} els)`);
    if (depth < maxDepth) outline(child, depth + 1, maxDepth, lines, indent + '  ');
  }
}

// ---------------------------------------------------------------------------
// Scroll-reveal detection
//
// codegen builds from the PRE-scroll DOM. Any class the page's own JavaScript
// adds *while scrolling* is therefore runtime state the replica must re-apply
// itself. Most such classes are cosmetic, but some gate VISIBILITY: their base
// rule sets `opacity:0` (often with a blur/scale) and the added class is what
// turns the content on. Fail to re-apply one of those and the affected blocks
// ship present, correctly sized, laid out, silent — and completely invisible.
// Whole sections then read as a heading followed by blank space while tsc, the
// unit tests, next build and the asset checks all stay green.
//
// Two things make this class of bug hard to catch any other way:
//   - the hiding lives in a STYLESHEET, so scanning generated markup for inline
//     `opacity: 0` residue cannot see it;
//   - a generic effect census (`.fade-in, [data-aos], [data-animate]` …) can
//     report ZERO targets on a page that is full of reveals, because the site
//     uses its own naming (BEM `--is-visible`, CSS-module hashes, etc).
//
// Comparing the two captures the browser already produced is exact, free, and
// site-agnostic, so it runs on every pipeline.
// ---------------------------------------------------------------------------

/** Every distinct class token used anywhere in an HTML string. */
function classTokens(html) {
  const tokens = new Set();
  for (const m of html.matchAll(/\sclass=(?:"([^"]*)"|'([^']*)')/g)) {
    for (const t of (m[1] ?? m[2] ?? '').trim().split(/\s+/)) {
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

/** Declarations that make content invisible (or displaced) when left applied. */
const HIDES_CONTENT =
  /(?:^|[;{])\s*(?:opacity\s*:\s*0(?:\.0+)?\s*(?:[;}]|$)|visibility\s*:\s*hidden|filter\s*:\s*[^;}]*blur|transform\s*:\s*(?!none)[^;}]*(?:scale|translate))/i;

/** Crude but dependency-free rule splitter: [selector, body] pairs. */
function cssRules(css) {
  const rules = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push([m[1].trim(), m[2].trim()]);
  }
  return rules;
}

/** All CSS this run can see: scraped stylesheets on disk plus inline blocks. */
async function collectCss(inlineStyles) {
  const chunks = [...inlineStyles];

  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // not scraped yet, or no assets dir — detection still works
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.css')) {
        try {
          chunks.push(await readFile(full, 'utf8'));
        } catch {
          /* unreadable sheet is not fatal to recon */
        }
      }
    }
  };

  await walk(paths.publicAssets);
  return chunks.join('\n');
}

/**
 * Candidate "hidden base" selectors for a reveal token, by two independent
 * routes, because real sites use both shapes:
 *   1. BEM-ish state suffix — `block--is-visible` reveals `block`.
 *   2. Compound selector — `._card_x._entry_x._show_x` names its own base, so
 *      removing the token from the selector leaves the hidden base behind.
 */
function baseSelectorCandidates(token, rulesMentioningToken) {
  const candidates = new Set();

  const suffixes = [
    /--?is-(?:visible|shown|active|in-view|entered|loaded)$/i,
    /--?(?:visible|shown|show|active|open|in-view|inview|entered|revealed|loaded|animate|animated)$/i,
    /(?:Visible|Shown|Show|Active|Open|InView|Entered|Revealed|Loaded|Animate|Animated)(_[A-Za-z0-9]+_\d+)?$/,
  ];
  for (const re of suffixes) {
    const m = token.match(re);
    if (!m) continue;
    // Sliced by match index rather than String.replace with a replacer: only
    // SOME of these patterns have a capture group, and when one does not, a
    // replacer's second argument is the match OFFSET (a number) — which would
    // silently append digits to the base name and match no rule at all.
    const tail = typeof m[1] === 'string' ? m[1] : '';
    const stripped = token.slice(0, m.index) + tail;
    if (stripped && stripped !== token && stripped.length > 2) candidates.add(`.${stripped}`);
  }

  for (const [selector] of rulesMentioningToken) {
    for (const part of selector.split(',')) {
      if (!part.includes(`.${token}`)) continue;
      const residual = part.replaceAll(`.${token}`, '').trim();
      if (residual && /^[.#\[:a-zA-Z]/.test(residual)) candidates.add(residual);
    }
  }

  return [...candidates];
}

async function detectScrollReveals(inlineStyles) {
  const preHtml = await readFile(paths.rawHtml, 'utf8');
  let scrolledHtml = null;
  try {
    scrolledHtml = await readFile(path.join(paths.raw, 'index.scrolled.html'), 'utf8');
  } catch {
    return { available: false, reason: 'scrape/raw/index.scrolled.html not found', added: [], removed: [] };
  }

  const pre = classTokens(preHtml);
  const post = classTokens(scrolledHtml);
  const addedTokens = [...post].filter((t) => !pre.has(t)).sort();
  const removedTokens = [...pre].filter((t) => !post.has(t)).sort();

  // One token list per class attribute in the scrolled capture, so counting
  // carriers is a plain set-membership test.
  const scrolledAttrTokenLists = [
    ...scrolledHtml.matchAll(/\sclass=(?:"([^"]*)"|'([^']*)')/g),
  ].map((m) => (m[1] ?? m[2] ?? '').trim().split(/\s+/));

  const css = await collectCss(inlineStyles);
  const rules = cssRules(css);

  const added = addedTokens.map((token) => {
    const mentioning = rules.filter(([selector]) => selector.includes(`.${token}`));
    const baseCandidates = baseSelectorCandidates(token, mentioning);

    const hiddenBaseRules = [];
    for (const candidate of baseCandidates) {
      for (const [selector, body] of rules) {
        if (!selector.split(',').some((p) => p.trim() === candidate)) continue;
        if (!HIDES_CONTENT.test(body)) continue;
        hiddenBaseRules.push(`${selector}{${body}}`.slice(0, 220));
        if (hiddenBaseRules.length >= 3) break;
      }
      if (hiddenBaseRules.length >= 3) break;
    }

    // How many elements actually carry it once revealed. Compared as whole
    // class tokens rather than by building a regex from the token, because
    // real class names are full of regex metacharacters.
    let carriers = 0;
    for (const attrTokens of scrolledAttrTokenLists) {
      if (attrTokens.includes(token)) carriers += 1;
    }

    return {
      token,
      carriers,
      gatesVisibility: hiddenBaseRules.length > 0,
      hiddenBaseRules,
      revealRules: mentioning.slice(0, 2).map(([s, b]) => `${s}{${b}}`.slice(0, 220)),
    };
  });

  return { available: true, added, removed: removedTokens };
}

async function main() {
  await mkdir(paths.analysis, { recursive: true });

  const html = await readFile(paths.rawHtml, 'utf8');
  const doc = parse(html);

  const head = findAll(doc, (n) => n.tagName === 'head')[0];
  const body = findAll(doc, (n) => n.tagName === 'body')[0];
  if (!body) throw new Error('No <body> found in scrape/raw/index.html');

  // ---- head order -------------------------------------------------------
  const headLines = [];
  let styleIdx = 0;
  const inlineStyles = [];
  for (const node of kids(head ?? { childNodes: [] })) {
    if (node.tagName === 'link') {
      const rel = attrOf(node, 'rel') ?? '';
      const href = attrOf(node, 'href') ?? '';
      if (/stylesheet/i.test(rel)) headLines.push(`[css ] ${href}`);
      else headLines.push(`[link] rel=${rel} ${href.slice(0, 100)}`);
    } else if (node.tagName === 'style') {
      const css = textOf(node);
      inlineStyles.push(css);
      headLines.push(`[style ${String(styleIdx).padStart(2, '0')}] ${css.length} bytes`);
      styleIdx += 1;
    } else if (node.tagName === 'title') {
      headLines.push(`[title] ${textOf(node)}`);
    } else if (node.tagName === 'script') {
      const src = attrOf(node, 'src');
      headLines.push(src ? `[js  ] ${src}` : `[js inline] ${textOf(node).length} bytes`);
    }
  }
  await writeFile(path.join(paths.analysis, 'head-order.txt'), headLines.join('\n') + '\n');

  // Body <style> blocks cascade after the head ones.
  for (const st of findAll(body, (n) => n.tagName === 'style')) inlineStyles.push(textOf(st));

  for (const [i, css] of inlineStyles.entries()) {
    await writeFile(
      path.join(paths.analysis, `style-${String(i).padStart(2, '0')}.css`),
      css,
    );
  }

  // ---- inline scripts ---------------------------------------------------
  const scripts = findAll(doc, (n) => n.tagName === 'script' && !attrOf(n, 'src'));
  for (const [i, s] of scripts.entries()) {
    await writeFile(
      path.join(paths.analysis, `script-${String(i).padStart(2, '0')}.js`),
      textOf(s),
    );
  }

  // ---- body outline -----------------------------------------------------
  const treeLines = [];
  outline(body, 1, DEPTH, treeLines);
  await writeFile(path.join(paths.analysis, 'body-tree.txt'), treeLines.join('\n') + '\n');

  // ---- sections ---------------------------------------------------------
  const sectionLines = [];
  const topLevel = kids(body).filter((n) => n.tagName !== 'script' && n.tagName !== 'noscript');
  for (const node of topLevel) {
    sectionLines.push(`${describe(node)}  (${countEls(node)} els)`);
    // Recurse one level into big wrappers, which is where real sections live.
    if (kids(node).length >= 3) {
      for (const child of kids(node)) {
        sectionLines.push(`    ${describe(child)}  (${countEls(child)} els)`);
      }
    }
  }
  await writeFile(path.join(paths.analysis, 'sections.txt'), sectionLines.join('\n') + '\n');

  // ---- attribute census -------------------------------------------------
  const census = {};
  for (const el of findAll(body, () => true)) {
    for (const attr of el.attrs ?? []) {
      if (!/^(data-|aria-)/.test(attr.name) && !['id', 'role'].includes(attr.name)) continue;
      const entry = (census[attr.name] ??= { count: 0, values: new Set() });
      entry.count += 1;
      if (entry.values.size < 12) entry.values.add(attr.value.slice(0, 40));
    }
  }
  const attrLines = Object.entries(census)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, e]) => `${name.padEnd(28)} ${String(e.count).padStart(4)}  ${[...e.values].join(' | ').slice(0, 120)}`);
  await writeFile(path.join(paths.analysis, 'attrs.txt'), attrLines.join('\n') + '\n');

  // ---- scroll reveals ---------------------------------------------------
  const reveals = await detectScrollReveals(inlineStyles);
  await writeFile(
    path.join(paths.analysis, 'scroll-reveals.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), ...reveals }, null, 2),
  );
  const gating = reveals.added.filter((a) => a.gatesVisibility);

  // ---- summary ----------------------------------------------------------
  const summary = {
    generatedAt: new Date().toISOString(),
    totalElements: countEls(body),
    scrollRevealClasses: reveals.added.length,
    visibilityGatingClasses: gating.map((g) => g.token),
    headEntries: headLines.length,
    inlineStyleBlocks: inlineStyles.length,
    inlineScripts: scripts.length,
    topLevelBlocks: topLevel.length,
    sections: topLevel.map((n) => ({ selector: describe(n), elements: countEls(n) })),
    attributes: Object.fromEntries(
      Object.entries(census).map(([k, v]) => [k, { count: v.count, sample: [...v.values].slice(0, 6) }]),
    ),
  };
  await writeFile(path.join(paths.analysis, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`total elements    : ${summary.totalElements}`);
  console.log(`head entries      : ${summary.headEntries}`);
  console.log(`inline <style>    : ${summary.inlineStyleBlocks}`);
  console.log(`inline <script>   : ${summary.inlineScripts}`);
  console.log(`body top-level    : ${summary.topLevelBlocks}\n`);
  for (const s of summary.sections) console.log(`  ${s.selector.slice(0, 62).padEnd(64)} ${String(s.elements).padStart(5)} els`);

  // ---- scroll-reveal report (loud on purpose) ---------------------------
  console.log('\n--- scroll-reveal classes (added by the page\'s own JS while scrolling) ---');
  if (!reveals.available) {
    console.log(`  (skipped: ${reveals.reason})`);
  } else if (reveals.added.length === 0) {
    console.log('  none — the page adds no classes during a full scroll pass.');
  } else {
    for (const entry of reveals.added) {
      console.log(
        `  ${entry.token.slice(0, 54).padEnd(56)} ${String(entry.carriers).padStart(4)} carrier(s)` +
          (entry.gatesVisibility ? '   *** GATES VISIBILITY ***' : ''),
      );
      for (const rule of entry.hiddenBaseRules) console.log(`      hidden base: ${rule}`);
    }
    if (gating.length) {
      console.log(
        `\n  ${gating.length} of these GATE VISIBILITY: their base rule hides the element\n` +
          '  (opacity:0 / visibility:hidden / blur / scale). Each one MUST be\n' +
          '  re-applied by an effect in app/ClientRuntime.tsx — normally an\n' +
          '  IntersectionObserver that adds the class when the block scrolls in.\n' +
          '  Skip one and that content ships PERMANENTLY INVISIBLE: present in the\n' +
          '  DOM, correctly sized, no error anywhere, section looks empty.\n' +
          '  `npm run viewports` fails with `hidden-content` if you miss one.',
      );
    }
  }
  if (reveals.available && reveals.removed.length) {
    console.log(
      `\n  ${reveals.removed.length} class(es) were REMOVED by scrolling ` +
        '(state the capture froze ON; check nothing ships stuck open):',
    );
    for (const t of reveals.removed.slice(0, 8)) console.log(`    - ${t}`);
  }

  console.log(`\nwrote ${paths.analysis}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
