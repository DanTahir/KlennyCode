import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, '..', 'Klenny.jpg')
const outDir = join(root, 'build', 'icons')

await mkdir(outDir, { recursive: true })

const img = sharp(src).resize(512, 512, { fit: 'cover' })
await img.png().toFile(join(outDir, 'icon.png'))

// ICO: electron-builder can also use png on windows, but we generate multi-size png
await sharp(src).resize(256, 256).png().toFile(join(outDir, 'icon.ico.png'))
console.log('Generated build/icons/icon.png (use png for all platforms; electron-builder converts)')
