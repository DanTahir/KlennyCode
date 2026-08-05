import type { PawprintThemeTokens } from './theme'

export type PawprintInstanceModel = 'single' | 'per-item'

/** A single npm package the agent has requested and had approved for a Pawprint. */
export interface PawprintPackageRef {
  name: string
  version: string
  /** The npm registry's own published sha512 integrity hash for this exact tarball (not one we
   *  computed ourselves) — stored for future auditability. */
  registrySha512: string
  /** True for a direct request; false for a transitive dependency pulled in to satisfy one. */
  direct: boolean
  approvedAt: number
}

/** Persisted, on-disk shape of `userData/pawprints/<id>/manifest.json`. This is the single
 *  source of truth for what's approved to run for a Pawprint — everything that can affect
 *  executed code, bundled packages, or reachable network domains lives here and is only ever
 *  written via the approval-gated create_pawprint/update_pawprint flow (see writeGuard.ts). */
export interface PawprintManifest {
  id: string
  name: string
  description: string
  instanceModel: PawprintInstanceModel
  createdAt: number
  updatedAt: number
  /** Bumped on every approved update; used as part of the bundle cache key. */
  sourceVersion: number
  packages: PawprintPackageRef[]
  /** Exact, lowercase hostnames approved for network access. Empty = no network access. */
  approvedDomains: string[]
  themeOverride: Partial<PawprintThemeTokens>
}

/** One entry in the cross-Pawprint registry (`pawprints-registry.json`) tracking a live or
 *  previously-open instance for restore-on-relaunch. */
export interface PawprintInstanceRecord {
  pawprintId: string
  instanceId: string
  /** Human label for per-item instances (e.g. an item name); unused for 'single' model. */
  label?: string
  bounds?: { x: number; y: number; width: number; height: number }
  alwaysOnTop: boolean
  /** Whether this instance should be auto-reopened when the app launches. */
  openOnLaunch: boolean
  updatedAt: number
}

export interface PawprintRegistry {
  instances: PawprintInstanceRecord[]
}

/** What `read_pawprint_source` returns to the agent — the approved source plus enough metadata
 *  to let it directly read/edit state files with the generic file tools (v4). */
export interface PawprintSourceResult {
  id: string
  name: string
  description: string
  instanceModel: PawprintInstanceModel
  source: string
  packages: PawprintPackageRef[]
  approvedDomains: string[]
  instances: { instanceId: string; statePath: string; open: boolean }[]
}
