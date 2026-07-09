import { app } from 'electron'
import { existsSync } from 'node:fs'
import { rgPath } from '@vscode/ripgrep'

/** Native binaries cannot be spawned from inside app.asar; use the unpacked copy. */
export function getRgPath(): string {
  if (!app.isPackaged) return rgPath

  const unpacked = rgPath.replace(/app\.asar([/\\])/g, 'app.asar.unpacked$1')
  if (existsSync(unpacked)) return unpacked

  if (existsSync(rgPath)) return rgPath

  throw new Error(`ripgrep binary not found (looked for ${unpacked})`)
}
