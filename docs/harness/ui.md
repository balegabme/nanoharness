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
- src/renderer/notify.ts — the blip and desktop notification when a turn ends
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
| [ Settings ]       | model effort scope alerts usage [->]  |
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
answer. Enter sends and Shift+Enter makes a newline. The running usage total
sits on the control row rather than in the flow, where it would push the
conversation up every round.

**Send becomes Stop** for the length of a turn — same button, same place, and
Esc in the composer does the same thing. The composer itself stays live, so the
next message can be written while this one runs. Stopping aborts the request in
flight and ends the turn at the next boundary (`sessions.md` has the mechanics);
the flow gets a "Stopped." rule across it, and the session can be continued.

**When a turn ends the app says so**: a short two-note blip, and an OS
notification if the window is not the one being looked at. The `alerts` chip
turns both off and remembers that in `localStorage`, because it is a preference
about this machine's speakers rather than part of the harness configuration.
The tone differs by outcome — rising for finished, falling for stopped, flat and
low for an error — so a turn's ending is legible from the next room.

Re-opening a session replays its stored messages and tool calls, refusals
included: a tool that was denied comes back marked failed rather than dressed
up as a call that worked. Thinking replays too, folded away, where the provider
signed it and it therefore had to be kept (see `providers.md`).

The window has no menu bar. There are no menu commands to put in one, and the
renderer handles its own text editing, so the File/Edit/View strip would have
been decoration.

## Marks

Two of them. `logo.svg` is the full mark, three window dots and all, and it is
used at 112px on the empty state and as the window icon — big enough that the
dots read as dots. Below about 48px they turn to mush, so anything small — the
sidebar header, at 24px — gets `mark.svg`, the dot-free variant.
`scripts/copy-assets.mjs` copies both into `out/renderer/`.

## Settings

Settings is a sheet over the app, not a screen the app falls back to: the
conversation stays where it was. It opens by itself only when nothing can run -
no provider saved, or a saved one that no longer resolves - and Esc reopens it
in that state rather than stranding the user on an app that cannot run.

The providers pane asks for a name, an API kind, a base URL and a key, because
none of them has a default (see `providers.md`). The kind is named for the wire
format, not the vendor — "OpenAI-compatible (/chat/completions)",
"Anthropic-compatible (/messages)" — and the base-URL field carries a hint that
changes with it, saying which part of the address to paste and giving examples
for that side. **Test connection** and **Fetch models** both call
`GET {base}/models` through `config:probe`; the first reports
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
(`none`, `low`, `medium`, `high`, mapped per wire in `providers.md`). Changing
either writes the active selection and retires the live sessions, so the next
message runs on what the chips say.

Still to come with the rest of step 5: the command palette, keyboard map,
snippet picker, and the diff view. Plan §13 has the full list.

## Asking to leave the folder

A tool that reaches outside its session's folder parks the turn behind a modal.
The modal lists **every** resolved path that one call reaches for, not one path
at a time: a shell command routinely names several, and four prompts for one
command is how people learn to click Allow without reading. Symlinks and `..`
are already followed, so what is on screen is where the agent would actually
land.

Answers stick for the session. **Allow for this session** grants the directory
rather than the single file, and a **Deny** is remembered — a model told no
tends to try the same path again, and asking twice about a settled question is
the other way a prompt stops being read.

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

`renderer.css` carries the set: a warm dark ground in four surfaces (`--bg`,
`--bg-raised`, `--bg-sunken`, `--bg-hover`), two border weights, one terracotta
accent plus a soft wash of it for selection, mono for the transcript and sans
for chrome, and a 4px spacing scale. Everything is a variable — no colour is
written twice — so a light theme is a second `:root` block and nothing else.
