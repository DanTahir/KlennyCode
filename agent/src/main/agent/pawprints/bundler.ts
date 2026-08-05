import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { PAWPRINT_SDK_MODULE } from './validator'
import { PAWPRINT_SDK_SOURCE } from './sdk'
import { pawprintNodeModulesDir } from './paths'
import { VETTED_LIBRARY_ALIASES } from './vettedLibraries'
import type { PawprintPackageRef } from './types'

const nodeRequire = createRequire(import.meta.url)

// Resolved once at module load, not per-build — avoids repeated filesystem `require.resolve()`
// lookups under load (each `bundlePawprint()` call previously re-resolved all four aliases).
const REACT_ALIASES = {
  react: nodeRequire.resolve('react'),
  'react-dom': nodeRequire.resolve('react-dom'),
  'react-dom/client': nodeRequire.resolve('react-dom/client'),
  'react/jsx-runtime': nodeRequire.resolve('react/jsx-runtime')
}

// Phase 8: vetted-library aliases (nanoid, etc. — see vettedLibraries.ts) merged in alongside
// the React aliases so a Pawprint's source can import them directly, resolved against Klenny's
// own node_modules, with no extra-package approval step required.
const ALL_ALIASES = { ...REACT_ALIASES, ...VETTED_LIBRARY_ALIASES }

export interface BundleResult {
  code: string
  cacheKey: string
}

interface BundleCacheEntry {
  cacheKey: string
  code: string
}

const bundleCache = new Map<string, BundleCacheEntry>()

function sdkPlugin() {
  return {
    name: 'klenny-pawprint-sdk',
    setup(api: import('esbuild').PluginBuild) {
      api.onResolve({ filter: new RegExp(`^${PAWPRINT_SDK_MODULE}$`) }, () => ({
        path: PAWPRINT_SDK_MODULE,
        namespace: 'klenny-pawprint-sdk-ns'
      }))
      api.onLoad({ filter: /.*/, namespace: 'klenny-pawprint-sdk-ns' }, () => ({
        contents: PAWPRINT_SDK_SOURCE,
        loader: 'js'
      }))
    }
  }
}

const USER_SOURCE_MODULE = 'klenny-pawprint-user-source'

/** Exposes the agent's approved TSX source as its own virtual module, resolved via esbuild's
 *  plugin API (same mechanism as sdkPlugin) rather than bundled as the literal stdin entry
 *  point — this lets the real esbuild entry point be a small wrapper (see ENTRY_WRAPPER below)
 *  that actually mounts the user's default-exported component to the DOM, instead of just
 *  bundling an unused component definition that's never rendered. */
function userSourcePlugin(source: string) {
  return {
    name: 'klenny-pawprint-user-source',
    setup(api: import('esbuild').PluginBuild) {
      api.onResolve({ filter: new RegExp(`^${USER_SOURCE_MODULE}$`) }, () => ({
        path: USER_SOURCE_MODULE,
        namespace: 'klenny-pawprint-user-source-ns'
      }))
      api.onLoad({ filter: /.*/, namespace: 'klenny-pawprint-user-source-ns' }, () => ({
        contents: source,
        loader: 'tsx'
      }))
    }
  }
}

/** The real esbuild entry point. The agent's own source only ever exports its App component
 *  (bundled as a virtual module, not the entry itself) — nothing in the agent-authored code is
 *  responsible for actually mounting to the DOM, so the bundler must do it here, once, uniformly
 *  for every Pawprint. Mirrors protocol.ts's htmlShell() `<div id="root">`.
 *
 *  DELIBERATELY built via concatenated quoted string literals, NOT a backtick template literal
 *  with raw embedded newlines — this is load-bearing, not a style choice. electron-vite's own
 *  `esmShimPlugin` (dist/chunks/lib-*.mjs) injects CJS interop shims (`__filename`/`__dirname`/
 *  `require`) into the main process's single bundled Rollup chunk via a *plain text regex*
 *  (`ESMStaticImportRe`) scanning the final rendered chunk text for `import ... from '...'` —
 *  it has no AST awareness, so it can't tell a real import from literal string content that
 *  merely looks like one. Real top-level imports get hoisted to the top of the chunk by Rollup,
 *  so the textually-*last* regex match in the whole ~450KB+ main bundle ends up being whichever
 *  substring inside this file happens to look most like "import X from 'Y'" — and the plugin
 *  splices its shim block directly into the *middle of that string's runtime value* at that
 *  position. A backtick template literal preserves the raw newline before `import` verbatim in
 *  the compiled output, which satisfies the regex's `(?<=\s|^|;)` lookbehind and got matched;
 *  the corrupted ENTRY_WRAPPER was then fed to esbuild as stdin content, producing a literal,
 *  deterministic `Could not resolve "node:module"` error at build time (seen in production, not
 *  reproducible via a direct-TypeScript/Bun test since that path never goes through Rollup).
 *  A JS string literal (single/double-quoted) can never contain a literal raw newline byte —
 *  only the two-character `\n` escape sequence — so writing it this way instead produces the
 *  identical runtime string but can never satisfy that lookbehind... EXCEPT this must avoid
 *  template literals *entirely*, including for interpolating USER_SOURCE_MODULE below. An
 *  earlier version of this fix used a backtick template literal for just that one line (to get
 *  `${USER_SOURCE_MODULE}` interpolation) — Rollup's production minifier (esbuild) then
 *  constant-folded the whole `+`-chain into a *single template literal* (the only literal type
 *  that can hold the interpolation), and since a raw newline is legal and 1 byte shorter than
 *  the `\n` escape inside backticks, the minifier "downgraded" every escaped `\n` back into a
 *  literal raw newline to save bytes — silently reintroducing the exact same corruption in the
 *  production build. Plain quoted strings can NEVER legally contain a raw newline byte at all
 *  (it's a syntax error unless escaped), so as long as no operand anywhere in this expression is
 *  a template literal, no minifier can produce one from folding plain-string `+` concatenation.
 *  Do not reintroduce a template literal anywhere in this construction, including via
 *  interpolation — use plain `+` concatenation with USER_SOURCE_MODULE instead. */
const ENTRY_WRAPPER =
  "import { createRoot } from 'react-dom/client'\n" +
  "import App from '" + USER_SOURCE_MODULE + "'\n" +
  "const rootEl = document.getElementById('root')\n" +
  'if (rootEl) {\n' +
  '  const root = createRoot(rootEl)\n' +
  '  root.render(<App />)\n' +
  '}\n'

function computeCacheKey(source: string, packages: PawprintPackageRef[], sourceVersion: number): string {
  const pkgKey = packages
    .map((p) => `${p.name}@${p.version}`)
    .sort()
    .join(',')
  return createHash('sha256').update(source).update(pkgKey).update(String(sourceVersion)).digest('hex')
}

/**
 * Bundles one Pawprint's approved source (+ approved extra packages already materialized into
 * `userData/pawprints/<id>/node_modules/` by the package pipeline, + React/ReactDOM resolved
 * against this app's own bundled copies) into a single JS string, cached in memory keyed by
 * source hash + package-set hash + sourceVersion. Never re-resolves anything at runtime inside
 * the sandboxed window — bundling happens once here, in the main process, at approval time.
 *
 * The esbuild entry point is always the small ENTRY_WRAPPER, not the agent's source directly —
 * the agent's source is exposed as its own virtual module (userSourcePlugin) and imported by the
 * wrapper, which is what actually calls createRoot(...).render(<App/>). Without this indirection
 * the bundle would define an App component that's never mounted, rendering a blank window.
 */
export async function bundlePawprint(id: string, source: string, packages: PawprintPackageRef[], sourceVersion: number): Promise<BundleResult> {
  const cacheKey = computeCacheKey(source, packages, sourceVersion)
  const cached = bundleCache.get(id)
  if (cached && cached.cacheKey === cacheKey) return { code: cached.code, cacheKey }

  // esbuild's `alias`/`resolveDir`/`absWorkingDir` resolution silently fails to resolve even a
  // fully-qualified absolute alias target (e.g. the react-dom/client path in ALL_ALIASES) when
  // the working directory it's given doesn't exist on disk — this directory is only otherwise
  // created by the extra-package pipeline (packagePipeline.ts), which never runs for a Pawprint
  // with zero requested packages (the common case). Ensure it always exists before every build,
  // not just when packages were materialized into it.
  await mkdir(pawprintNodeModulesDir(id), { recursive: true })

  const buildOnce = () =>
    build({
      stdin: { contents: ENTRY_WRAPPER, loader: 'tsx', resolveDir: pawprintNodeModulesDir(id) },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'chrome110',
      jsx: 'automatic',
      absWorkingDir: pawprintNodeModulesDir(id),
      nodePaths: [pawprintNodeModulesDir(id)],
      alias: ALL_ALIASES,
      // React/ReactDOM's real entry files branch on `process.env.NODE_ENV` at module-body level
      // (`if (process.env.NODE_ENV === 'production') { ... } else { ... }`) to pick their
      // dev-vs-prod build internally — this is true even though ALL_ALIASES already points at
      // each package's top-level entry (that entry itself contains the branch; it's not a
      // separate file esbuild could pick between via resolution alone). `platform: 'browser'`
      // never shims a global `process` object (unlike `platform: 'node'`), so without telling
      // esbuild what NODE_ENV is, that reference survives verbatim into the output as a plain
      // global-variable read. The sandboxed Pawprint BrowserWindow has nodeIntegration:false,
      // contextIsolation:true, sandbox:true — there is no `process` global there at all — so the
      // bundle throws `ReferenceError: process is not defined` at the very top of the IIFE,
      // before createRoot/render ever runs. That produced a silently blank white window (correct
      // title/size/chrome, since the HTML shell itself loaded fine) with no build-time error,
      // since this is a *runtime* failure invisible to bundlePawprint's own esbuild call.
      // Defining it here lets esbuild dead-code-eliminate the dev branch entirely at build time,
      // so no reference to the `process` global remains in the emitted output at all.
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [sdkPlugin(), userSourcePlugin(source)],
      logLevel: 'silent'
    })

  // esbuild's module resolution can transiently fail to resolve an already-verified absolute
  // path under filesystem contention (e.g. AV scanning a just-touched directory on Windows) —
  // a few retries with a short backoff absorb that without masking a genuinely broken
  // source/alias (a real syntax error or missing package fails identically on every attempt).
  const MAX_ATTEMPTS = 5
  let result: Awaited<ReturnType<typeof buildOnce>> | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await buildOnce()
      lastError = undefined
      break
    } catch (e) {
      lastError = e
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 50 * attempt))
    }
  }
  if (lastError || !result) throw lastError ?? new Error('bundlePawprint: esbuild produced no result and no error')

  const code = result.outputFiles?.[0]?.text ?? ''
  bundleCache.set(id, { cacheKey, code })
  return { code, cacheKey }
}

export function clearBundleCache(id: string): void {
  bundleCache.delete(id)
}
