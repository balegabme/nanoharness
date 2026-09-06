// Rasterises the OS icon. Electron is the only rasteriser in this repo, so a
// hidden window draws the SVG into a canvas and hands the pixels back. Run it
// by hand after editing app-icon.svg; the PNGs are committed, so a normal
// build and a normal checkout never need this.
//
//   node_modules/.bin/electron scripts/brand-icons.cjs
//
// CommonJS on purpose: Electron only reaches `ready` for an ES-module entry
// when that entry is the app's `main`, and this script is passed as a path.
const { app, BrowserWindow } = require('electron')
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const brand = join(__dirname, '..', 'docs', 'assets', 'brand')
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

// A file:// page rather than a data: URL: an <img> pointed at a data: URL from
// a data: URL document taints the canvas, and a tainted canvas cannot be read
// back as a PNG.
const draw = `
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = SIZE
      canvas.height = SIZE
      canvas.getContext('2d').drawImage(image, 0, 0, SIZE, SIZE)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('the SVG did not load'))
    image.src = './icon.svg'
  })
`

app.whenReady().then(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'nh-icons-'))
  writeFileSync(join(scratch, 'icon.svg'), readFileSync(join(brand, 'app-icon.svg')))
  writeFileSync(join(scratch, 'icons.html'), '<!doctype html><meta charset="utf-8"><body></body>')

  const window = new BrowserWindow({ show: false })
  await window.loadURL(pathToFileURL(join(scratch, 'icons.html')).toString())

  for (const size of SIZES) {
    const url = await window.webContents.executeJavaScript(draw.replaceAll('SIZE', String(size)))
    writeFileSync(join(brand, 'png', `app-icon-${size}.png`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
  }

  window.destroy()
  app.quit()
})
