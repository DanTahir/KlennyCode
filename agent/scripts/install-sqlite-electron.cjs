/**
 * postinstall: replace better-sqlite3's host-Node native binary with the Electron-ABI prebuild.
 *
 * better-sqlite3 12.x is a V8-ABI (not N-API) addon, so the binary its own install script fetches
 * for the host Node (e.g. Node 22/24, ABI 127/137) hard-crashes / refuses to load inside
 * Electron 33 (Node 20.18, ABI 130). 13.x switched to N-API but builds with NAPI_VERSION=10,
 * which Electron 33's Node (N-API 9) doesn't provide — `new Database()` kills the process with a
 * fatal N-API error. So we pin 12.x and download its official `electron-v<abi>` prebuild here.
 *
 * Consequences:
 *  - Only Electron can load node_modules/better-sqlite3 after this runs. Bun tests never use it:
 *    codeindex/sqliteDriver.ts picks `bun:sqlite` under Bun (Bun also can't load better-sqlite3).
 *  - `package.json` has `npmRebuild: false` (for node-pty), so electron-builder will NOT rebuild
 *    it for us — this script is the only thing that makes the packaged binary correct.
 *
 * Fails the install under CI (a packaged app with the wrong ABI would ship a broken code index);
 * only warns on dev machines so an offline `bun install` still completes.
 *
 * `.cjs` because package.json declares "type": "module".
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

function main() {
  if (process.env.KLENNY_SKIP_SQLITE_ELECTRON === '1') {
    console.log('[install-sqlite-electron] skipped (KLENNY_SKIP_SQLITE_ELECTRON=1)')
    return
  }
  const root = path.resolve(__dirname, '..')
  const sqliteDir = path.join(root, 'node_modules', 'better-sqlite3')
  const electronPkg = path.join(root, 'node_modules', 'electron', 'package.json')
  const prebuildBin = path.join(root, 'node_modules', 'prebuild-install', 'bin.js')
  for (const p of [sqliteDir, electronPkg, prebuildBin]) {
    if (!fs.existsSync(p)) throw new Error(`missing ${p}`)
  }
  const electronVersion = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version
  const arch = process.env.npm_config_arch || process.arch
  const platform = process.env.npm_config_platform || process.platform
  console.log(`[install-sqlite-electron] fetching better-sqlite3 prebuild for electron ${electronVersion} ${platform}-${arch}`)
  execFileSync(
    process.execPath,
    [prebuildBin, '--runtime', 'electron', '--target', electronVersion, '--arch', arch, '--platform', platform, '--force'],
    { cwd: sqliteDir, stdio: 'inherit' }
  )
  const binary = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node')
  if (!fs.existsSync(binary)) throw new Error(`prebuild-install finished but ${binary} does not exist`)
  console.log('[install-sqlite-electron] ok')
}

try {
  main()
} catch (e) {
  const msg = `[install-sqlite-electron] FAILED: ${e && e.message ? e.message : e}`
  if (process.env.CI) {
    console.error(msg)
    process.exit(1)
  }
  console.warn(`${msg}\n  The codebase index will be unavailable in \`bun run dev\` until this succeeds (re-run: node scripts/install-sqlite-electron.cjs).`)
}
