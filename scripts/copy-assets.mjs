// Static renderer assets are not TypeScript, so tsc never sees them. The
// preload is copied to .mjs because Electron only loads an ES-module preload
// under that extension.
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'src', 'renderer')
const to = join(root, 'out', 'renderer')

await mkdir(to, { recursive: true })
const assets = (await readdir(from)).filter(name => !name.endsWith('.ts'))
for (const name of assets) await copyFile(join(from, name), join(to, name))

await copyFile(join(root, 'out', 'main', 'preload.js'), join(root, 'out', 'main', 'preload.mjs'))
console.log(`copied ${assets.length} renderer assets and the preload`)
