// doc: docs/harness/ui.md
import { BrowserWindow, Menu, net, protocol } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, normalize, sep } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER_DIR = join(HERE, '..', 'renderer')
const PRELOAD = join(HERE, 'preload.mjs')
const ICON = join(HERE, '..', 'assets', 'logo-256.png')

const SCHEME = 'app'
const HOST = 'nanoharness'
const ENTRY = `${SCHEME}://${HOST}/index.html`

// The renderer is served over a registered standard scheme rather than file://,
// which gives the page a real origin. Without one, `default-src 'self'` means
// nothing and ES modules do not load.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

export function serveRenderer(): void {
  protocol.handle(SCHEME, request => {
    const url = new URL(request.url)
    if (url.hostname !== HOST) return new Response('not found', { status: 404 })
    const target = normalize(join(RENDERER_DIR, decodeURIComponent(url.pathname)))
    if (target !== RENDERER_DIR && !target.startsWith(RENDERER_DIR + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

export function createWindow(): BrowserWindow {
  // No File/Edit/View menu. The app has no menu commands, and an empty bar is
  // just chrome; text-editing shortcuts are handled by the renderer itself.
  Menu.setApplicationMenu(null)

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 620,
    minHeight: 420,
    backgroundColor: '#16130f',
    icon: ICON,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // An ESM preload needs this. contextIsolation is what keeps the renderer
      // off Node; revisit once the preload can ship as CommonJS (ledger).
      sandbox: false,
    },
  })

  window.once('ready-to-show', () => window.show())
  // Nothing in this app should ever open a second window or leave the app scheme.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  void window.loadURL(ENTRY)
  return window
}
