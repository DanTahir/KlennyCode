import { nanoid } from 'nanoid'
import type { ToolResultPayload } from '@shared/types'
import { validatePawprintSource } from './validator'
import { validateDomainList } from './domains'
import {
  resolvePackages,
  cleanupResolvedPackages,
  materializePackages,
  MAX_PACKAGE_TOTAL_BYTES,
  type PackageRequest,
  type ResolvedPackage
} from './packagePipeline'
import { bundlePawprint, clearBundleCache } from './bundler'
import {
  readManifest,
  writeManifest,
  writeSource,
  readSource,
  deletePawprint as deletePawprintStorage,
  listPawprintIds,
  listStateInstanceIds
} from './storage'
import { pawprintStatePath, pawprintNodeModulesDir } from './paths'
import type { PawprintManifest, PawprintPackageRef, PawprintSourceResult } from './types'
import { openPawprintWindow, closePawprintWindow, reopenAllOnLaunch, closeAllPawprintWindows } from './windowManager'

export interface CreatePawprintArgs {
  name: string
  description: string
  instanceModel: 'single' | 'per-item'
  source: string
  packages?: { name: string; version: string }[]
  domains?: string[]
}

export interface UpdatePawprintArgs {
  pawprintId: string
  source: string
  packages?: { name: string; version: string }[]
  domains?: string[]
}

/** Slugifies a Pawprint name into a stable-ish id; collisions get a short random suffix. Not
 *  security-relevant (ids are just directory names under our own userData tree). */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.length > 0 ? base : 'pawprint'
}

async function resolveAndValidate(
  source: string,
  requestedPackages: { name: string; version: string }[],
  requestedDomains: string[]
): Promise<{ ok: true; packageRefs: PawprintPackageRef[]; domains: string[]; resolvedPackages: ResolvedPackage[] } | ToolResultPayload> {
  const domainCheck = validateDomainList(requestedDomains)
  if (!domainCheck.ok) return { ok: false, summary: domainCheck.error, error: 'invalid_domain' }

  let packageRefs: PawprintPackageRef[] = []
  let resolvedPackages: ResolvedPackage[] = []
  if (requestedPackages.length > 0) {
    const requests: PackageRequest[] = requestedPackages.map((p) => ({ name: p.name, version: p.version }))
    const result = await resolvePackages(requests)
    if (!result.ok) {
      return { ok: false, summary: result.error, error: 'package_pipeline_failed', data: { offendingPackage: result.offendingPackage } }
    }
    packageRefs = result.packages.map((p) => p.ref)
    resolvedPackages = result.packages
  }

  // Validate AFTER resolving packages so the validator knows the real approved package names.
  const validation = await validatePawprintSource(source, packageRefs.map((p) => p.name))
  if (!validation.ok) {
    await cleanupResolvedPackages(resolvedPackages).catch(() => {})
    return { ok: false, summary: `Source validation failed: ${validation.errors.join('; ')}`, error: 'validation_failed' }
  }

  return { ok: true, packageRefs, domains: domainCheck.hostnames, resolvedPackages }
}

/** Actually executes an already-approved create_pawprint call (called post-approval by
 *  dispatchTool in loop.ts — the approval preview above runs the same validation dry-run-style
 *  via previewPawprintApproval() but does not write anything to disk). */
export async function createPawprint(args: CreatePawprintArgs): Promise<ToolResultPayload> {
  const resolved = await resolveAndValidate(args.source, args.packages ?? [], args.domains ?? [])
  if (!('packageRefs' in resolved)) return resolved

  const existingIds = new Set(await listPawprintIds())
  let id = slugify(args.name)
  if (existingIds.has(id)) id = `${id}-${nanoid(6)}`

  const now = Date.now()
  const manifest: PawprintManifest = {
    id,
    name: args.name,
    description: args.description,
    instanceModel: args.instanceModel,
    createdAt: now,
    updatedAt: now,
    sourceVersion: 1,
    packages: resolved.packageRefs,
    approvedDomains: resolved.domains,
    themeOverride: {}
  }

  await writeSource(id, args.source)
  await writeManifest(manifest)
  await materializePackages(resolved.resolvedPackages, pawprintNodeModulesDir(id))
  await cleanupResolvedPackages(resolved.resolvedPackages).catch(() => {})

  return { ok: true, summary: `Created Pawprint "${args.name}" (${id})`, data: { id, name: args.name } }
}

export async function updatePawprint(args: UpdatePawprintArgs): Promise<ToolResultPayload> {
  const existing = await readManifest(args.pawprintId)
  if (!existing) return { ok: false, summary: `No Pawprint found with id "${args.pawprintId}"`, error: 'not_found' }

  const resolved = await resolveAndValidate(args.source, args.packages ?? [], args.domains ?? [])
  if (!('packageRefs' in resolved)) return resolved

  const updated: PawprintManifest = {
    ...existing,
    updatedAt: Date.now(),
    sourceVersion: existing.sourceVersion + 1,
    packages: resolved.packageRefs,
    approvedDomains: resolved.domains
  }

  await writeSource(args.pawprintId, args.source)
  await writeManifest(updated)
  await materializePackages(resolved.resolvedPackages, pawprintNodeModulesDir(args.pawprintId))
  await cleanupResolvedPackages(resolved.resolvedPackages).catch(() => {})
  clearBundleCache(args.pawprintId)

  return { ok: true, summary: `Updated Pawprint "${existing.name}" (${args.pawprintId})`, data: { id: args.pawprintId } }
}

/** Read-only — extended per v4 with the `instances` field so the agent can discover state file
 *  paths for the generic file tools without a dedicated read/write-state tool. */
export async function readPawprintSource(pawprintId: string): Promise<ToolResultPayload> {
  const manifest = await readManifest(pawprintId)
  if (!manifest) return { ok: false, summary: `No Pawprint found with id "${pawprintId}"`, error: 'not_found' }
  const source = await readSource(pawprintId)
  if (source === null) return { ok: false, summary: `Pawprint "${pawprintId}" has no source file on disk.`, error: 'not_found' }

  const openInstanceIds = new Set(getOpenInstanceIds(pawprintId))
  const stateInstanceIds = new Set(await listStateInstanceIds(pawprintId))
  for (const id of openInstanceIds) stateInstanceIds.add(id)

  const result: PawprintSourceResult = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    instanceModel: manifest.instanceModel,
    source,
    packages: manifest.packages,
    approvedDomains: manifest.approvedDomains,
    instances: [...stateInstanceIds].map((instanceId) => ({
      instanceId,
      statePath: pawprintStatePath(pawprintId, instanceId),
      open: openInstanceIds.has(instanceId)
    }))
  }
  return { ok: true, summary: `Read source for Pawprint "${manifest.name}"`, data: result }
}

export async function listPawprintManifests(): Promise<PawprintManifest[]> {
  const ids = await listPawprintIds()
  const manifests = await Promise.all(ids.map((id) => readManifest(id)))
  return manifests.filter((m): m is PawprintManifest => m !== null)
}

export async function deletePawprintById(pawprintId: string): Promise<void> {
  closeAllInstancesFor(pawprintId)
  clearBundleCache(pawprintId)
  await deletePawprintStorage(pawprintId)
}

// Re-exported window-manager passthroughs kept here so IPC handlers/tool dispatch only need to
// import from this one manager module, not reach into windowManager.ts directly.
export { openPawprintWindow, closePawprintWindow, reopenAllOnLaunch, closeAllPawprintWindows, setAlwaysOnTop }
export { bundlePawprint }
export { MAX_PACKAGE_TOTAL_BYTES }

// Local helpers that need windowManager's live-instance bookkeeping without a circular import
// at module-eval time (windowManager imports storage/manifest helpers from here indirectly via
// paths/storage, not from manager.ts, so this stays acyclic).
import { getOpenInstanceIds, closeAllInstancesFor, setAlwaysOnTop } from './windowManager'
