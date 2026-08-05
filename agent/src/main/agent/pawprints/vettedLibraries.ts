import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const nodeRequire = createRequire(import.meta.url)

/**
 * Phase 8 (plan section 7 / "Vetted library allowlist"): a small, explicit set of common
 * libraries pre-bundled with Klenny Code itself and made available to every Pawprint's source
 * without going through the agent-proposed extra-package pipeline (packagePipeline.ts). This is
 * a deliberately separate, distinct mechanism from that pipeline — these libraries are resolved
 * against Klenny's own `node_modules` at bundle time (like the existing React aliases in
 * bundler.ts), never fetched from the npm registry at runtime, never shown in the
 * packages-approval UI, and never subject to the sha512/native-binding/size-cap checks that only
 * make sense for a *requested* third-party package. Adding an entry here is a decision made by
 * whoever ships Klenny Code (a source-level allowlist, reviewed like any other dependency bump),
 * not something an agent or user can expand at runtime.
 *
 * v1 intentionally starts minimal: `nanoid` is already a direct dependency of this app (used
 * throughout the main process for id generation — scheduler, approval manager, sessions,
 * terminal, etc.), so exposing it to Pawprints costs nothing extra in bundle-maintenance surface
 * and is a genuinely common need for generated apps (list items, todo entries, and similar need
 * stable unique ids). Extending this list is expected as real Pawprint use cases emerge — each
 * addition should be a small, pure, dependency-light, browser-safe library, following the same
 * bar `nanoid` meets here.
 */
export const VETTED_LIBRARY_NAMES: readonly string[] = ['nanoid']

/**
 * Resolves a package's browser-safe entry point rather than its default (often Node-targeted)
 * main entry. Several otherwise browser-friendly packages (nanoid included) ship a
 * `package.json` "browser" field remapping their main entry to a build that avoids Node built-ins
 * like `node:crypto` in favor of Web Crypto — esbuild's `alias` option does its own direct
 * path substitution and does NOT consult that field the way normal bare-specifier resolution
 * would, so a naive `require.resolve(name)` picks the Node entry and fails to bundle for the
 * `platform: 'browser'` target used by bundler.ts. Falls back to the plain resolved path if the
 * package has no such mapping.
 */
function resolveBrowserSafeEntry(name: string): string {
  const mainEntryPath = nodeRequire.resolve(name)
  try {
    const pkgJsonPath = nodeRequire.resolve(`${name}/package.json`)
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { browser?: Record<string, string> | string }
    if (pkg.browser && typeof pkg.browser === 'object') {
      // Keyed by the package's own relative main-entry filename (e.g. "./index.js") — find the
      // remap regardless of the exact key formatting used by the mapping.
      const pkgDir = dirname(pkgJsonPath)
      for (const [fromRel, toRel] of Object.entries(pkg.browser)) {
        const fromAbs = join(pkgDir, fromRel)
        if (fromAbs === mainEntryPath && typeof toRel === 'string') {
          return join(pkgDir, toRel)
        }
      }
    }
  } catch {
    // No package.json / no browser field / malformed — fall back to the default main entry.
  }
  return mainEntryPath
}

/** esbuild `alias` map entries for every vetted library, resolved once at module load (same
 *  pattern as bundler.ts's `REACT_ALIASES`) rather than per-build, preferring each package's
 *  browser-safe entry point when one is declared (see resolveBrowserSafeEntry). */
export const VETTED_LIBRARY_ALIASES: Record<string, string> = Object.fromEntries(
  VETTED_LIBRARY_NAMES.map((name) => [name, resolveBrowserSafeEntry(name)])
)
