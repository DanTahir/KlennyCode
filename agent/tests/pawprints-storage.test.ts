import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import './testElectronMock'
import { electronMockState } from './testElectronMock'

const storage = await import('../src/main/agent/pawprints/storage')
const { pawprintManifestPath, pawprintsRegistryPath, pawprintStatePath } = await import('../src/main/agent/pawprints/paths')
import type { PawprintManifest, PawprintRegistry } from '../src/main/agent/pawprints/types'

function makeManifest(id: string): PawprintManifest {
  const now = Date.now()
  return {
    id,
    name: 'Sticky Notes',
    description: 'A test Pawprint',
    instanceModel: 'single',
    createdAt: now,
    updatedAt: now,
    sourceVersion: 1,
    packages: [{ name: 'date-fns', version: '3.6.0', registrySha512: 'abc123', direct: true, approvedAt: now }],
    approvedDomains: ['api.weather.example.com'],
    themeOverride: { accent: '#ff0000' }
  }
}

describe('pawprints storage — manifest/registry/source/state roundtrip', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pawprints-storage-test-'))
    electronMockState.userDataDir = dir
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  test('writeManifest + readManifest roundtrips exactly, including nested packages/theme fields', async () => {
    const manifest = makeManifest('sticky-notes')
    await storage.writeManifest(manifest)
    const read = await storage.readManifest('sticky-notes')
    expect(read).toEqual(manifest)
  })

  test('readManifest returns null for a Pawprint that was never written', async () => {
    const read = await storage.readManifest('never-existed')
    expect(read).toBeNull()
  })

  test('writeManifest is atomic: leaves no leftover .tmp-* file after completion', async () => {
    const manifest = makeManifest('atomic-check')
    await storage.writeManifest(manifest)
    const entries = await fs.readdir(join(dir, 'pawprints', 'atomic-check'))
    expect(entries.some((f) => f.includes('.tmp-'))).toBe(false)
    expect(entries).toContain('manifest.json')
  })

  test('writeManifest keeps a rolling .bak of the previous manifest on a second write', async () => {
    const manifest = makeManifest('bak-check')
    await storage.writeManifest(manifest)
    const updated = { ...manifest, updatedAt: Date.now() + 1000, sourceVersion: 2 }
    await storage.writeManifest(updated)

    const bakPath = `${pawprintManifestPath('bak-check')}.bak`
    const bakContent = JSON.parse(await fs.readFile(bakPath, 'utf8'))
    expect(bakContent.sourceVersion).toBe(1) // the previous version, before the second write
    const current = await storage.readManifest('bak-check')
    expect(current?.sourceVersion).toBe(2)
  })

  test('writeSource + readSource roundtrips the raw TSX text exactly', async () => {
    const src = 'export default function App() { return null }\n// unicode: 🐾'
    await storage.writeSource('my-app', src)
    const read = await storage.readSource('my-app')
    expect(read).toBe(src)
  })

  test('readSource returns null when no source file exists yet', async () => {
    const read = await storage.readSource('no-source-yet')
    expect(read).toBeNull()
  })

  test('listPawprintIds reflects only directories actually written, and is empty when none exist', async () => {
    expect(await storage.listPawprintIds()).toEqual([])
    await storage.writeManifest(makeManifest('alpha'))
    await storage.writeManifest(makeManifest('beta'))
    const ids = (await storage.listPawprintIds()).sort()
    expect(ids).toEqual(['alpha', 'beta'])
  })

  test('deletePawprint removes the entire per-Pawprint directory tree', async () => {
    await storage.writeManifest(makeManifest('to-delete'))
    await storage.writeSource('to-delete', 'export default function App() { return null }')
    expect(await storage.readManifest('to-delete')).not.toBeNull()

    await storage.deletePawprint('to-delete')
    expect(await storage.readManifest('to-delete')).toBeNull()
    expect(await storage.readSource('to-delete')).toBeNull()
  })

  test('writeStateFromMainProcess + readState roundtrips a state blob and listStateInstanceIds finds it', async () => {
    const data = { notes: ['buy treats', 'walk the corgi'] }
    await storage.writeStateFromMainProcess('sticky-notes', 'instance-1', data)
    const read = await storage.readState('sticky-notes', 'instance-1')
    expect(read).toEqual(data)
    const ids = await storage.listStateInstanceIds('sticky-notes')
    expect(ids).toEqual(['instance-1'])
  })

  test('readState returns null for a nonexistent instance', async () => {
    const read = await storage.readState('sticky-notes', 'does-not-exist')
    expect(read).toBeNull()
  })

  test('readRegistry returns an empty instances array when no registry file exists yet', async () => {
    const reg = await storage.readRegistry()
    expect(reg).toEqual({ instances: [] })
  })

  test('writeRegistry + readRegistry roundtrips instance records including bounds/alwaysOnTop/openOnLaunch', async () => {
    const registry: PawprintRegistry = {
      instances: [
        {
          pawprintId: 'sticky-notes',
          instanceId: 'instance-1',
          label: 'My Notes',
          bounds: { x: 10, y: 20, width: 400, height: 300 },
          alwaysOnTop: true,
          openOnLaunch: true,
          updatedAt: Date.now()
        }
      ]
    }
    await storage.writeRegistry(registry)
    const read = await storage.readRegistry()
    expect(read).toEqual(registry)
  })

  test('writeRegistry is atomic: no leftover .tmp-* file at the userData root after completion', async () => {
    await storage.writeRegistry({ instances: [] })
    const entries = await fs.readdir(dir)
    expect(entries.some((f) => f.includes('pawprints-registry.json.tmp-'))).toBe(false)
    expect(entries).toContain('pawprints-registry.json')
  })

  test('pawprintStatePath from paths.ts matches where writeStateFromMainProcess actually writes', async () => {
    await storage.writeStateFromMainProcess('sticky-notes', 'instance-9', { ok: true })
    const expectedPath = pawprintStatePath('sticky-notes', 'instance-9')
    const raw = await fs.readFile(expectedPath, 'utf8')
    expect(JSON.parse(raw)).toEqual({ ok: true })
  })

  test('pawprintsRegistryPath from paths.ts matches where writeRegistry actually writes', async () => {
    await storage.writeRegistry({ instances: [] })
    const raw = await fs.readFile(pawprintsRegistryPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual({ instances: [] })
  })
})
