// doc: docs/harness/ui.md
import { BrowserWindow, Menu, net, protocol } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, normalize, sep } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER_DIR = join(HERE, '..', 'renderer')
const PRELOAD = join(HERE, 'preload.mjs')
const ICON = join(HERE, '..', 'assets', 'app-icon-256.png')

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

  reportFailures(window)
  window.once('ready-to-show', () => window.show())
  // Nothing in this app should ever open a second window or leave the app scheme.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  void window.loadURL(ENTRY)
  return window
}

/**
 * A renderer module that throws on load leaves a window that looks fine and
 * says nothing. There is no console to read in a packaged build, so the window
 * itself has to admit it: a failed load or an uncaught renderer error is
 * printed to the main process log and painted over the page.
 */
function reportFailures(window: BrowserWindow): void {
  const show = (title: string, detail: string): void => {
    console.error(`renderer: ${title}: ${detail}`)
    const banner = `
      (() => {
        let box = document.getElementById('nh-crash')
        if (!box) {
          box = document.createElement('pre')
          box.id = 'nh-crash'
          box.setAttribute('style', [
            'position:fixed;inset:auto 16px 16px 16px;z-index:999;margin:0',
            'padding:12px 14px;max-height:40vh;overflow:auto;white-space:pre-wrap',
            'font:400 12px/1.55 var(--nh-font-mono,ui-monospace,monospace)',
            'color:var(--nh-label-primary,#f4ece2)',
            'background:var(--nh-bg-layer-2,#221d17)',
            'border:1px solid var(--nh-border-l2,rgb(255 255 255 / 10%))',
            'border-left:3px solid var(--nh-state-error,#e2725b)',
            'border-radius:var(--nh-radius-card,12px)',
            'box-shadow:var(--nh-shadow-lv3,0 18px 48px rgb(0 0 0 / 46%))',
          ].join(';'))
          document.body.append(box)
        }
        box.textContent += ${JSON.stringify(`${title}: ${detail}
`)}
      })()
    `
    window.webContents.executeJavaScript(banner).catch(() => undefined)
  }

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    show('load failed', `${description} (${code}) ${url}`)
  })
  window.webContents.on('preload-error', (_event, path, error) => {
    show('preload failed', `${path}: ${error.message}`)
  })
  window.webContents.on('console-message', details => {
    if (details.level !== 'error') return
    show('console', `${details.message} (${details.sourceId}:${details.lineNumber})`)
  })
}
