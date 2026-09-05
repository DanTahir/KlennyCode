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
 *   scrape/analysis/summary.json     machine-readable roll-up
 *
 * Usage: node scripts/analyze.mjs [--depth=6]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

  // ---- summary ----------------------------------------------------------
  const summary = {
    generatedAt: new Date().toISOString(),
    totalElements: countEls(body),
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
  console.log(`\nwrote ${paths.analysis}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
