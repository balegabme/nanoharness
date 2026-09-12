# Desktop UI

The renderer draws events and nothing else. Every fact on screen arrives as an
`AppEvent` over the typed IPC channels; the renderer holds no harness state of
its own, which is why the window can be rebuilt without touching the core.

Files:
- src/main/window.ts — BrowserWindow, the `app://` scheme, navigation lockdown
- src/main/preload.ts — the context bridge, with ping, send, workspaces, sessions, rename, transcript paths, role, jobs, one subagent's stored conversation, agents, MCP status, secrets, config, permission answers, external links, onEvent
- src/renderer/index.ts — the shell, which session is open, and the agent, model and effort chips
- src/renderer/composer.ts — the composer in its two seats, and the height the flow clears
- src/renderer/jobs.ts — the running subagents and the buffered stream of each one
- src/renderer/sidebar.ts — folders and their sessions, search, add and delete
- src/renderer/chat.ts — the message flow, drawn the same for the main agent and for an opened subagent, with streamed text, thinking, tool rows, notes and replayed transcripts
- src/renderer/settings.ts — the settings sheet, with the provider list, form, probe and model ticking
- src/renderer/permission.ts — the modal a tool waits on when it reaches outside its folder
- src/renderer/confirm.ts — the app's own yes/no and one-line-of-text sheets, in place of the browser's `confirm()` and `prompt()`
- src/renderer/menu.ts — the right-click menu, one at a time, placed near the pointer, closed by the next thing the user does
- src/renderer/notify.ts — the blip and desktop notification when a turn ends
- src/renderer/dom.ts — the small DOM helpers the rest share

`src/renderer/index.html` and `src/renderer/renderer.css` ship alongside and are
copied into `out/` by `scripts/copy-assets.mjs`.

## Layout

Two columns. The sidebar is the session list; the rest of the window is one
session at a time. The composer is one element that lives in two seats: in the
middle of the hero before a session exists, and in a card floating over the
bottom of the flow once one is open. It is moved instead of re-created, so a
half-written message and the caret survive the move.

```
+- sidebar ----------+- session ------------------------------+
| mark            [|]| title . folder    in/out/cached . hit  |
| [ + New session ]  +----------------------------------------+
| [ search        ]  | you                                    |
| FOLDERS         +  | thinking >                             |
| v nanoharness  3   | read  src/core/session.ts        done  |
|     fix the gate   | assistant                              |
|     add a tool     | . . .  0:07                            |
| > notes        1   |  +- composer -------------------------+|
| BACKGROUND         |  | message the agent                  ||
| builder   running  |  | agent model effort scope alerts [->]||
|  read the ledger   |  +------------------------------------+|
| [ Settings ]  [ ] |                                        |
+--------------------+----------------------------------------+
```

The sidebar collapses to a rail: the toggle in its header narrows it to icons,
and everything marked `wide-only`, search and the tree, goes with it. The mark
in the rail doubles as the button that brings it back.

Folders group sessions, and the grouping is not cosmetic: a folder is the
boundary its sessions are held to, so the tree shows exactly what each session
may touch (see `sessions.md`). A row opens a session, the `x` deletes it, and
the search box filters titles. **New session** starts one in the selected
folder; with no folder yet it opens the directory picker instead, because there
is nothing else it could sensibly do.

A turn streams into the flow: user blocks, a thinking block that fills in live
and folds itself away when the answer starts, tool rows that show the argument
worth seeing beside the name and grow their output when they return, then the
answer. Enter sends and Shift+Enter makes a newline.

A running turn is shown in the flow, at the end of it, where the next answer
will appear: three dots and the elapsed time. Nothing is drawn when no turn is
running. A permanent "idle" is a light that says the fuse has not blown, and in
the top corner nobody was looking at it anyway. The topbar chip is kept for the
one state worth reading there: `offline`, when the bridge itself is not
answering.

An empty session shows the mark, faint and large behind where the first answer
will land, and it goes the moment anything is appended. A session that has been
started but not answered yet is otherwise a blank rectangle with a composer
under it, which reads as broken rather than as ready.

The running total sits in the topbar, to the right of the title, as a row of
small pills: in, out, cached, hit rate, reasoning, and tokens per second. Each
pill is a bright number and a dim name, so the row reads as numbers first and
labels second. The rate is measured here rather than reported by the provider:
the `usage` event carries a running total, so a round's tokens per second is the
output that arrived since the last event over the wall time it took, and a round
too short to measure honestly (under 0.4s) does not produce one. Re-opening a
session shows its stored totals without a rate, because no round has run yet.

The topbar is where that row belongs. It is a fact about the session, like the
title and the folder beside it, and not a control. On the control row the chips
squeezed it out, and a line of its own under them was worse still: it landed on
the card's rounded bottom corner next to the send button and read as hanging
outside the card. The total is stored with the session, so re-opening one shows
what it has already cost instead of starting the count at zero, and the rebuilt
session picks the total back up and carries on adding to it.

The control row is measured against the composer card rather than the window,
because the same card is narrow with the rail open and wide with it collapsed.
As it tightens, `alerts` goes first and the scope badge second: both repeat
something the settings pane says, while the three selects are the only way to
change a turn from here.

Send becomes Stop for the length of a turn: same button, same place, and Esc in
the composer does the same thing. The composer itself stays live, so the next
message can be written while this one runs. Stopping aborts the request in
flight and ends the turn at the next boundary (`sessions.md` has the mechanics);
the flow gets a "Stopped." rule across it, and the session can be continued.

When a turn ends the app says so: a short two-note blip, and an OS notification
if the window is not the one being looked at. The `alerts` chip is a bell,
struck through when it is off, which is the state worth being able to read at a
glance. It turns both off and remembers that in `localStorage`, because it is a
preference about this machine's speakers rather than part of the harness
configuration. The tone differs by outcome, rising for finished, falling for
stopped, flat and low for an error, so a turn's ending is legible from the next
room.

A note block says what the run did, as its own rule across the flow, dim where
an error block is red. The window uses it for anything that is about the run
rather than about the conversation: a stop, a turn that came back with no answer
at all, a call the harness refused because it was the third identical one, a
background job starting and finishing. Without it, a turn that ends without an
answer leaves the flow looking exactly like a finished turn, which reads as the
agent giving up.

Re-opening a session replays its stored messages and tool calls, refusals
included: a tool that was denied comes back marked failed rather than dressed
up as a call that worked. Thinking replays too, folded away, where the provider
signed it and it therefore had to be kept (see `providers.md`). The notes come
back with them, each one drawn between the same two blocks it appeared between
live, because the session file records how many messages had been written when
it happened, so the position is stored rather than guessed. A note is drawn
once: the live path draws an error and a stop from their own events, and only
the replay path draws them from the journal.

The window has no menu bar. There are no menu commands to put in one, and the
renderer handles its own text editing, so the File/Edit/View strip would have
been decoration.

## Marks

Two of them. `logo.svg` is the full mark, three window dots and all, and it is
used at 112px on the empty state and as the window icon, big enough that the
dots read as dots. Below about 48px they turn to mush, so anything small, such
as the sidebar header at 24px, gets `mark.svg`, the dot-free variant.
`scripts/copy-assets.mjs` copies both into `out/renderer/`.

## Settings

Settings is a sheet over the app, not a screen the app falls back to: the
conversation stays where it was. It opens by itself only when nothing can run
(no provider saved, or a saved one that no longer resolves), and Esc reopens it
in that state rather than stranding the user on an app that cannot run.

The providers pane asks for a name, an API kind, a base URL and a key, because
none of them has a default (see `providers.md`). The kind is named for the wire
format rather than the vendor, as "OpenAI-compatible (/chat/completions)" and
"Anthropic-compatible (/messages)", and the base-URL field carries a hint that
changes with it, saying which part of the address to paste and giving examples
for that side. **Test connection** and **Fetch models** both call
`GET {base}/models` through `config:probe`; the first reports reachability, the
second lists what the server offers as a set of checkboxes. Ticking is the
point: only ticked models can become the active model, so a provider's full
catalogue never leaks into the picker. A server without a model list says so,
and nothing is ticked until one is fetched.

Once one provider is saved the pane grows a list of them across the top. A card
switches the form to that provider; **Add another provider** blanks it for a new
one; the `x` on a card deletes that provider and its key, after a confirmation
naming it. The `x` belongs on the card because the card is the thing being
removed. A **Remove provider** button down in the form acts on whichever
provider happens to be loaded, which is one click and one mis-read away from
deleting the wrong one. The card of the provider a turn would run is marked
active.

There is no **Active model** control in the sheet. The model chip on the
composer is the one place to change it, and saving keeps the running model if it
is still ticked, or falls back to the first ticked one if it is not, so a save
cannot leave a provider with no model to run.

Three chips on the composer are the fast path past the sheet entirely: the
agent picker, a model picker holding that provider's ticked models, and an
effort picker (`none`, `low`, `medium`, `high`, mapped per wire in
`providers.md`). Changing any of them retires the live sessions, so the next
message runs on what the chips say.

Each chip draws its own label and lays an invisible native `<select>` over it. A
bare select sizes itself to its widest option, so one long model id would push
the whole row along and out from under the send button. With the label under our
control the model chip is the one that gives way when the window narrows, and
the rest keep their size. The agent chip switches the session's role and leaves
effort alone: how hard to think is an answer the user already gave, and a role
that moved the chip under their hand was overwriting it (see `agents.md`).

Still to come with the rest of step 5: the command palette, keyboard map,
snippet picker, and the diff view. Plan §13 has the full list.

## Dialogs, pickers and the about pane

Nothing the app opens is drawn by the browser. `confirm()` is replaced by a
sheet in the app's own vocabulary (`confirm.ts`), and Esc and a backdrop click
both answer no. A native dialog in the middle of a themed window is the tell
that a screen was assembled rather than designed, and it ignores the theme
besides.

The sheet answers on the right, Cancel first and the destructive button last,
and that button is filled in the same red as the stop button. Red text on
nothing beside an outlined Cancel drew the weaker of the two controls as the
one the sheet exists for. `danger` is now kept for buttons that actually
destroy something: the permission sheet's **Deny** refuses a request rather
than deleting anything, so it is an ordinary outlined button.

The `<select>` popups are ours too, through `appearance: base-select`: the list
is a card on the app's surfaces, borders and shadow, with the accent on the
ticked row and a checkmark in a reserved column so the labels stay in one line.
The chevron on the settings selects is drawn in CSS and turns over when the
picker opens. Where the property is missing the plain rules underneath still
apply and the popup is the platform's, because the whole block sits behind an
`@supports`.

The about pane is a mark, the line "Built with ♥ by balega", and a link to
`@BalegaNorbert` on X, with the version under it. The link cannot open in the
window: `setWindowOpenHandler` denies new windows and `will-navigate` is
cancelled, by design. It goes out through a `shell:open-external` channel that
refuses anything that is not `http:` or `https:`, so the one hole in the
navigation lockdown is a hole exactly one scheme wide.

## Asking to leave the folder

A tool that reaches outside its session's folder parks the turn behind a modal.
The modal lists **every** resolved path that one call reaches for, not one path
at a time: a shell command routinely names several, and four prompts for one
command is how people learn to click Allow without reading. Symlinks and `..`
are already followed, so what is on screen is where the agent would actually
land.

Answers stick for the session. **Allow for this session** grants the directory
rather than the single file, and a **Deny** is remembered, because a model told
no tends to try the same path again, and asking twice about a settled question
is the other way a prompt stops being read.

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
  preload that way. Context isolation is the boundary that matters here, and
  shipping the preload as CommonJS to turn the sandbox back on is in the ledger.

## Session model

One live `Session` per session id, built on first use and reused after, so a
conversation keeps its history in memory and its transcript on disk. Settings
writes retire the live ones; the stored transcript is what makes that lossless.
`sessions.md` has the storage and scoping rules.

## Subagents

A subagent is opened from the thing that started it. There is no list of
subagents anywhere in the window: the `spawn` tool call in the conversation is
the subagent, so clicking that card opens it. The card, and a background job's
notes, carry a `[subagent:<id>]` marker that `chat.ts` strips out of the visible
text; the note gets an **Open subagent** button, and the card gets the button
plus a click handler over its whole head. A tool card normally folds open on its
arguments, which for a spawn are the least interesting thing about it, since the
conversation it led to is the point, so the toggle is suppressed and the click
shows the subagent instead. The marker is stored in the transcript, so a session
reopened tomorrow opens last week's subagents exactly the way it opens today's.

A foreground spawn gets its button when the job starts rather than when it
answers. Its card sits there running while the parent's turn is blocked behind
it, and until the answer lands that card is the only thing in the window naming
the subagent: a minute of apparently nothing happening, with no way in. A
background one is named twice, once when it starts and once when it ends, and
both notes link to the same conversation.

A subagent's own stream reaches the window. Its events are emitted under
`sessionId` = its job id, so `index.ts` routes anything carrying a known job id
to `jobs.ts`, which folds it into a per-subagent buffer, with consecutive text
and thinking deltas merged, so a buffer is the size of the answer rather than
the size of the stream. That is what lets a subagent nobody was watching be
opened mid-run and read from the beginning.

Opening one shows it in the conversation's own place. A subagent is an agent
doing exactly what the main one does, so it is drawn by exactly the same code:
`chat.ts` is a class, and the window holds two of them, the conversation and the
subagent on screen. A sheet beside the flow, redrawing a subagent as one line
per event, would be a second and dimmer rendering of the same events, a second
thing to keep correct, and never as good as the first. The stream, the composer
dock and the subagent view swap places; the topbar grows a back button, which is
the only way out, because the conversation is one step behind a subagent rather
than somewhere else to navigate to.

Above the flow sits what the tool card could not hold: the role and mode, the
state, how long it has been going, the task as the parent phrased it, what the
subagent has spent, and a copy button for the result, which for a background job
is nowhere else in the window. The role and mode are there because those two
words decide what the subagent could see: a `clone` carries the parent's prompt,
tools and history, a `distinct` one starts from its task and nothing else.
Reading what a subagent said without knowing which it was is reading half of it.

Only running subagents are held in memory. `jobs.ts` keeps the facts and the
buffer of each one that is in flight, and drops both when it finishes, because
by then the child's whole conversation is on disk and opening it afterwards
reads the transcript over `subagent:open`. One that finishes while it is on
screen is kept until the reader leaves it, so it does not blink out from under
them. The result is that there is one path for a subagent that ended a second
ago and one that ended last week, and both give the whole conversation rather
than a summary.

## The answer, and the rest of the turn

A turn is mostly tool cards and half-sentences between them. The thing the user
actually asked for is the last assistant block, since the loop only ends when
the model stops asking for tools, and it is marked so it does not read like the
commentary above it. The mark goes on when the turn *finishes* and not while it
streams, because a block that turns out to be followed by another tool call was
never the answer; on a replayed transcript the same rule reads as "text with no
tool calls". A stopped turn has no answer and gets no mark.

## Right-click

`menu.ts` draws the context menu: one open at a time, placed near the pointer
and nudged off the window edge, closed by the next thing the user does, whether
a click anywhere, Escape, a scroll or a resize. A session's row offers open,
rename, copy the session id, copy the transcript path, and delete; a folder's
header offers a new session in it, copy the path, and remove. The row still
carries its delete button, and everything that does not earn a permanent 24px
of chrome lives here instead.

Rename asks in the app's own one-line sheet (`confirm.ts`), which resolves to
`null` when the user backs out, which is distinguishable from an empty answer,
and the main process refuses an empty answer anyway. A copy that works says
nothing: the clipboard is the confirmation. A copy that is refused says so,
because the alternative is a menu item that silently does nothing.

## Which MCP servers answered

The topbar carries a chip with two counts: green for the servers this session is
talking to, red for the ones configured and not answering. "MCP is configured"
and "MCP is up" are different claims, and only the second one explains a tool
that is not there. Hovering names each server with its tool count, or with the
error that stopped it.

A session's servers are dialled on its first message, because clicking a session
in the sidebar must not start a row of subprocesses nobody asked for. Before
that the chip shows what the config asks for, greyed, and says so in the tooltip
instead of showing a red count for something nobody has tried yet. There is no
split to draw before the first message either, so the chip drops its second dot
entirely and shows one number: how many servers this folder is configured for.
Two grey dots, the count and a nought, read as "some are down" on a session that
had not tried to start anything. When the hub finishes connecting, the main
process pushes an `mcp.status` event and the chip becomes the real answer.
`mcp.md` has the client.

## Keys pasted into the chat

A key in a message is taken out of it before the window draws it: the composer
sends the text through `captureSecrets`, and what appears in the flow, in the
transcript and in the prompt is a `{{secret:name}}` reference. A note in the
flow says which references were made, once, so the user knows the key was caught
rather than eaten. **Settings › Secrets** lists what the vault holds, names and
vendors and never values, which do not cross the bridge even here, and offers to
forget any of them. `secrets.md` has the rest of it, including why the model
never sees the value.

## Tokens

`renderer.css` is three layers, and nothing skips one:

1. ramp: `--nh-warm-*` (a warm neutral in eighteen steps, the hue the mark is
   drawn in), `--nh-accent-*` terracotta, and green/red/amber for state. Raw
   colour, never touched by a component.
2. alias: `--nh-bg-*`, `--nh-border-*`, `--nh-label-*`, `--nh-button-*`,
   `--nh-state-*`. What a colour is *for*. The only layer that names intent.
3. components: read alias tokens and nothing else.

There is one set of alias values, because the app is dark and only dark (plan
section 3). The layer still earns its keep without a second theme to justify it:
a rule that reads `--nh-label-tertiary` says what the colour is for, which a hex
code never does, and the ramp underneath keeps the greys on one hue. Alongside
the colour sits the rest of the vocabulary: one easing curve and three
durations, so no animation invents its own timing; a 4px spacing scale; four
corner radii, one per kind of surface; mono for the transcript and sans for
chrome.
