#!/usr/bin/env node
/**
 * Stage 2 — asset download.
 *
 * Sources of truth, in order of reliability:
 *   1. scrape/raw/network.json — every URL the real browser actually fetched.
 *      This is strictly better than parsing markup: it captures runtime-loaded
 *      webfonts, .riv/.wasm binaries, and CSS-referenced sprites for free.
 *   2. the rendered + static HTML — catches things referenced but not fetched
 *      (e.g. an <img> below the fold with a `srcset` the browser skipped, or a
 *      preload the browser declined).
 *   3. one recursion pass into every downloaded CSS/JS file, for url() refs.
 *
 * Everything lands in scrape/raw/<kind>/ (cache) and public/assets/<kind>/
 * (served), and is recorded in scrape/asset-map.json as remoteUrl -> localPath.
 *
 * Idempotent: cached files are reused unless --force.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, paths, DESKTOP_UA } from './lib/config.mjs';
import {
  kindOf,
  localName,
  makeHostBlocker,
  refsFromHtml,
  refsFromText,
} from './lib/assets.mjs';

const FORCE = process.argv.includes('--force');

/** Resource types that are page navigations or telemetry, never assets. */
const SKIP_RESOURCE_TYPES = new Set(['document', 'xhr', 'fetch', 'websocket', 'eventsource', 'ping', 'beacon']);

/** ...except when the response is clearly a real asset we want. */
const ASSET_CONTENT_TYPE = /^(text\/css|font\/|image\/|video\/|audio\/|application\/(wasm|font|x-font|javascript|json))/;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, contentTypeHint, referer) {
  const kind = kindOf(url, contentTypeHint);
  const name = localName(url, contentTypeHint);
  const rawDir = path.join(paths.raw, kind);
  const pubDir = path.join(paths.publicAssets, kind);
  await mkdir(rawDir, { recursive: true });
  await mkdir(pubDir, { recursive: true });
  const rawPath = path.join(rawDir, name);
  const pubPath = path.join(pubDir, name);

  if (!FORCE && (await exists(rawPath))) {
    const buf = await readFile(rawPath);
    if (!(await exists(pubPath))) await writeFile(pubPath, buf);
    return { url, kind, name, bytes: buf.length, cached: true, buf };
  }

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Referer: referer,
        Accept: '*/*',
      },
    });
  } catch (err) {
    return { url, kind, name, error: `NETWORK ${err.message}` };
  }
  if (!res.ok) return { url, kind, name, error: `HTTP ${res.status}` };

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return { url, kind, name, error: 'EMPTY' };

  await writeFile(rawPath, buf);
  await writeFile(pubPath, buf);
  return { url, kind, name, bytes: buf.length, buf };
}

async function main() {
  const cfg = await loadConfig();
  const isBlocked = makeHostBlocker(cfg.blockHosts);

  // ---- source 1: the real network log -----------------------------------
  let net = { requests: [] };
  try {
    net = JSON.parse(await readFile(paths.network, 'utf8'));
  } catch {
    console.log('warning: no network.json — run `npm run capture` first for best coverage');
  }

  const contentTypes = new Map();
  const fromNetwork = [];
  for (const r of net.requests ?? []) {
    if (r.status >= 400) continue;
    if (!/^https?:/i.test(r.url)) continue;
    if (isBlocked(r.url)) continue;
    if (r.url === cfg.targetUrl) continue;

    const isAssetish =
      !SKIP_RESOURCE_TYPES.has(r.resourceType) || ASSET_CONTENT_TYPE.test(r.contentType ?? '');
    if (!isAssetish) continue;
    if (kindOf(r.url, r.contentType) === 'other') continue;

    contentTypes.set(r.url, r.contentType ?? '');
    fromNetwork.push(r.url);
  }

  // ---- source 2: markup references --------------------------------------
  const fromMarkup = [];
  for (const htmlPath of [paths.rawHtml, paths.rawHtmlStatic, path.join(paths.raw, 'index.scrolled.html')]) {
    try {
      const html = await readFile(htmlPath, 'utf8');
      fromMarkup.push(...refsFromHtml(html, cfg.targetUrl, isBlocked));
    } catch { /* optional */ }
  }

  const queue = [...new Set([...fromNetwork, ...fromMarkup])];
  console.log(
    `stage 1: ${queue.length} candidate assets ` +
      `(${new Set(fromNetwork).size} from network log, ${new Set(fromMarkup).size} from markup)`,
  );

  const map = {};
  const errors = [];
  const seen = new Set();
  const round1 = [];

  for (const url of queue) {
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await download(url, contentTypes.get(url), cfg.targetUrl);
    if (r.error) {
      errors.push({ url: r.url, error: r.error });
      continue;
    }
    map[url] = `/assets/${r.kind}/${r.name}`;
    round1.push(r);
    console.log(`  [${r.kind}] ${r.name} ${r.cached ? '(cached)' : `${r.bytes}b`}`);
  }

  // ---- source 3: recurse into text assets -------------------------------
  const nested = new Set();
  for (const r of round1) {
    if (r.kind !== 'css' && r.kind !== 'js') continue;
    let text;
    try {
      text = r.buf.toString('utf8');
    } catch {
      continue;
    }
    for (const ref of refsFromText(text, r.url, isBlocked)) nested.add(ref);
  }

  const nestedNew = [...nested].filter((u) => !seen.has(u));
  console.log(`stage 2: ${nestedNew.length} nested refs from css/js`);
  for (const url of nestedNew) {
    seen.add(url);
    const r = await download(url, contentTypes.get(url), cfg.targetUrl);
    if (r.error) {
      errors.push({ url: r.url, error: r.error });
      continue;
    }
    map[url] = `/assets/${r.kind}/${r.name}`;
    console.log(`  [${r.kind}] ${r.name} ${r.cached ? '(cached)' : `${r.bytes}b`}`);
  }

  await mkdir(path.dirname(paths.assetMap), { recursive: true });
  await writeFile(
    paths.assetMap,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseUrl: cfg.targetUrl,
        count: Object.keys(map).length,
        map,
        errors,
      },
      null,
      2,
    ),
  );

  const byKind = {};
  for (const local of Object.values(map)) {
    const k = local.split('/')[2];
    byKind[k] = (byKind[k] ?? 0) + 1;
  }

  console.log('\n--- scrape summary ---');
  console.log(`assets mapped: ${Object.keys(map).length}`);
  console.log(byKind);
  if (errors.length) {
    console.log(`\nerrors: ${errors.length}`);
    for (const e of errors.slice(0, 15)) console.log(`  ${e.error}  ${e.url.slice(0, 110)}`);
    console.log(
      '\nNote: a handful of errors is normal (hotlink-protected or expired CDN\n' +
        'URLs). Each one must still be checked against the page — if a visible\n' +
        'image is missing, find its real URL and add it manually.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
