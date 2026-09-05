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

// The brand marks live with the docs, but the window needs an icon and the
// renderer needs marks it can load over the app:// scheme. Two of them: the
// full logo carries the three window dots, which turn to mush below about
// 48px, so anything small in the UI gets the dot-free mark instead.
const brand = join(root, 'docs', 'assets', 'brand')
await mkdir(join(root, 'out', 'assets'), { recursive: true })
await copyFile(join(brand, 'logo.svg'), join(to, 'logo.svg'))
await copyFile(join(brand, 'favicon.svg'), join(to, 'mark.svg'))
await copyFile(join(brand, 'png', 'logo-256.png'), join(root, 'out', 'assets', 'logo-256.png'))

await copyFile(join(root, 'out', 'main', 'preload.js'), join(root, 'out', 'main', 'preload.mjs'))
console.log(`copied ${assets.length} renderer assets, the brand marks and the preload`)
