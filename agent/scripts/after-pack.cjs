/**
 * electron-builder afterPack hook (wired via package.json `build.afterPack`).
 *
 * node-pty 1.1.0's npm tarball ships its macOS prebuilt `spawn-helper` binary as mode 0644 (no
 * execute bit), and node-pty's postinstall never fixes that. The packaged app inherits the bad
 * mode, so on macOS every terminal-panel spawn failed with "posix_spawnp failed" and the pane
 * stayed blank. This hook restores 0755 on every spawn-helper inside the unpacked node-pty before
 * electron-builder signs and archives the app. src/main/ptySpawnHelper.ts is the runtime
 * fallback for installs made without this hook.
 *
 * No-op for Windows builds (ConPTY, no spawn-helper). A macOS build with no spawn-helper found
 * fails loudly instead of silently shipping a broken terminal.
 *
 * `.cjs` because package.json declares "type": "module".
 */
const fs = require('node:fs')
const path = require('node:path')

function findSpawnHelpers(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findSpawnHelpers(full, out)
    else if (entry.isFile() && entry.name === 'spawn-helper') out.push(full)
  }
  return out
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform === 'win32') return

  const resourcesDir =
    platform === 'darwin' || platform === 'mas'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources')
  const ptyDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty')

  const helpers = fs.existsSync(ptyDir) ? findSpawnHelpers(ptyDir, []) : []
  for (const helper of helpers) {
    fs.chmodSync(helper, 0o755)
    console.log(`  • afterPack: chmod 755 ${path.relative(context.appOutDir, helper)}`)
  }

  if ((platform === 'darwin' || platform === 'mas') && helpers.length === 0) {
    throw new Error(
      `afterPack: no node-pty spawn-helper found under ${ptyDir}; the macOS terminal panel would ship broken (posix_spawnp failed).`
    )
  }
}
