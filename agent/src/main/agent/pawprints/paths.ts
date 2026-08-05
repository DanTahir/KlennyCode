import { app } from 'electron'
import { join } from 'node:path'

/**
 * Root directory for all Pawprint data — `userData/pawprints/`. Each Pawprint gets its own
 * subdirectory keyed by its id (see pawprintDir()).
 */
export function pawprintsRootDir(): string {
  return join(app.getPath('userData'), 'pawprints')
}

/** Root directory for a single Pawprint: `userData/pawprints/<id>/`. */
export function pawprintDir(id: string): string {
  return join(pawprintsRootDir(), id)
}

/** `userData/pawprints/<id>/manifest.json` */
export function pawprintManifestPath(id: string): string {
  return join(pawprintDir(id), 'manifest.json')
}

/** `userData/pawprints/<id>/source/` — holds the approved App.tsx (and nothing else for v1). */
export function pawprintSourceDir(id: string): string {
  return join(pawprintDir(id), 'source')
}

export function pawprintSourceFile(id: string): string {
  return join(pawprintSourceDir(id), 'App.tsx')
}

/** `userData/pawprints/<id>/state/<instanceId>.json` — one JSON blob per instance. */
export function pawprintStateDir(id: string): string {
  return join(pawprintDir(id), 'state')
}

export function pawprintStatePath(id: string, instanceId: string): string {
  return join(pawprintStateDir(id), `${instanceId}.json`)
}

/** `userData/pawprints/<id>/node_modules/` — materialized, approved extra packages only. */
export function pawprintNodeModulesDir(id: string): string {
  return join(pawprintDir(id), 'node_modules')
}

/** Cross-Pawprint registry of instances/window bounds — `userData/pawprints-registry.json`. */
export function pawprintsRegistryPath(): string {
  return join(app.getPath('userData'), 'pawprints-registry.json')
}
