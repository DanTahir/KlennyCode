/**
 * One-time Chromium download for browser automation (see manager.ts/network-policy.ts for the
 * rest of the browser-automation stack).
 *
 * Playwright's npm package does NOT ship browser binaries and does not download them on
 * `npm`/`bun install` — that's a separate step (`playwright install chromium`) that normally
 * happens once, manually, in a dev/CI environment. Since Klenny Code is a packaged end-user app
 * with no such step, this module does it lazily on first use instead: the first time a browser
 * session is launched (and no custom `browserExecutablePath` override is configured), it checks
 * whether Chromium is already present in Playwright's global cache
 * (`~/.cache/ms-playwright` on Linux/macOS, `%LOCALAPPDATA%\ms-playwright` on Windows) and, if
 * not, shells out to Playwright's own CLI to fetch it — surfacing progress via a callback so the
 * caller can reflect it in the UI (see `tool_call_progress` in shared/types.ts).
 */
import { existsSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

/** Matches the subset of node:child_process's `spawn` this module uses — kept narrow and
 *  injectable (rather than mocking the 'node:child_process' module in tests) because
 *  `mock.module` is process-global in Bun and other tests (e.g. run_command/grep, which really
 *  do need to spawn real processes) would otherwise silently get a fake child process too. */
export type SpawnFn = typeof nodeSpawn

export type InstallProgressCallback = (message: string) => void

/** True if Chromium is already downloaded and Playwright would find it without installing. */
export function isChromiumInstalled(): boolean {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

/** Resolves Playwright's `cli.js` on disk via Node module resolution — this works whether the
 *  package is unpacked from app.asar (asarUnpack covers `playwright`/`playwright-core`, see
 *  package.json) or, in dev, sitting in node_modules normally. */
function resolvePlaywrightCli(): string {
  const require = createRequire(import.meta.url)
  // The package's "main" entry (index.js) lives next to cli.js in the same package root.
  const pkgMain = require.resolve('playwright')
  return pkgMain.replace(/index\.(m?js)$/, 'cli.js')
}

let installPromise: Promise<void> | null = null

/**
 * Ensures Chromium is installed, downloading it if necessary. Safe to call concurrently — every
 * caller shares the same in-flight download rather than racing separate `playwright install`
 * processes. Resolves immediately (no-op) if Chromium is already present.
 */
export async function ensureChromiumInstalled(
  onProgress?: InstallProgressCallback,
  spawnFn: SpawnFn = nodeSpawn
): Promise<void> {
  if (isChromiumInstalled()) return

  if (!installPromise) {
    installPromise = installChromium(onProgress, spawnFn).finally(() => {
      installPromise = null
    })
  }
  return installPromise
}

function installChromium(onProgress: InstallProgressCallback | undefined, spawnFn: SpawnFn): Promise<void> {
  return new Promise((resolve, reject) => {
    let cliPath: string
    try {
      cliPath = resolvePlaywrightCli()
    } catch (e) {
      reject(new Error(`Could not locate Playwright's CLI to install Chromium: ${e instanceof Error ? e.message : String(e)}`))
      return
    }

    onProgress?.('Downloading Chromium for browser automation (one-time, ~150 MB)…')

    // process.execPath is the Electron binary itself when packaged; ELECTRON_RUN_AS_NODE makes
    // it behave as a plain Node runtime for this one child process instead of relaunching the app.
    const child = spawnFn(process.execPath, [cliPath, 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })

    let lastLine = ''
    let stderr = ''
    const onData = (buf: Buffer) => {
      const text = buf.toString('utf8')
      // Playwright's installer redraws a progress line using \r, not \n — split on both and
      // keep the last non-empty fragment as the most recent status.
      const parts = text.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean)
      if (parts.length) {
        lastLine = parts[parts.length - 1]
        onProgress?.(lastLine)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8')
      onData(buf)
    })

    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.('Chromium download complete.')
        resolve()
      } else {
        reject(new Error(`playwright install chromium exited with code ${code}: ${stderr.trim() || lastLine}`))
      }
    })
  })
}
