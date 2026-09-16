/**
 * Per-project configuration loader.
 *
 * Everything site-specific lives in `replica.config.json` at the project root.
 * The pipeline scripts themselves contain ZERO hardcoded site knowledge, which
 * is the whole point of this template: the same five scripts must work for any
 * target URL.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

export const paths = {
  root: ROOT,
  config: path.join(ROOT, 'replica.config.json'),
  baseline: path.join(ROOT, 'replica.baseline.json'),
  scrape: path.join(ROOT, 'scrape'),
  raw: path.join(ROOT, 'scrape', 'raw'),
  rawHtml: path.join(ROOT, 'scrape', 'raw', 'index.html'),
  rawHtmlStatic: path.join(ROOT, 'scrape', 'raw', 'index.static.html'),
  network: path.join(ROOT, 'scrape', 'raw', 'network.json'),
  head: path.join(ROOT, 'scrape', 'raw', 'head.json'),
  features: path.join(ROOT, 'scrape', 'raw', 'features.json'),
  assetMap: path.join(ROOT, 'scrape', 'asset-map.json'),
  analysis: path.join(ROOT, 'scrape', 'analysis'),
  shots: path.join(ROOT, 'scrape', 'shots'),
  publicAssets: path.join(ROOT, 'public', 'assets'),
  // Sections, stylesheets, metadata and the manifest all land in ONE
  // directory. layout.tsx/page.tsx and tests/generated.test.ts resolve
  // everything under app/generated, and index.css @imports its siblings by
  // relative path — splitting these across roots silently breaks both.
  appStyles: path.join(ROOT, 'app', 'generated'),
  appGenerated: path.join(ROOT, 'app', 'generated'),
  appLib: path.join(ROOT, 'app', 'lib'),
};

/**
 * Classes that only exist because we captured the *rendered* DOM: the original
 * page adds them at runtime to mark an animation as already-played. Baking them
 * into the markup would ship the page in its finished state with every entrance
 * animation dead. Stripped by codegen unless overridden.
 */
const DEFAULT_STRIP_CLASSES = [
  'faded-in', 'fade-in-view', 'is-visible', 'is-inview', 'in-view', 'visible',
  'animated', 'aos-animate', 'revealed', 'has-entered', 'is-active-scroll',
  'swiper-initialized', 'swiper-backface-hidden', 'swiper-slide-active',
  'swiper-slide-next', 'swiper-slide-prev', 'swiper-slide-visible',
  'swiper-slide-duplicate', 'swiper-slide-duplicate-active',
  'swiper-slide-duplicate-next', 'swiper-slide-duplicate-prev',
  'w--open', 'w-nav-open', 'w--redirected-focus', 'anti-flicker',
  'lenis', 'lenis-smooth', 'lenis-scrolling', 'lenis-stopped',
];

/**
 * Inline style properties the runtime writes onto elements (entrance
 * animations, carousel transforms). Same reasoning as STRIP_CLASSES: keeping
 * them freezes the animation at its final frame, or worse at `opacity: 0`.
 */
const DEFAULT_STRIP_INLINE_STYLE_PROPS = [
  'opacity', 'transform', 'translate', 'rotate', 'scale',
  'transition', 'transition-duration', 'transition-delay', 'transition-property',
  'animation', 'animation-delay', 'animation-name', 'animation-play-state',
  'visibility', 'will-change',
];

/**
 * Elements that are pure *hosts* for runtime-generated children: the page's own
 * JS appends clones/nodes into them after load. A rendered-DOM capture bakes
 * those children in, so the replica ships with permanent copies of transient
 * animation nodes AND then generates its own at runtime -> visible duplicates.
 * Matching elements are shipped empty (and lose their inline `style`, which on
 * a pure runtime host is by definition runtime state).
 */
const DEFAULT_EMPTY_SELECTORS = ['[data-replica-empty]'];

/**
 * Elements that are runtime-generated *wrappers* around authored content
 * (per-word/per-letter split spans, typewriter carets). The capture bakes them
 * in; stripping their runtime state class leaves a bare wrapper that CSS
 * renders in its finished state, so the animation appears already-played and
 * frozen. Matching elements are replaced by their own children, restoring the
 * pristine text the site's JS would have split itself.
 */
const DEFAULT_UNWRAP_SELECTORS = ['[data-replica-unwrap]'];

/** Elements injected by third parties that are not part of the design. */
const DEFAULT_DROP_SELECTORS = [
  'script', 'noscript',
  'iframe[src*="googletagmanager"]', 'iframe[src*="doubleclick"]',
  'iframe[src*="facebook"]', 'iframe[src*="hubspot"]',
  '#onetrust-consent-sdk', '#CybotCookiebotDialog', '#cookiescript_injected',
  '.ot-sdk-container', '#usercentrics-root', '#hs-web-interactives-top-anchor',
  '#intercom-frame', '.intercom-lightweight-app', '#drift-frame-controller',
  '#crisp-chatbox', '#tawkchat-container', '.grecaptcha-badge',
  // Framework-injected a11y/runtime artifacts, not part of the design. Next.js
  // appends <next-route-announcer> to <body> at runtime to announce client-side
  // route changes; a rendered capture bakes it in, where it becomes a bogus
  // top-level section AND an unknown JSX element (TS2339: Property
  // 'next-route-announcer' does not exist on type 'JSX.IntrinsicElements').
  // The replica's own Next runtime recreates it, so dropping is correct.
  'next-route-announcer',
  '[data-replica-drop]',
];

/**
 * Captured stylesheets to leave OUT of the rebuilt cascade, matched as a
 * substring of the original href.
 *
 * Normally every sheet the <head> declared must be emitted, in order, or the
 * cascade stops matching the original. The exception is a sheet the *browser
 * itself* could not use: sites occasionally ship a preprocessor SOURCE file at
 * a URL the page links directly (e.g. a `.scss` still containing `//` comments
 * and `$variable` declarations). A browser applies its error recovery, drops
 * every unparseable rule, and renders identically without it — but webpack's
 * postcss parses eagerly and fails the build outright on the first `//`.
 *
 * Only skip a sheet after confirming BOTH: (a) it is genuinely unparseable as
 * CSS, and (b) nothing it uniquely defines is used — i.e. a later, valid sheet
 * redefines the same rules. Otherwise you are silently deleting real styles.
 */
const DEFAULT_SKIP_STYLESHEETS = [];

/** Hosts whose requests are aborted during capture and never downloaded. */
const DEFAULT_BLOCK_HOSTS = [
  'googletagmanager', 'google-analytics', 'analytics.google', 'doubleclick',
  'googleadservices', 'googlesyndication', 'g.doubleclick',
  'hotjar', 'hubspot', 'hs-scripts', 'hs-analytics', 'hsforms',
  'intercom', 'intercomcdn', 'drift.com', 'driftt', 'crisp.chat', 'tawk.to',
  'livechat', 'zendesk', 'zdassets', 'freshchat',
  'segment.com', 'segment.io', 'posthog', 'sentry', 'bugsnag', 'newrelic',
  'mixpanel', 'amplitude', 'heap.io', 'heapanalytics', 'fullstory',
  'clarity.ms', 'mouseflow', 'luckyorange', 'crazyegg', 'inspectlet',
  'facebook.net', 'facebook.com/tr', 'connect.facebook',
  'linkedin.com', 'licdn.com/li.lms', 'twitter.com/i/', 'ads-twitter',
  'tiktok.com/i18n', 'analytics.tiktok', 'reddit.com/api', 'redditstatic.com/ads',
  'bat.bing.com', 'bing.com/action', 'pinterest.com/ct',
  'onetrust', 'cookielaw', 'cookiebot', 'cookiescript', 'usercentrics',
  'osano', 'termly', 'iubenda', 'quantcast',
  'optimizely', 'intellimize', 'vwo.com', 'visualwebsiteoptimizer',
  'launchdarkly', 'split.io', 'convertexperiments',
  'rb2b', 'clearbit', '6sense', 'marketo', 'pardot', 'demandbase',
  'vitals.vercel-insights', 'vercel-analytics', 'cloudflareinsights',
  'recaptcha', 'gstatic.com/recaptcha',
];

/** Viewports the responsive harness audits. Mobile-first, matches coframe3. */
const DEFAULT_VIEWPORTS = [
  { name: 'iphone-se', width: 375, height: 667, dpr: 2, mobile: true },
  { name: 'iphone-14-pro', width: 393, height: 852, dpr: 3, mobile: true },
  { name: 'pixel-7', width: 412, height: 915, dpr: 2.625, mobile: true },
  { name: 'ipad-mini', width: 768, height: 1024, dpr: 2, mobile: true },
  { name: 'ipad-pro', width: 1024, height: 1366, dpr: 2, mobile: false },
  { name: 'laptop', width: 1440, height: 900, dpr: 1, mobile: false },
  { name: 'desktop-wide', width: 1920, height: 1080, dpr: 1, mobile: false },
];

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let cached = null;

export async function loadConfig() {
  if (cached) return cached;

  let cfg;
  try {
    cfg = JSON.parse(await readFile(paths.config, 'utf8'));
  } catch (err) {
    throw new Error(
      `Could not read replica.config.json at ${paths.config}: ${err.message}`,
    );
  }

  if (!cfg.targetUrl) throw new Error('replica.config.json is missing "targetUrl"');

  const target = new URL(cfg.targetUrl);

  cached = {
    targetUrl: target.href,
    origin: target.origin,
    host: target.host,
    slug: cfg.slug ?? target.host.replace(/[^a-z0-9]/gi, '').toLowerCase(),
    port: cfg.port ?? 3300,
    // Which captured markup codegen builds the JSX from:
    // 'auto'     - use the pre-JS server response when it is substantially
    //              complete, else the rendered DOM (see codegen.mjs).
    // 'static'   - always use scrape/raw/index.static.html.
    // 'rendered' - always use scrape/raw/index.html (bakes in runtime nodes).
    captureMode: cfg.captureMode ?? 'auto',
    settleMs: cfg.settleMs ?? 3500,
    scrollSettleMs: cfg.scrollSettleMs ?? 90,
    codegen: {
      stripClasses: cfg.codegen?.stripClasses ?? DEFAULT_STRIP_CLASSES,
      stripInlineStyleProps:
        cfg.codegen?.stripInlineStyleProps ?? DEFAULT_STRIP_INLINE_STYLE_PROPS,
      dropSelectors: cfg.codegen?.dropSelectors ?? DEFAULT_DROP_SELECTORS,
      emptySelectors: cfg.codegen?.emptySelectors ?? DEFAULT_EMPTY_SELECTORS,
      unwrapSelectors: cfg.codegen?.unwrapSelectors ?? DEFAULT_UNWRAP_SELECTORS,
      keepClasses: cfg.codegen?.keepClasses ?? [],
      splitMinChildren: cfg.codegen?.splitMinChildren ?? 5,
      splitMinSections: cfg.codegen?.splitMinSections ?? 3,
      ignoredNameClasses: cfg.codegen?.ignoredNameClasses ?? [
        'section', 'w-inline-block', 'w-nav', 'w-embed', 'w-script',
        'container', 'wrapper', 'row', 'col', 'grid', 'flex',
      ],
      skipStylesheets: cfg.codegen?.skipStylesheets ?? DEFAULT_SKIP_STYLESHEETS,
    },
    blockHosts: cfg.blockHosts ?? DEFAULT_BLOCK_HOSTS,
    viewports: cfg.viewports ?? DEFAULT_VIEWPORTS,
    links: cfg.links ?? 'absolute',
    // Absolute URLs to download even though the capture browser never
    // requested them. Capture happens at ONE viewport, so responsive media
    // for other breakpoints (a <source media="..."> or srcset variant the
    // browser declined, especially when the site picks the source in JS via
    // matchMedia rather than letting the browser do it) is never fetched and
    // then 404s at exactly the viewports the harness audits.
    extraAssets: cfg.extraAssets ?? [],
  };

  return cached;
}

/** Loads the proven-upstream-quirk baseline, if the agent created one. */
export async function loadBaseline() {
  try {
    return JSON.parse(await readFile(paths.baseline, 'utf8'));
  } catch {
    return { overflow: {} };
  }
}
