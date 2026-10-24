import { createRequire } from 'node:module'

/**
 * Minimal SQLite driver adapter for the codebase index.
 *
 * Two runtimes have to be supported, and neither driver works in both:
 *   - Electron (the app): `better-sqlite3`, rebuilt against Electron's V8 ABI by
 *     scripts/install-sqlite-electron.cjs. Electron 33 ships Node 20, so `node:sqlite` is not
 *     available.
 *   - Bun (the test suite): Bun cannot load `better-sqlite3`'s native addon (it crashes), but
 *     ships `bun:sqlite`, which can load the same sqlite-vec extension.
 *
 * The driver is chosen at runtime through `createRequire` so the bundler never tries to resolve
 * `bun:sqlite` in the Electron build. Both drivers expose a near-identical synchronous API; this
 * adapter normalises the small differences (`exec` vs `run`, `null` vs `undefined` for a missing
 * row) behind one interface.
 */
const nodeRequire = createRequire(import.meta.url)

export interface SqliteStatement {
  run(...params: unknown[]): unknown
  /** Returns the first row, or undefined when there is none (normalised across drivers). */
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabase {
  /** Executes ONE statement with no parameters (bun's `run` is not guaranteed to accept several). */
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  /** Runs `fn` inside a single transaction (COMMIT on return, ROLLBACK on throw). */
  transaction<T>(fn: () => T): T
  close(): void
}

interface RawStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface RawDatabase {
  prepare(sql: string): RawStatement
  transaction<T>(fn: () => T): () => T
  loadExtension(path: string): void
  close(): void
}

export function isBunRuntime(): boolean {
  return typeof (process.versions as Record<string, string | undefined>).bun === 'string'
}

/**
 * sqlite's loader calls the OS dynamic linker directly, which cannot read inside an asar archive.
 * electron-builder unpacks the sqlite-vec platform package (see `asarUnpack` in package.json), so
 * the path must be redirected to the `app.asar.unpacked` copy. A no-op outside a packaged build.
 */
export function toUnpackedPath(p: string): string {
  return p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')
}

export function resolveVecExtensionPath(): string {
  const sqliteVec = nodeRequire('sqlite-vec') as { getLoadablePath(): string }
  return toUnpackedPath(sqliteVec.getLoadablePath())
}

function wrap(db: RawDatabase, execOne: (sql: string) => void): SqliteDatabase {
  return {
    exec: execOne,
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        run: (...params) => stmt.run(...params),
        get: (...params) => stmt.get(...params) ?? undefined,
        all: (...params) => stmt.all(...params)
      }
    },
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close()
  }
}

/** Opens (creating if needed) a SQLite database with the sqlite-vec extension loaded. */
export function openVecDatabase(path: string): SqliteDatabase {
  const extensionPath = resolveVecExtensionPath()
  if (isBunRuntime()) {
    const { Database } = nodeRequire('bun:sqlite') as {
      Database: new (p: string, o?: { create?: boolean }) => RawDatabase & { run(sql: string): unknown }
    }
    const db = new Database(path, { create: true })
    db.loadExtension(extensionPath)
    return wrap(db, (sql) => void db.run(sql))
  }
  const Database = nodeRequire('better-sqlite3') as new (p: string) => RawDatabase & { exec(sql: string): unknown }
  const db = new Database(path)
  db.loadExtension(extensionPath)
  return wrap(db, (sql) => void db.exec(sql))
}
