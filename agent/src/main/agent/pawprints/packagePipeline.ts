import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import semver from 'semver'
import type { PawprintPackageRef } from './types'

export const MAX_PACKAGE_TOTAL_BYTES = 50 * 1024 * 1024 // 50 MB, per plan section 3/11

const REGISTRY_BASE = 'https://registry.npmjs.org'

export interface PackageRequest {
  name: string
  version: string
}

export interface ResolvedPackage {
  ref: PawprintPackageRef
  /** Absolute path to the extracted package contents (package.json at its root). Caller is
   *  responsible for copying what it needs out of here — this is a temp dir, cleaned up by
   *  cleanupResolvedPackages() once bundling/materialization is done. */
  extractedDir: string
  sizeBytes: number
}

export interface PackagePipelineResult {
  ok: true
  packages: ResolvedPackage[]
  totalBytes: number
}

export interface PackagePipelineError {
  ok: false
  error: string
  offendingPackage?: string
}

type FetchFn = typeof fetch

interface NpmPackument {
  name: string
  versions: Record<
    string,
    {
      version: string
      dist: { tarball: string; integrity?: string; shasum?: string }
      dependencies?: Record<string, string>
      scripts?: Record<string, string>
      gypfile?: boolean
      optionalDependencies?: Record<string, string>
    }
  >
}

const UNSAFE_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare']

function isNativeOrBuildArtifactPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/')
  return (
    p.endsWith('.node') ||
    p.endsWith('binding.gyp') ||
    p.includes('/prebuild/') ||
    p.includes('/prebuild-install/') ||
    /(^|\/)prebuilds?(\/|$)/.test(p)
  )
}

/** Checks a package's manifest for anything that would run code at install time or ship a
 *  native binary — both hard-rejected regardless of what the code inside actually does. */
function findUnsafePackageJsonIssues(pkgJson: NpmPackument['versions'][string]): string[] {
  const issues: string[] = []
  if (pkgJson.scripts) {
    for (const script of UNSAFE_LIFECYCLE_SCRIPTS) {
      if (pkgJson.scripts[script]) issues.push(`declares an install-lifecycle script ("${script}")`)
    }
  }
  if (pkgJson.gypfile) issues.push('declares gypfile:true (native build)')
  if (pkgJson.optionalDependencies) {
    const nativeLooking = Object.keys(pkgJson.optionalDependencies).filter((n) => /-(darwin|linux|win32|android)-|^@.*\/(darwin|linux|win32)-/.test(n))
    if (nativeLooking.length > 0) issues.push(`declares platform-specific native optionalDependencies (${nativeLooking.join(', ')})`)
  }
  return issues
}

async function fetchPackument(name: string, fetchImpl: FetchFn): Promise<NpmPackument> {
  const res = await fetchImpl(`${REGISTRY_BASE}/${encodeURIComponent(name).replace('%40', '@')}`)
  if (!res.ok) throw new Error(`npm registry lookup for "${name}" failed: HTTP ${res.status}`)
  return (await res.json()) as NpmPackument
}

/** Resolves a semver range against a packument's available versions to the highest satisfying
 *  version, or null if none satisfies (used both for a fresh resolution and for re-checking an
 *  already-resolved version against a second, conflicting range — i.e. diamond dependencies). */
function highestSatisfying(packument: NpmPackument, range: string): string | null {
  const versions = Object.keys(packument.versions)
  return semver.maxSatisfying(versions, range)
}

async function downloadAndExtract(
  name: string,
  version: string,
  meta: NpmPackument['versions'][string],
  fetchImpl: FetchFn
): Promise<{ dir: string; sizeBytes: number }> {
  const tarballUrl = meta.dist.tarball
  const res = await fetchImpl(tarballUrl)
  if (!res.ok) throw new Error(`Failed to download tarball for ${name}@${version}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())

  // Integrity: verify against the registry's own published hash, not one we compute ourselves.
  const integrity = meta.dist.integrity
  if (integrity && integrity.startsWith('sha512-')) {
    const expected = integrity.slice('sha512-'.length)
    const actual = createHash('sha512').update(buf).digest('base64')
    if (actual !== expected) {
      throw new Error(`Integrity check failed for ${name}@${version} — tarball does not match the registry-published sha512.`)
    }
  } else if (meta.dist.shasum) {
    const actual = createHash('sha1').update(buf).digest('hex')
    if (actual !== meta.dist.shasum) {
      throw new Error(`Integrity check failed for ${name}@${version} — tarball does not match the registry-published shasum.`)
    }
  } else {
    throw new Error(`No integrity hash published by the registry for ${name}@${version} — refusing to install unverifiable package.`)
  }

  const workDir = await fs.mkdtemp(join(tmpdir(), 'klenny-pawprint-pkg-'))
  const tarballPath = join(workDir, 'package.tgz')
  await fs.writeFile(tarballPath, buf)
  const extractDir = join(workDir, 'extracted')
  await fs.mkdir(extractDir, { recursive: true })
  await tar.extract({ file: tarballPath, cwd: extractDir, strip: 1 })
  await fs.rm(tarballPath, { force: true })

  let sizeBytes = 0
  const nativeHits: string[] = []
  async function walk(dir: string, relBase: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = join(relBase, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
      } else {
        const stat = await fs.stat(abs)
        sizeBytes += stat.size
        if (isNativeOrBuildArtifactPath(rel)) nativeHits.push(rel)
      }
    }
  }
  await walk(extractDir, '')
  if (nativeHits.length > 0) {
    throw new Error(`${name}@${version} contains native/build artifacts (${nativeHits.slice(0, 3).join(', ')}) — native bindings are not allowed.`)
  }

  return { dir: extractDir, sizeBytes }
}

/**
 * Resolves a set of directly-requested packages plus their transitive dependency trees (one
 * level of `dependencies` at a time, recursively — never `devDependencies`/`optionalDependencies`)
 * against the real npm registry, verifying integrity and rejecting anything native/lifecycle-
 * script-bearing along the way, and enforcing a cumulative extracted-size cap. `fetchImpl` is
 * injectable so pipeline logic can be unit-tested without real network access.
 */
export async function resolvePackages(requests: PackageRequest[], fetchImpl: FetchFn = fetch): Promise<PackagePipelineResult | PackagePipelineError> {
  const now = Date.now()
  // name -> set of semver ranges that must all be satisfied (diamond-dependency tracking)
  const rangesByName = new Map<string, Set<string>>()
  const resolvedVersionByName = new Map<string, string>()
  const resolved = new Map<string, ResolvedPackage>()
  let totalBytes = 0

  type QueueItem = { name: string; range: string; direct: boolean }
  const queue: QueueItem[] = requests.map((r) => ({ name: r.name, range: r.version, direct: true }))
  const seenEdges = new Set<string>()

  while (queue.length > 0) {
    const item = queue.shift()!
    const edgeKey = `${item.name}@${item.range}`
    if (seenEdges.has(edgeKey)) continue
    seenEdges.add(edgeKey)

    if (!rangesByName.has(item.name)) rangesByName.set(item.name, new Set())
    rangesByName.get(item.name)!.add(item.range)

    let packument: NpmPackument
    try {
      packument = await fetchPackument(item.name, fetchImpl)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), offendingPackage: item.name }
    }

    const alreadyResolved = resolvedVersionByName.get(item.name)
    let version: string
    if (alreadyResolved) {
      // Diamond dependency: the already-chosen version must also satisfy this new range.
      if (semver.satisfies(alreadyResolved, item.range)) {
        version = alreadyResolved
      } else {
        // Try to find one version satisfying every range seen so far for this package.
        const allRanges = [...rangesByName.get(item.name)!]
        const combined = allRanges.join(' ')
        const candidate = highestSatisfying(packument, combined)
        if (!candidate) {
          return {
            ok: false,
            error: `Diamond dependency conflict for "${item.name}": no version satisfies all requested ranges (${allRanges.join(', ')}).`,
            offendingPackage: item.name
          }
        }
        version = candidate
      }
    } else {
      const candidate = highestSatisfying(packument, item.range)
      if (!candidate) {
        return { ok: false, error: `No version of "${item.name}" satisfies requested range "${item.range}".`, offendingPackage: item.name }
      }
      version = candidate
    }
    resolvedVersionByName.set(item.name, version)

    const meta = packument.versions[version]
    if (!meta) {
      return { ok: false, error: `Version ${version} of "${item.name}" is missing from registry metadata.`, offendingPackage: item.name }
    }

    const issues = findUnsafePackageJsonIssues(meta)
    if (issues.length > 0) {
      return { ok: false, error: `"${item.name}@${version}" is not allowed: ${issues.join('; ')}.`, offendingPackage: item.name }
    }

    let extraction: { dir: string; sizeBytes: number }
    try {
      extraction = await downloadAndExtract(item.name, version, meta, fetchImpl)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), offendingPackage: item.name }
    }

    totalBytes += extraction.sizeBytes
    if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
      return {
        ok: false,
        error: `Cumulative extracted package size (${Math.round(totalBytes / 1024 / 1024)} MB) exceeds the ${MAX_PACKAGE_TOTAL_BYTES / 1024 / 1024} MB cap.`,
        offendingPackage: item.name
      }
    }

    resolved.set(item.name, {
      ref: {
        name: item.name,
        version,
        registrySha512: meta.dist.integrity ?? `sha1-${meta.dist.shasum ?? ''}`,
        direct: item.direct,
        approvedAt: now
      },
      extractedDir: extraction.dir,
      sizeBytes: extraction.sizeBytes
    })

    for (const [depName, depRange] of Object.entries(meta.dependencies ?? {})) {
      queue.push({ name: depName, range: depRange, direct: false })
    }
  }

  return { ok: true, packages: [...resolved.values()], totalBytes }
}

/** Best-effort cleanup of the temp extraction dirs created during resolvePackages(). Safe to
 *  call even if some/all packages have already been materialized elsewhere (copy, not move). */
export async function cleanupResolvedPackages(packages: ResolvedPackage[]): Promise<void> {
  for (const pkg of packages) {
    // extractedDir is <tmp>/<random>/extracted — remove the whole random temp parent.
    const parent = join(pkg.extractedDir, '..')
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Copies every resolved package's extracted contents into `nodeModulesDir` (one subdirectory
 * per package name, `@scope/name` handled as two path segments) so esbuild can actually resolve
 * a bare `import` of it at bundle time. This was the missing link between resolvePackages()
 * (which only ever wrote to a temp dir, later deleted by cleanupResolvedPackages()) and
 * bundler.ts (which points esbuild's resolution at `nodeModulesDir` but had nothing to find
 * there) — previously every approved extra package silently never made it to disk, so any
 * Pawprint importing one failed at build time with "Could not resolve".
 *
 * Wipes `nodeModulesDir` first so a package removed from a later `update_pawprint` call (or one
 * whose resolved version changed) doesn't leave a stale copy behind; call this BEFORE
 * cleanupResolvedPackages() so the temp extraction dirs still exist to copy from.
 */
export async function materializePackages(packages: ResolvedPackage[], nodeModulesDir: string): Promise<void> {
  await fs.rm(nodeModulesDir, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(nodeModulesDir, { recursive: true })
  for (const pkg of packages) {
    const destDir = join(nodeModulesDir, ...pkg.ref.name.split('/'))
    await fs.mkdir(join(destDir, '..'), { recursive: true })
    await fs.cp(pkg.extractedDir, destDir, { recursive: true })
  }
}
