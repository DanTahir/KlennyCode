/**
 * Locates an already-installed Playwright Chromium.
 *
 * Deliberately uses `playwright-core` (no bundled browser download) and reuses
 * the shared ms-playwright cache, so a replica project adds ~2 MB of dev
 * dependency instead of ~400 MB of browser per project. If nothing is cached,
 * the caller is told the exact one-off command to run.
 */
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function cacheRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) roots.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  } else {
    roots.push(path.join(home, '.cache', 'ms-playwright'));
  }
  return roots;
}

/** Candidate executable paths inside a single chromium-* build directory. */
function exeCandidates(buildDir) {
  return [
    path.join(buildDir, 'chrome-win64', 'chrome.exe'),
    path.join(buildDir, 'chrome-win', 'chrome.exe'),
    path.join(buildDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join(buildDir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join(buildDir, 'chrome-linux', 'chrome'),
    // headless_shell builds (newer Playwright ships these separately)
    path.join(buildDir, 'chrome-win64', 'headless_shell.exe'),
    path.join(buildDir, 'chrome-linux', 'headless_shell'),
    path.join(buildDir, 'chrome-mac', 'headless_shell'),
  ];
}

/**
 * @returns {string} absolute path to a Chromium executable
 * @throws if no cached build exists
 */
export function findChromium() {
  const tried = [];

  for (const root of cacheRoots()) {
    tried.push(root);
    if (!existsSync(root)) continue;

    // Prefer full chromium builds over headless_shell, newest revision first.
    const builds = readdirSync(root)
      .filter((name) => /^chromium(_headless_shell)?-\d+$/.test(name))
      .sort((a, b) => {
        const shellA = a.includes('headless_shell') ? 1 : 0;
        const shellB = b.includes('headless_shell') ? 1 : 0;
        if (shellA !== shellB) return shellA - shellB;
        return Number(b.split('-').pop()) - Number(a.split('-').pop());
      });

    for (const build of builds) {
      for (const exe of exeCandidates(path.join(root, build))) {
        if (existsSync(exe)) return exe;
      }
    }
  }

  throw new Error(
    'No cached Playwright Chromium found. Looked in:\n' +
      tried.map((t) => `  ${t}`).join('\n') +
      '\n\nInstall it once (shared across all projects) with:\n' +
      '  npx playwright install chromium\n',
  );
}

/** Convenience launcher used by every browser-driven script here. */
export async function launch(chromiumApi, opts = {}) {
  return chromiumApi.launch({
    executablePath: findChromium(),
    headless: opts.headless ?? true,
    args: ['--hide-scrollbars', '--disable-features=IsolateOrigins,site-per-process'],
  });
}
