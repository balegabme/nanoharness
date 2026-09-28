# Desktop UI

The renderer draws events and nothing else. Every fact on screen arrives as an
`AppEvent` over the typed IPC channels; the renderer holds no harness state of
its own, which is why the window can be rebuilt without touching the core.

Files:
- src/main/window.ts: BrowserWindow, the `app://` scheme, navigation lockdown
- src/main/preload.ts: the context bridge, with ping, send, compact, TL;DR, reload, snippets, checkpoints, rewind, workspaces, sessions, rename, transcript paths, role, jobs, one subagent's stored conversation, agents, MCP status, secrets, config, permission answers, question answers, project trust answers, the usage report and clearing it, external links, onEvent
- src/renderer/index.ts: the shell, which session is open, the agent, model and effort chips, and the diff and spend panes
- src/renderer/composer.ts: the composer in its two seats, the height of the dock column the flow clears, and the pictures attached to the draft
- src/renderer/images.ts: a pasted or dropped file read as a picture to send, shrunk first when the switch is on
- src/renderer/jobs.ts: the running subagents and the buffered stream of each one
- src/renderer/sidebar.ts: folders and their sessions, search, add and delete
- src/renderer/metrics.ts: tokens per second, kept away from the DOM so it can be tested
- src/renderer/facts.ts: the words the window puts on an effort level, a price and a missing fact
- src/renderer/chat.ts: the message flow, drawn the same for the main agent and for an opened subagent, with streamed text, thinking, tool rows, notes and replayed transcripts
- src/renderer/markdown.ts: an answer's Markdown turned into DOM nodes, with tables, lists, quotes and fenced code
- src/renderer/highlight.ts: syntax colouring for fenced code and diff lines, one small grammar per language family
- src/renderer/diff-rows.ts: a unified diff drawn as numbered rows, for the edit card, the diff pane and a `diff` fence
- src/renderer/settings.ts: the settings sheet, with the provider list, form, probe and model ticking
- src/renderer/permission.ts: the modal a tool waits on when it reaches outside its folder
- src/renderer/plan.ts: the agent's plan pinned above the composer, folded to one line or open to every step
- src/renderer/question.ts: the card an `ask_user` question is answered in, above the composer
- src/renderer/recall.ts: Up and Down in an empty composer, walking back through the messages sent in the session on screen
- src/renderer/confirm.ts: the app's own yes/no and one-line-of-text sheets, in place of the browser's `confirm()` and `prompt()`
- src/renderer/turns.ts: the turns on screen and going back to one: each turn's Rewind button and menu, the card that asks before a rewind, the bar under a held one, and the turn index
- src/renderer/menu.ts: the right-click menu, one at a time, placed near the pointer, closed by the next thing the user does
- src/renderer/popover.ts: the panel a topbar button opens, placed under it and closed by Escape or a click elsewhere
- src/renderer/context-meter.ts: the context ring and its panel, with the parts, the compactions and the controls
- src/renderer/notify.ts: the blip and desktop notification when a turn ends or asks for approval
- src/renderer/match.ts: whether a model id is what somebody typing into the filter box meant to find
- src/renderer/dom.ts: the small DOM helpers the rest share

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
| mark            [|]| title . folder   tok/s  tokens  (66%) |
| [ + New session ]  +----------------------------------------+
| [ search        ]  | you                                    |
| FOLDERS         +  | thinking >                             |
| v nanoharness  3   | read  src/core/session.ts           ✓  |
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
answer. Enter sends and Shift+Enter makes a newline. Up in an empty composer
brings back the last message sent in the session on screen, and each further
Up the one before it, the way a shell walks its history. Down walks forward,
and past the newest message the composer is empty again. A message sent with
snippets comes back as the words the user typed (`commands.md`). In a
recalled message of several lines the keys move the caret until it reaches the
first or last line, and typing ends the walk with the text left where it is.

A `/` at the start of the draft or after a space opens the command menu, and
so does the `/` button among the controls. It runs `/tldr`, `/compact` and
`/reload` and adds prompt snippets, which sit above or below the draft until
the message is sent (`commands.md`).

A running turn is shown in the flow, at the end of it, where the next answer
will appear: three dots and the elapsed time. Nothing is drawn when no turn is
running. A permanent "idle" is a light that says the fuse has not blown, and in
the top corner nobody was looking at it anyway. The topbar chip is kept for the
one state worth reading there: `offline`, when the bridge itself is not
answering.

An empty session shows the mark, faint and large behind where the first answer
will land, and it goes the moment anything is appended. A session that has been
started but not answered yet is otherwise a blank rectangle with a composer
under it, which reads as broken instead of ready.

The topbar carries three figures to the right of the title. The first is the
rate, tokens per second, as plain text while a stream runs and for the last
turn after it. The other two are buttons, one for what the session has spent
and one for how full its context is, and each opens a panel with the detail.

Neither the rate nor its tokens are taken off the clock in the window. The
`usage` event carries the running total and `streamMs`, the time the model
actually spent generating that round, because by the time an event arrives the
gap since the last one is mostly whatever tool ran in between, and a turn with
one slow bash call in it would report the model at a fraction of its real
speed. Tokens and generating-time accumulate across the turn, and a turn that
has generated for under 0.4s shows no rate at all, where a noisy one would be
worse. A subagent's usage carries no `streamMs`, so it adds to the counters and
stays out of the rate. A finished turn that generated anything stores its output
and generating time on the session record, so a session opened from the list shows the rate of its
last turn, on the same 0.4s floor. A subagent opened from the list shows none.
`metrics.ts` has the arithmetic, away from the DOM so it is tested.

The tokens button is the session's whole spend in one short count, such as
`669k tokens`. Its panel holds the breakdown of the conversation as a row of
pills: in, out, cached, what it has spent and hit rate, plus reasoning and
cache-written where there are any. The spend appears only once a model has a
price, and it is the conversation's tokens put through the rate of the model
selected now, so a session that switched models is an estimate, and the note
under the pills says so. The exact figure for one turn is on that turn's own
summary line, priced by the model that ran it. A turn that delegates gets one
more pill, **by agents**, which is how much of the output was written by
subagents this session started. A session can read fifty thousand out while
having written a paragraph itself, and the single total cannot say which of
those happened. The pill is quieter than the ones beside it, because it is an
aside about `out` and not a measure of its own. Harness spend (approval checks,
compaction summaries and TL;DRs) is left out of the other pills and gets a
**harness** pill of its own with its tokens and what they cost. Those calls ran
on their own models at their own prices, so the conversation's spend reads $0
on a free chat model even when a paid model checked its commands. Both splits
are stored with the session's total, so a session re-opened a week later still
shows them. Each pill is a bright number and a dim name, so the row reads as
numbers first and labels second, and everything the hit rate divides by is on
the row so the percentage can be checked. A link at the bottom opens the spend
view.

The context button is a ring and a percentage: the next request against the
usable space, the window (or the user's limit, where that is smaller) less the
room kept for the answer. `context.md` has
how the figure is measured. The ring is green below 60%, amber below the
automatic threshold and red from it, so red means the harness is about to step
in. With no usable space known, because neither the window nor a limit is
known or the reserve fills it, the ring stays empty and the label is the size in tokens. The ring pulses while a compaction runs.

Its panel shows the size against the usable space, then the window, the limit
where it is the smaller, the reserve and the usable space on one line. Under that is a bar of the request's parts
with a tick at the automatic threshold, so the gap between the end of the bar
and the tick is the room left, and a table of the parts in tokens and as shares.
A line says how much of the total the provider counted and how much is
estimated since. A warning follows where no window is known or automatic
compaction is off, then the compactions so far, newest first, and the controls:
**Compact now** and the automatic toggle, then a field for the limit on the
context in tokens. The toggle and the limit are each one setting for every
session. An empty field clears the limit, and anything that is not a whole
number above nought puts the old value back. The panel is not redrawn while the
field has focus, since a running turn sends a new ledger every round and would
wipe what is being typed. A draw held back that way waits, when the field loses
focus, for the click that took the focus away, so the control being clicked is
not replaced under it. **Compact now** is disabled while a turn runs, because the turn checks
before every request on its own. A session opened from the list shows the
ledger it was left with, and a line saying so, until the next message makes it
live.

The topbar is where these belong. They are facts about the session, like the
title and the folder beside it. On the control row the chips squeezed them out,
and a line under the chips landed on the card's rounded bottom corner next to
the send button. The totals and the ledger are stored with the session, so
re-opening one shows what it has cost and how full it was, and the rebuilt
session carries on from there.

A panel opens under its button (`popover.ts`) and only one is open at a time.
It closes on Escape, on a click outside it, and when the view moves to another
session or out of a subagent, where it would describe something no longer on
screen. It lives at the end of `<body>` with fixed coordinates, because the
topbar clips what overflows it. Escape is caught before the composer sees it,
where it would also stop the running turn.

The control row is measured against the composer card, never the window,
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
if the window is not the one being looked at. A permission prompt rings too, and
that one carries a question: a turn asking to leave its folder stays stopped for
as long as nobody answers. Its tone is longer and repeats, since the other three
are told to someone who has finished waiting and this one has to reach someone
who stopped watching. Every ask rings, queued ones included, because each is a
separate question. The `alerts` chip is a bell, struck through when it is off,
which is the state worth being able to read at a glance. It turns both off and
remembers that in `localStorage`, because it is a preference about this
machine's speakers and not part of the harness configuration. Approval
prompts fall silent with everything else, since silence is a thing people ask
for on purpose. The tone differs by outcome, rising for finished, falling
for stopped, flat and low for an error, so a turn's ending is legible from the
next room.

A finished tool call is marked: a check for one that worked, a cross for one
that failed, in the same green and red as the dot beside the tool name. The
state of twenty cards is read down the column in one pass, and a glyph survives
that reading where the words `done` and `failed` have to be taken in one at a
time. A running call keeps its word, since any glyph for it reads as a third
result.

Every turn ends on a summary line under the answer: how many tool calls the turn
took and how many failed, which files `edit` and `write` left different, and how
long it ran. A `bash` call that writes a file is invisible to the count, so the
line claims only what those two tools touched, and a long list is cut short
after twelve paths with the rest counted. It is the dimmest thing in the flow,
because the numbers are worth a glance and never worth a stop, and that is why
it is drawn as its own kind of block and not as a note. The line is
stored with the transcript, so a session opened next week still shows what each
turn cost; `sessions.md` has the shape. Every ending gets one, an error and a
stop included.

A turn the permission system stopped something in counts those calls apart from
the failures, as `2 ok, 0 failed, 1 prevented`, and the line becomes a
disclosure you can open on what was stopped and why, each entry carrying the
refusal in the words it was refused with. The count is only ever shown when
there is one, so an ordinary turn reads exactly as it always did.

The two are separate because they ask different things of whoever reads the
line. A failure is the work going wrong and is the agent's problem; a prevention
is the harness doing its job and is the user's to review. It matters most in
auto mode, where the decisions were made while nobody was watching: a run that
comes back "14 ok, 0 failed, 2 prevented" went well and stopped two things, and
being able to open those two is the difference between trusting the mode and
hoping. The list travels with the summary into the stored transcript, so it is
still there next week.

A note block says what the run did, as its own rule across the flow, dim where
an error block is red. The window uses it for anything that is about the run
and not about the conversation: a stop, a turn that came back with no answer
at all, a call the harness refused because it was the third identical one, a
background job starting and finishing, a request that failed and is being made
again. Without it, a turn that ends without an answer leaves the flow looking
exactly like a finished turn, which reads as the agent giving up.

A retry takes back what the failed attempt drew. `round.started` marks the
boundary and `round.retry` rolls the flow back to it, removing the half a
paragraph, the thinking and the tool cards that belong to an answer which no
longer exists, and then writes the note saying which attempt is coming. The
alternative is leaving the reader to work out which half of two interleaved
answers is the real one. `providers.md` has what counts as worth asking again.

A compaction is drawn where it happened: a rule across the flow in the accent
colour, the summary under it folded away like thinking, and the note saying
what was summarised and shortened. While it runs the activity line reads
`compacting`. The messages that went into a summary stay on screen at half
strength. They are still the conversation the user had, and the model no longer
sees them. A tool card whose output now goes to the model shortened gets a
`shortened` chip, with a tooltip saying how much of it the model still gets;
the card keeps the whole output. The dimming is drawn from the stored markers
when the transcript is drawn, so an automatic compaction in the middle of a
turn dims its blocks the next time the session is opened. A compaction by hand
redraws the session at once.

Re-opening a session replays its stored messages and tool calls, refusals
included: a tool that was denied comes back marked failed and never dressed up
as a call that worked. Thinking replays too, folded away, where the provider
signed it and it therefore had to be kept (see `providers.md`). The notes come
back with them, each one drawn between the same two blocks it appeared between
live, because the session file records how many messages had been written when
it happened, so the position is stored and never guessed. A note is drawn
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
in that state instead of stranding the user on an app that cannot run.

The providers pane asks for a name, an API kind, a base URL and a key, because
none of them has a default (see `providers.md`). The kind is named for the wire
format and not the vendor, as "OpenAI-compatible (/chat/completions)",
"Anthropic-compatible (/messages)" and "OpenAI Responses (/responses)", and the
base-URL field carries a hint that changes with it, saying which part of the
address to paste and giving examples for that side. **Test connection** and
**Fetch models** both call
`GET {base}/models` through `config:probe`; the first reports reachability, the
second lists what the server offers as a set of checkboxes. Ticking is the
point: only ticked models can become the active model, so a provider's full
catalogue never leaks into the picker. A server without a model list says so,
and nothing is ticked until one is fetched.

A new provider starts at a **Provider** picker, holding the endpoints the
harness already knows the address and habits of. Choosing one writes the name,
the wire and the base URL and folds all three away, so the form asks only for
the key and then for which models to allow. **Test connection** goes with them:
reachability is the question a typed address raises, and a fetch answers the
key as well as the host. Going back to setting it up by hand brings the fields
out again, holding what the entry put there.

The picker is offered only while adding, because picking would otherwise write
over the record on screen. What it saves is an ordinary provider record,
renamed, repointed or deleted like any other. `providers.md` has where the list
lives and why the window is sent it instead of keeping its own copy.

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
 Each model in the fetched list carries what the fetch found out about it: its
price per million tokens, and the effort levels it takes. A model nobody has
described is marked ⚠ and reads what is missing beside its id, because the mark
has to say what to do about it, and what to do is the cogwheel at the end of
the row, which opens the levels, the four prices for that model (in, out, and
the two halves of the cache, which fall back to the input rate when they are
left blank), and whether it takes images. The cogwheel stays lit while its
fields are open. Images are a picker of three and not a tick box: most
endpoints publish nothing about it, and an unticked box would say those models
cannot take one. Typed answers outrank the endpoint field by field and survive
the next fetch, so correcting one wrong price does not throw away an effort
list that was right. **Clear what I typed** goes back to whatever the endpoint
said, which for a model it did not describe is the way back to "nobody has
said". A price the endpoint did give cannot be un-said from here; what can be
done to it is to type a different one. Leaving a model unmarked-up costs
nothing: it keeps all seven levels and shows no price.

An endpoint can offer thirty, in an order it chose for itself, so the list is
drawn alphabetically and gets a **Find a model** box once it is past ten. Ids
are written with whatever separators the vendor felt like, so the box reads
punctuation as a space on both sides and tries the run-together spelling too:
`gpt5`, `gpt 5` and `gpt-5` all find `gpt-5.6-luna`. Escape empties the box
before it closes the sheet, since a full box is the nearer thing to leave.

The tick at the top answers for the rows under it, which with a filter on is
what the filter left. Ticking every Qwen is then two gestures instead of
thirty, and the models the box is hiding are not something the user was just
asked about. The count beside it stays whole, `12 of 36 ticked`, because the
list scrolls and a filtered view cannot say how much of the catalogue is on.

Whichever button is the next step is the filled one. A provider with no model it
may run is refused, so **Fetch models** leads until a list is on screen and
**Save** takes over once there is something worth keeping.

Fetching the models of a provider that is already saved writes the answer to
disk on the spot, so the prices and effort levels are stored without a second
click; the offered list stays on screen with the unticked models still there to
tick. A provider being added for the first time is not saved by a fetch, because
the form is still being typed and a Fetch is a look at an endpoint and not a
decision to keep it.

Three chips on the composer are the fast path past the sheet entirely: the
agent picker, a model picker, and an effort picker. Changing any of them retires
the live sessions, so the next message runs on what the chips say.

The effort picker is built from the model now selected, not from a fixed list.
The scale has seven levels and no model takes all of them, so offering the same
seven everywhere meant offering levels the provider would refuse and hiding
ones it had. What a model takes is a fact about that model, read from the
endpoint and kept per provider; `providers.md` covers where it comes from and
what happens when nobody supplies it. Switching to a narrower model clamps the
level to the nearest one it does take, ties going to the quieter of the two,
and writes that back, so what a turn runs on is what the chip says.

The model picker holds every configured provider's ticked models, grouped by
provider name, and picking one from another provider moves the session there in
the same call. There is no separate notion of a selected provider to change
first: the thing being chosen is a model, and which endpoint serves it follows
from the pick. Two providers can offer the same model id, so an option's value
carries both and `setActive` is given the pair. A provider with nothing ticked
still appears when it is the one running, showing the model it is active on,
and never as an empty heading.

Each chip draws its own label and lays an invisible native `<select>` over it. A
bare select sizes itself to its widest option, so one long model id would push
the whole row along and out from under the send button. With the label under our
control the model chip is the one that gives way when the window narrows, and
the rest keep their size. The agent chip switches the session's role and leaves
effort alone: how hard to think is an answer the user already gave, and a role
that moved the chip under their hand was overwriting it (see `agents.md`).

Still to come with the rest of step 5: the command palette, keyboard map, and
the snippet picker. Plan §13 has the full list.

## Dialogs, pickers and the about pane

Nothing the app opens is drawn by the browser. `confirm()` is replaced by a
sheet in the app's own vocabulary (`confirm.ts`), and Esc and a backdrop click
both answer no. A native dialog in the middle of a themed window is the tell
that a screen was assembled instead of designed, and it ignores the theme
besides.

The sheet answers on the right, Cancel first and the destructive button last,
and that button is filled in the same red as the stop button. Red text on
nothing beside an outlined Cancel drew the weaker of the two controls as the
one the sheet exists for. `danger` is now kept for buttons that actually
destroy something: the permission sheet's **Deny** refuses a request without
deleting anything, so it is an ordinary outlined button.

The `<select>` popups are ours too, through `appearance: base-select`: the list
is a card on the app's surfaces, borders and shadow, with the accent on the
ticked row and a checkmark in a reserved column so the labels stay in one line.
The chevron on the settings selects is drawn in CSS and turns over when the
picker opens. Where the property is missing the plain rules underneath still
apply and the popup is the platform's, because the whole block sits behind an
`@supports`.

A question can carry a file, drawn whole in a box of its own under the text.
The question about a project's hooks or MCP servers uses it, because the
approval covers exactly that file (`hooks.md`). Questions come one at a time: one that arrives from the main
process while another is on screen waits until the first is answered.

The general pane holds the settings that are a switch: whether hooks run, and
whether images are shrunk before they are sent. Each box writes through as it
is clicked. A write that fails puts the box back and says why under it.

The about pane is a mark, the line "Built with ♥ by balega", and a link to
`@BalegaNorbert` on X, with the version under it. The link cannot open in the
window: `setWindowOpenHandler` denies new windows and `will-navigate` is
cancelled, by design. It goes out through a `shell:open-external` channel that
refuses anything that is not `http:` or `https:`, so the one hole in the
navigation lockdown is a hole exactly one scheme wide.

## Asking to leave the folder

A tool that reaches outside its session's folder parks the turn behind a modal.
It names the resolved path, after symlinks and `..`, and a **Deny** is
remembered as well as an allow. A shell command parks the same modal and shows
the command itself, since nothing read it for paths; its session answer reads
**Allow all shell commands**, because that is what it grants. `sessions.md` has
the rule, the three answers and why a prompt per path stops being read.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, no remote content. The
  renderer sees one small bridge object on `window.nanoharness` and never
  `ipcRenderer`.
- The page is served over a registered `app://` scheme instead of `file://`.
  A file URL has an opaque origin, which makes `default-src 'self'` meaningless
  and blocks ES modules; the custom scheme gives the page a real origin. The
  handler serves `out/renderer`, plus `out/shared` under `/shared/`
  (`shared.md`), and refuses any path that escapes the one it resolved into.
- `setWindowOpenHandler` denies every new window and `will-navigate` is
  cancelled, so the renderer cannot leave the app scheme.
- `sandbox: false` is the one concession: Electron only loads an ES-module
  preload that way. Context isolation is the boundary that matters here, and
  shipping the preload as CommonJS to turn the sandbox back on is in the ledger.

## Session model

One live `Session` per session id, built on first use and reused after, so a
conversation keeps its history in memory and its transcript on disk. A settings
write that changes what a session was built from retires the live ones; the
stored transcript is what makes that lossless. `sessions.md` has the storage
and scoping rules.

## Subagents

A subagent is opened from the thing that started it. There is no list of
subagents anywhere in the window: the `spawn` tool call in the conversation is
the subagent, so clicking that card opens it. The card, and a background job's
notes, carry a `[subagent:<id>]` marker that `chat.ts` strips out of the visible
text; the note gets an **Open subagent** button, and the card gets a click
handler over its whole head and no button at all. A tool card normally folds
open on its arguments, which for a spawn are the least interesting thing about
it, since the conversation it led to is the point, so the toggle is suppressed
and the click shows the subagent instead. A badge on top of that is a second,
smaller target for the click the whole row already takes; the note carries one
because a note has no card-wide click to inherit. The card says what it is by
lighting up under the pointer. The marker is stored in the transcript, so a
session reopened tomorrow opens last week's subagents exactly the way it opens
today's.

A finished card says what the subagent did on a line under it: the role and
mode it ran as, how many tool calls it took, how many worked, how long it ran
and what it cost. It is the same line `tools/spawn.ts` writes for the model at
the end of the result, read back and never composed a second time.

The line is drawn where a turn's own total is drawn, under the thing it is
about, in the same dim `block summary` the answer ends on. Inside the card's
head it was a second row competing with the tool name for one line, and a
subagent's total is the same kind of fact as a turn's, so it reads in the same
place and the same weight. It stays visible while the card is folded, which is
what tells a reader whether to open it: twelve calls and eighty are different
pieces of work.

A foreground spawn becomes a way in when the job starts and not when it
answers. Its card sits there running while the parent's turn is blocked behind
it, and until the answer lands that card is the only thing in the window naming
the subagent: a minute of apparently nothing happening, with no way in. A
background one is named twice, once when it starts and once when it ends, and
both notes link to the same conversation.

A subagent's own stream reaches the window. Its events are emitted under
`sessionId` = its job id, so `index.ts` routes anything carrying a known job id
to `jobs.ts`, which folds it into a per-subagent buffer, with consecutive text
and thinking deltas merged, so a buffer is the size of the answer and not the
size of the stream. That is what lets a subagent nobody was watching be
opened mid-run and read from the beginning.

Opening one shows it in the conversation's own place. A subagent is an agent
doing exactly what the main one does, so it is drawn by exactly the same code:
`chat.ts` is a class, and the window holds two of them, the conversation and the
subagent on screen. A sheet beside the flow, redrawing a subagent as one line
per event, would be a second and dimmer rendering of the same events, a second
thing to keep correct, and never as good as the first. The stream, the composer
dock and the subagent view swap places; the topbar grows a back button, which is
the only way out, because the conversation is one step behind a subagent and
not somewhere else to navigate to.

Above the flow sits what the card's one line could not hold: the state, how
long it has been going, the task as the parent phrased it, what the subagent
has spent, how its tool calls went, and a copy button for the result, which for
a background job is nowhere else in the window. The role and mode are on both:
the card is read in the flow, and this is read after leaving it. Those two
words decide what the subagent could see: a `clone` carries the parent's
prompt, tools and history, a `distinct` one starts from its task and nothing
else. Reading what a subagent said without knowing which it was is reading half
of it.

The head also has the topbar's three figures, drawn from the child's own
events: its rate, its tokens and its context ring. The context panel there has
no controls. A subagent compacts on the same setting as everything else, and
there is nothing to do about its context from outside it. A finished one shows
the ledger it ended with.

Only running subagents are held in memory. `jobs.ts` keeps the facts and the
buffer of each one that is in flight, and drops both when it finishes, because
by then the child's whole conversation is on disk and opening it afterwards
reads the transcript over `subagent:open`. One that finishes while it is on
screen is kept until the reader leaves it, so it does not blink out from under
them. The result is that there is one path for a subagent that ended a second
ago and one that ended last week, and both give the whole conversation and not
a summary.

## Diffs

An `edit` or a `write` hands back a unified diff of what it changed
(`tools.md`). The card's head counts it, a green `+12` for the lines added and a
red `−3` for the lines removed, and stays folded like any other tool card.
Opened, it shows the line the tool said, `edited src/core/session.ts (1
replacement, +12 −3)`, over the diff itself. The arguments are left out, since
the diff shows the same change more plainly.

`diff-rows.ts` draws a diff the same way wherever it appears: in the card, in
the full pane, and in a `diff` fence inside an answer. Each line is a row with
the old and new line numbers, the sign, and the text coloured as the file's
language, which is read from the path's extension. The background says which
side a line is on, so the text keeps its colours. The two file headers are
dropped, since the path is already on screen, and each hunk marker is set back
as scaffolding. Nothing wraps: a diff is a column, and a line that folds onto
the next one breaks the only thing making it readable, so the rows scroll
sideways instead.

A card's diff stops at a fixed height and scrolls. Its Full view button opens
the same rows in a pane of their own, where the path is the title, the change is
counted beside it, and a copy button hands over the diff as text. The topbar
back button returns to the flow. A diff sits over whichever flow opened it, so
an edit made by a subagent opens from the subagent's own view and back goes
there, not all the way home.
The text comes out of the stored tool result, which means a session reopened
next week opens its diffs the same way it opens its subagents.

## Spend

The third thing drawn where the conversation is, after a subagent and a diff,
and the only one of them that is not a session's: what every session has spent,
opened from the Spend item in the sidebar foot or from the tokens panel, and
left by the same back button. It covers whatever was open instead of
closing it, so back returns to the diff or the subagent that was there.

The renderer does no arithmetic on it. The main process sends a finished report
over `usage:report` and this view draws it, for the reason every number in the
window has one home: `cost.md` has the report, the chart and the rules. The
Clear button beside the range picker is the one thing here that writes: it
deletes the log after asking, and `cost.md` says what that takes with it.

## The answer, and the rest of the turn

A turn is mostly tool cards and half-sentences between them. The thing the user
actually asked for is the last assistant block, since the loop only ends when
the model stops asking for tools, and it is marked so it does not read like the
commentary above it. The mark goes on when the turn *finishes* and not while it
streams, because a block that turns out to be followed by another tool call was
never the answer; on a replayed transcript the same rule reads as "text with no
tool calls". A stopped turn has no answer and gets no mark.

Those half-sentences are drawn without the whitespace the model wrote around
them. A block body is `pre-wrap`, so text that ends in a blank line draws a
blank line, and a model that writes "Let me read both." and two newlines before
calling a tool was putting more empty space between two cards than the sentence
itself took up. Text that was only whitespace leaves no block at all, where it
used to leave a labelled empty one. What survives sits close to the call it
introduces, since commentary belongs with its tool card and not spaced off as a
block of its own.

## The plan and the questions

The dock that floats over the bottom of the flow is one column: the agent's
plan, a question card when one is open, and the composer, stacked from the
bottom so the composer stays put when either of the others comes or goes.
`composer.ts` measures the whole column, and a `ResizeObserver` on it re-measures
when the plan opens or a card appears, so the last message always clears the
lot.

The plan is whatever the last successful `todo_write` call sent (`tools.md`).
`chat.ts` finds that call, live when its result arrives and in a replayed
transcript, and hands the list to `PlanView` through the chat host's `plan`
callback. Folded, the plan is one line: a ring that fills as steps complete,
the count, and the step under way. While a turn runs that step shimmers; with
nothing in progress the line names the next step in a quieter colour, and at
the end it says every step is done. Opened, it lists every step with a mark
for its state, and a long plan scrolls inside its own box with the live step
kept in view. The fold state is kept in `localStorage`. The close button puts
the plan away until the agent writes a new one. Sending a message puts away a
plan that is finished, and a finished plan read back from a stored session
starts put away. A subagent's plan stays in its own view as tool cards.

A `todo_write` card in the flow opens to the checklist it sent, drawn with the
same marks, in place of the JSON arguments and the result that repeats them.
An `ask_user` card shows the headers of its questions beside the name.

A question from `ask_user` arrives as a `question.request` event and rings the
same way a permission prompt does. It is shown only when its session is on
screen, and waits for that session to be opened: the agent asked because it
cannot go on without the answer, so it is never refused on the user's behalf.
A turn that finishes or is stopped takes its questions away, since the main
process has already settled them. A `session.error` does not, because a fault
can be reported in the middle of a turn that goes on waiting for its answer.
Deleting a session stops its turn first, which settles the question the same
way. Picks made on a card are kept when the user opens another session and
comes back.

The card shows one question at a time, with a tab per header when a call asks
several; a tab gets a tick once it is answered. Each option is a row with its
number key, its label and its description. On a single-choice question a click
or the number key picks the row and moves on to the next unanswered question,
and the last pick sends the lot. Tick boxes take clicks, number keys or Space,
and Enter or the button moves on. The last row is always a field for an answer
in the user's own words; typing there replaces a single-choice pick. Arrow keys
move between rows and tabs, Escape or Dismiss closes the card unanswered, and
the agent is told the user did not answer. The card takes the keyboard when it
appears only if nothing else has it, so a keystroke meant for the draft or for
an open sheet never picks an option, and hands it to the composer when the
last question is answered.

## Markdown

What the model writes is drawn from its Markdown: an assistant block in the
live flow and in a replayed transcript, and the summary a compaction leaves.
`markdown.ts` covers what models actually write. That means headings, paragraphs,
bullet, numbered and task lists nested by indent, quotes, rules, pipe tables
with column alignment, and fenced code. Inline, it covers emphasis, strike,
code spans, links, bare URLs and backslash escapes. Setext headings, indented
code blocks and reference links are left out. Models rarely write them, and an
indented line read as code would swallow a list's continuation.

The renderer builds elements and text nodes and never assigns `innerHTML`, so
HTML in an answer is shown as the characters it is made of. A link to `http` or
`https` opens in the user's browser through the same `openExternal` call the
rest of the window uses. Any other address is drawn as text, with the address in
its tooltip, so the model cannot make a click reach a `file:` or `javascript:`
URL. An image is drawn as a link to its address, labelled with its alt text or
with "image" when it has none, because the CSP loads nothing from outside the
app.

A fenced block carries its language and a copy button above the code. The code
is coloured by `highlight.ts`, which knows a keyword, a string, a comment, a
number and a call for each language family it has a grammar for. A language it
does not know is shown plain. A `diff` or `patch` fence is drawn as diff rows.

While an answer streams, it is redrawn at most once per animation frame.
Everything up to the last blank line outside a fence is settled, since more
text cannot change how it is drawn, so it is drawn once and kept. Each frame
parses only the part after it, which keeps a long answer as cheap as a short
one and leaves a selection or a scrolled table in the settled part alone. A
fence that has not closed yet is drawn as code up to the end of the text, so
the block does not flicker between prose and code as it arrives. When the
answer ends it is drawn once more from the whole text, which joins a list that
a blank line had split while it streamed.

## Turns and rewind

`turns.ts` puts the session's checkpoints on screen and runs every rewind. The
mouse and the keyboard reach the same actions (`checkpoints.md` has what a
rewind does to the files and the history).

### Asking first

Each message the user sent is marked with its turn number. Hovering it, or
tabbing onto it, shows a Rewind button, and a right-click on it opens a menu
with the same rewind and a copy of the message. Rewind changes nothing yet. It
opens a card above the message that says what going back to before that turn
would do, and dims every block that would leave the screen.

The card offers three ways back: the conversation and the code, the
conversation only, and the code only. The code only is greyed out when no file
changed with `edit` or `write` since the turn began. It starts on the way the
held rewind goes, or on both when nothing is held or when that way is the code
only and this turn has no files. Under the choice it says how
many turns go and lists the files that come back, six of them and a count of
the rest. It says that the message goes back into the composer, and that
commands the agent ran and changes made outside the app are not put back.

The Rewind button has the focus when the card opens. Its keys:

| Key | Does |
|---|---|
| ← →, or 1 2 3 | pick the way back |
| Enter | rewind |
| Esc | close the card and change nothing |

Esc on the card is caught before the composer sees it, so closing the card
does not count toward the double press that opens the turn index. An open menu
takes the Esc first.

After a rewind the focus goes to the composer when the message went back into
it. When the rewind hid what had the focus, it goes to Undo, or after Undo to
the composer.

### Held

A confirmed rewind puts the files back at once and holds. The turns it took
back leave the screen, and a bar at the end of what is left says what went
back and has an Undo button. A code rewind leaves the turns in place, since
the conversation stays. When the conversation went back, the turn's message
goes into the composer, which takes the focus, unless the user has typed
something of their own there; Undo takes it out again. While a rewind is held,
Rewind on an earlier turn opens the card again and moves the held rewind there
once confirmed.

Sending the next message keeps the rewind, as does a compaction started from
the context panel, and the window reopens the session once that is done. The
turns a sent message took back stay hidden until the session's list is read
again after the turn. They come back if the message was refused before its turn
began, since the rewind is then still held.

A rewind holds the session the way a turn does. The turn buttons and Undo are
dimmed until it is done, and any other rewind asked for in the meantime is
dropped. The window does not reload the session after a rewind. It redraws the
turns from what it already has.

### The turn index

A column of marks sits beside the flow's scrollbar, one per turn in sight,
evenly spaced so each is as easy to hit as the next. A turn that changed files
has a darker mark, and the turn being read is lit. The turn being read is the
last one whose message starts above a line near the top of the view, or the
last turn once the flow is scrolled to the end, and it is worked out on every
scroll event by a binary search over the messages, so the lit mark never lags
the flow. When there are more marks than fit, the column scrolls to keep the lit
one in the middle. A session with one turn shows no marks.

Resting the pointer on the column for a moment opens the list beside it: one
row per turn with its number, message, age and how many files it changed. The
row under the pointer's mark is highlighted, a click on a mark or a row scrolls
to that turn and outlines it, and the ↺ on a row opens the rewind card. The
list closes a moment after the pointer leaves it.

Esc twice within half a second, over an empty composer between turns, opens
the same list for the keyboard, with a filter and a line of keys. The composer
has to be empty so a stray double press cannot cost a draft, and while a turn
runs Esc stops it instead. A held Esc repeats and does not count as a second
press, and nothing opens while a subagent's conversation is on screen. The
list opens on the turn being read, and moving the selection scrolls the flow to
that turn at once, so it doubles as a way to scroll back. Its keys:

| Key | Does |
|---|---|
| ↑ ↓, j k | move one turn |
| PageUp, PageDown | move eight turns |
| Home, End | oldest, newest |
| Enter | close and stay at the turn |
| Esc | in the filter with text in it, clear it; otherwise close and scroll back to where the flow was |
| / | filter by the message text or the turn number |
| r | open the rewind card for the turn |

Closing it gives the focus back to what had it. Moving the focus out of the
list closes it where it is.

Alt+↑ and Alt+↓ work anywhere in the window while no sheet is open and no text
field with text in it has the focus, where Alt and an arrow move the caret.
They jump to the start of the turn before or after the one being read; partway
down a turn, Alt+↑ goes to its start first.

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
because the alternative is a menu item that does nothing and says nothing.

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

## Pictures

A picture pasted into the composer, or a file dropped on it, is attached to the
draft as a chip above the text: a thumbnail, its name and a button that takes it
off again. A paste that carries text as well, as a copy from a document can,
attaches the picture and puts the text in the draft. The chips are named
Image #1, Image #2 and so on in the order the model receives them, so "Image
#2" in the text is the second picture the model gets. Taking one off renumbers
the rest. A message may be pictures alone.

With **Shrink images before sending** on, which it is until someone turns it
off, a picture with an edge over 1,568 pixels, or more than about 1.15 million
pixels in all, is drawn again at that size. Models commonly scale a larger
picture down to about that on their own side (plan §15), so the pixels past it
cost upload time, and tokens on the wires that bill by area, and show the model
nothing more. A JPEG is written again as a JPEG, anything else as a PNG. A
format no wire takes, a BMP say, is drawn again as a PNG at its own size either
way. The switch is read at each paste, so turning it off does not change a
picture already attached.

Twenty pictures fit on one message and each may be up to 10 MB. The main
process holds the same two limits (`sessions.md`), and the composer checks them
when a picture is attached, so one over them is turned away with a line under
the draft and never costs the user a message. A model marked in settings as
taking no images is refused the same way at Send, with the draft left where it
is. A model nobody has described is sent the picture, and the provider answers.
A picture still being read when Send is pressed goes with the message.

The sent message draws its pictures over its words, small, with the size in
the tooltip. The page's content security policy lets images load from `data:`
URLs and from nowhere else outside the app.

## Keys pasted into the chat

A key in a message is taken out of it before the window draws it: the composer
sends the text through `captureSecrets`, and what appears in the flow, in the
transcript and in the prompt is a `{{secret:name}}` reference. A note in the
flow says which references were made, once, so the user knows the key was
caught and not eaten. **Settings › Secrets** lists what the vault holds, names
and vendors and never values, which do not cross the bridge even here, and
offers to forget any of them. `secrets.md` has the rest of it, including why
the model never sees the value.

## Tokens

`renderer.css` is three layers, and nothing skips one:

1. ramp: `--nh-warm-*` (a warm neutral in eighteen steps, the hue the mark is
   drawn in), `--nh-accent-*` terracotta, and green/red/amber for state. Raw
   colour, never touched by a component.
2. alias: `--nh-bg-*`, `--nh-border-*`, `--nh-label-*`, `--nh-button-*`,
   `--nh-state-*`, and `--nh-part-*` for the parts of the context. What a
   colour is *for*. The only layer that names intent.
3. components: read alias tokens and nothing else.

There is one set of alias values, because the app is dark and only dark (plan
section 3). The layer still earns its keep with one theme:
a rule that reads `--nh-label-tertiary` says what the colour is for, which a hex
code never does, and the ramp underneath keeps the greys on one hue. Alongside
the colour sits the rest of the vocabulary: one easing curve and three
durations, so no animation invents its own timing; a 4px spacing scale; four
corner radii, one per kind of surface; mono for the transcript and sans for
chrome.
