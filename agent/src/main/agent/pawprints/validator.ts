import './esbuildBinaryPath' // side-effect import — see that file's doc comment (Bug #10)
import * as acorn from 'acorn'
import { simple as walkSimple } from 'acorn-walk'
import { VETTED_LIBRARY_NAMES } from './vettedLibraries'

/** SDK virtual module name — the one import every Pawprint is allowed to use to talk to the
 *  host app. Must match sdk.ts / bundler.ts exactly. */
export const PAWPRINT_SDK_MODULE = 'klenny-pawprint-sdk'

/** Bare specifiers a Pawprint's source may import, beyond the SDK and its own approved extra
 *  packages (checked by name against the manifest's approved package list at validate time).
 *  Includes the Phase 8 vetted-library allowlist (vettedLibraries.ts) — those are pre-bundled
 *  with Klenny itself, so (unlike agent-requested extra packages) they never need to appear in
 *  a Pawprint's approved-packages list to be importable. */
const ALWAYS_ALLOWED_IMPORTS = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
  PAWPRINT_SDK_MODULE,
  ...VETTED_LIBRARY_NAMES
])

/** Identifiers that would let generated code reach outside its sandbox even though the renderer
 *  itself is locked down (contextIsolation/sandbox/nodeIntegration:false) — defense in depth,
 *  not the primary control. Deliberately narrow to avoid false positives on legitimate local
 *  variable/property names; `module`/`exports` are excluded since ESM output never binds them
 *  and they're common enough as property names to cause noisy false positives. */
const DISALLOWED_GLOBAL_IDENTIFIERS = new Set(['require', 'eval', 'process', '__dirname', '__filename', 'globalThis'])

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * Static AST validator for agent-generated Pawprint source. Runs at create_pawprint/
 * update_pawprint time, before anything is bundled or executed. esbuild's `transform` strips
 * TypeScript types and JSX down to plain JS first (acorn alone can't parse TSX), then acorn
 * parses that output for the actual disallowed-import/disallowed-global walk. This is
 * defense-in-depth: the real security boundary is the sandboxed BrowserWindow (no Node
 * integration, no context bridge beyond the Pawprint SDK, webRequest domain gate) — this catches
 * obviously-hostile or accidentally-unsafe generated code early, with a clear tool-error message
 * instead of a runtime failure inside a window the user just approved.
 */
export async function validatePawprintSource(source: string, approvedPackageNames: string[]): Promise<ValidationResult> {
  const errors: string[] = []

  // Dynamic import — see bundler.ts's identical comment on its own `await import('esbuild')`
  // for why this must not be a static top-level `import { transform } from 'esbuild'` (Bug #10:
  // Rollup hoists a static import of this externalized native-binary package above every other
  // top-level statement in the bundled main-process chunk, including esbuildBinaryPath.ts's
  // env-var fix, defeating it).
  const { transform } = await import('esbuild')
  let compiled: string
  try {
    const result = await transform(source, { loader: 'tsx', jsx: 'automatic', format: 'esm' })
    compiled = result.code
  } catch (e) {
    return { ok: false, errors: [`Source failed to compile: ${e instanceof Error ? e.message : String(e)}`] }
  }

  let ast: acorn.Node
  try {
    ast = acorn.parse(compiled, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch (e) {
    return { ok: false, errors: [`Compiled source failed to parse: ${e instanceof Error ? e.message : String(e)}`] }
  }

  const allowedImports = new Set([...ALWAYS_ALLOWED_IMPORTS, ...approvedPackageNames])

  walkSimple(ast, {
    ImportDeclaration(node: unknown) {
      const source = (node as { source: { value: unknown } }).source.value
      if (typeof source === 'string' && !allowedImports.has(source)) {
        errors.push(
          `Disallowed import "${source}" — only React, the Pawprint SDK, and packages explicitly requested and approved for this Pawprint may be imported.`
        )
      }
    },
    ImportExpression() {
      errors.push('Dynamic import() is not allowed — all imports must be static and statically analyzable.')
    },
    Identifier(node: unknown) {
      const name = (node as { name: string }).name
      if (DISALLOWED_GLOBAL_IDENTIFIERS.has(name)) {
        errors.push(`Disallowed identifier "${name}" — Pawprints cannot access Node/process globals.`)
      }
    }
  })

  return { ok: errors.length === 0, errors: [...new Set(errors)] }
}
