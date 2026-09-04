# Desktop UI

The renderer draws events and nothing else. Every fact on screen arrives as an
`AppEvent` over the typed IPC channels; the renderer holds no harness state of
its own, which is why the window can be rebuilt without touching the core.

Files:
- src/main/window.ts — BrowserWindow, the `app://` scheme, navigation lockdown
- src/main/preload.ts — the context bridge: ping, send, config, saveConfig, probeProvider, onEvent
- src/renderer/index.ts — chat stream, composer, provider settings, event rendering

`src/renderer/index.html` and `src/renderer/renderer.css` ship alongside and are
copied into `out/` by `scripts/copy-assets.mjs`.

## What is built

This is the first UI slice (plan §18 step 5, first half). It gives a window you
can type into and watch a turn run: user blocks, streamed assistant text, a
collapsible thinking block, tool cards that show arguments while running and
output when they finish, a per-turn usage line with the cache hit rate, and
errors. Enter sends, Shift+Enter makes a newline, and the composer locks while a
turn is in flight.

The window has no menu bar. There are no menu commands to put in one, and the
renderer handles its own text editing, so the File/Edit/View strip would have
been decoration. The brand mark sits in the header instead, and the same mark is
the window icon.

On first run there is nothing to type into yet: the composer is replaced by a
setup screen asking for a base URL and an API key, because neither has a default
(see `providers.md`). **Test connection** and **Fetch models** both call
`GET /v1/models` through `config:probe`; the first reports reachability, the
second lists what the server offers as a set of checkboxes. Ticking is the
point: only ticked models can become the active model, so a provider's full
catalogue never leaks into the picker. A server without a model list says so,
and the active model stays a text field.

The **settings** chip in the header reopens the same panel at any time, titled
`Provider settings`, with a Cancel that restores the last saved state. The panel
also comes back on its own if the configuration later breaks — a cleared
variable, a key that no longer decrypts — rather than failing every turn with
the same opaque error.

Still to come with the rest of step 5: the design-token pass, command palette,
keyboard map, snippet picker and composer chips, settings, the diff view, and
the permission modal. Plan §13 has the full list.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, no remote content. The
  renderer sees three functions on `window.nanoharness` and never `ipcRenderer`.
- The page is served over a registered `app://` scheme rather than `file://`.
  A file URL has an opaque origin, which makes `default-src 'self'` meaningless
  and blocks ES modules; the custom scheme gives the page a real origin. The
  handler refuses any path that escapes `out/renderer`.
- `setWindowOpenHandler` denies every new window and `will-navigate` is
  cancelled, so the renderer cannot leave the app scheme.
- `sandbox: false` is the one concession: Electron only loads an ES-module
  preload that way. Context isolation is the boundary that matters here, but
  shipping the preload as CommonJS and turning the sandbox back on is in the
  ledger.

## Session model

One `Session` per window, created on the first message and reused after, so a
conversation keeps its history. The window's `WebContents` id is the key and the
session is dropped when the window goes away.

## Tokens

`renderer.css` carries a provisional set: warm-gray dark ground, one
terracotta accent, mono for the transcript and sans for chrome, a 4px spacing
scale. The real token set arrives with the design pass and belongs in this file
per plan §13.
