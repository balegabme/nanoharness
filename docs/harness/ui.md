# Desktop UI

The renderer draws events and nothing else. Every fact on screen arrives as an
`AppEvent` over the typed IPC channels; the renderer holds no harness state of
its own, which is why the window can be rebuilt without touching the core.

Files:
- src/main/window.ts — BrowserWindow, the `app://` scheme, navigation lockdown
- src/main/preload.ts — the context bridge: ping, send, workspaces, sessions, config, permission answers, onEvent
- src/renderer/index.ts — the shell: which session is open, composer, model and effort chips
- src/renderer/sidebar.ts — folders and their sessions, search, add and delete
- src/renderer/chat.ts — the message flow: streamed text, thinking, tool rows, replayed transcripts
- src/renderer/settings.ts — the settings sheet: provider list, form, probe, model ticking
- src/renderer/permission.ts — the modal a tool waits on when it reaches outside its folder
- src/renderer/dom.ts — the small DOM helpers the rest share

`src/renderer/index.html` and `src/renderer/renderer.css` ship alongside and are
copied into `out/` by `scripts/copy-assets.mjs`.

## Layout

Two columns. The sidebar is the session list; the rest of the window is one
session at a time.

```
+- sidebar ----------+- session -----------------------------+
| mark . nanoharness | title . folder                 status |
| [ New session ]    +---------------------------------------+
| FOLDERS         +  | you                                   |
| [search        ]   | thinking >                            |
| v nanoharness  3   | read  src/core/session.ts       done  |
|     fix the gate   | assistant                             |
|     add a tool     +---------------------------------------+
| > notes        1   | [ message the agent               ]   |
|                    | model  effort  scope   usage     [->] |
| [ Settings ]       |                                       |
+--------------------+---------------------------------------+
```

Folders group sessions, and the grouping is not cosmetic: a folder is the
boundary its sessions are held to, so the tree shows exactly what each session
may touch (see `sessions.md`). A row opens a session, the `x` deletes it, and
the search box filters titles. **New session** starts one in the selected
folder; with no folder yet it opens the directory picker instead, because there
is nothing else it could sensibly do.

A turn streams into the flow: user blocks, a thinking block that fills in live
and folds itself away when the answer starts, tool rows that show the argument
worth seeing beside the name and grow their output when they return, then the
answer. Enter sends, Shift+Enter makes a newline, and the composer locks while a
turn is in flight. The running usage total sits on the control row rather than
in the flow, where it would push the conversation up every round.

Re-opening a session replays its stored messages and tool calls, refusals
included: a tool that was denied comes back marked failed rather than dressed
up as a call that worked. Thinking is not stored, so an old session shows none
- only what was said and done.

The window has no menu bar. There are no menu commands to put in one, and the
renderer handles its own text editing, so the File/Edit/View strip would have
been decoration.

## Marks

Two of them. `logo.svg` is the full mark, three window dots and all, and it is
used at 72px on the empty state and as the window icon. The dots turn to mush
below about 48px, so anything small - the sidebar header - gets `mark.svg`, the
dot-free variant. `scripts/copy-assets.mjs` copies both into `out/renderer/`.

## Settings

Settings is a sheet over the app, not a screen the app falls back to: the
conversation stays where it was. It opens by itself only when nothing can run -
no provider saved, or a saved one that no longer resolves - and Esc reopens it
in that state rather than stranding the user on an app that cannot run.

The providers pane asks for a name, an API kind, a base URL and a key, because
none of them has a default (see `providers.md`). **Test connection** and **Fetch
models** both call `GET /v1/models` through `config:probe`; the first reports
reachability, the second lists what the server offers as a set of checkboxes.
Ticking is the point: only ticked models can become the active model, so a
provider's full catalogue never leaks into the picker. A server without a model
list says so, and the active model stays a text field.

Once one provider is saved the pane grows a list of them across the top. A row
switches the form to that provider; **Add another provider** blanks it for a new
one; **Remove provider** deletes the record and its key. The row of the provider
a turn would run is marked active.

Two chips on the composer are the fast path past the sheet entirely: a model
picker holding that provider's ticked models, and an effort picker
(`none`, `low`, `medium`, `high`). Changing either writes the active selection
and retires the live sessions, so the next message runs on what the chips say.

Still to come with the rest of step 5: the design-token pass, command palette,
keyboard map, snippet picker, and the diff view. Plan §13 has the full list.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, no remote content. The
  renderer sees one small bridge object on `window.nanoharness` and never
  `ipcRenderer`.
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

One live `Session` per session id, built on first use and reused after, so a
conversation keeps its history in memory and its transcript on disk. Settings
writes retire the live ones; the stored transcript is what makes that lossless.
`sessions.md` has the storage and scoping rules.

## Tokens

`renderer.css` carries a provisional set: warm-gray dark ground, one
terracotta accent, mono for the transcript and sans for chrome, a 4px spacing
scale. The real token set arrives with the design pass and belongs in this file
per plan §13.
