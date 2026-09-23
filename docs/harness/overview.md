# Harness core overview

The core runs in the Electron main process (pure TypeScript, no sidecar).
Everything the harness does is a typed event on the bus; the renderer
(step 5) is only a renderer of those events.

Files:
- src/core/types.ts: the shared types for events, usage, messages and tools
- src/core/event-bus.ts: the EventBus, emit and subscribe
- src/core/session.ts: one session loop, the provider stream, tool rounds and usage
- src/core/usage-log.ts: append-only record of what each turn spent, in the OS user-data dir
- src/core/roots.ts: workspace root vs harness root, and the harness-editor cwd
- src/main/index.ts: Electron entry, typed IPC wiring
- src/ipc/contract.ts: IPC channel names and payloads

The provider contract (`src/core/provider.ts`) is documented in
`providers.md`; how a provider is configured is documented there too.

## Two roots

A session has a workspace, the project it is working on, which is its `cwd`.
The harness has a root, the nanoharness install itself. They
are different directories and `src/core/roots.ts` is the only place that knows
how to find either.

The distinction matters most for the harness-editor agent (plan §5). It edits
the harness, not the user's project, so it runs with `harnessEditorCwd()` as
its cwd no matter which workspace it was summoned from. That call also refuses
to hand back a packaged install: an app bundle has no `src/` to edit and is
never written to (plan §4 rule 5), so a harness-editor job asks for a source
checkout and never edits files inside the bundle. The improvement ledger uses
the same test: `isHarnessRepo(cwd)` decides between the repo's
`docs/harness/improvements.md` and a workspace's `.nanoharness/`.

## Session loop

`Session.run(userText)` emits `session.started`, appends the user message,
streams a provider turn, emits `usage`, and if the model called tools it
executes them and repeats until no tool calls remain. The calls of one message
run in the model's order; a run of tools that declared themselves read-only
starts together (`executeTools`), because the wait was already paid for once.
The assistant message (with its tool calls) is kept in history so later turns
see it, unless the round produced nothing at all, no text, no tool call, no
thinking, which is not a message and is not written down. Provider or harness
failures emit `session.error` and rethrow.

There is no round budget. A cap is the harness deciding that a long task is a
bug, and what it produces is a turn that ends mid-investigation with no answer
and nothing on screen to say why. What is caught instead is a model going in
circles, which is detectable: the same tool with the same arguments, over and
over. The third identical call is not run (the answer is the one it already
has) and the model is told so; if it keeps asking, the turn ends with a note
that says exactly that happened. Five failed calls in a row appends a line to
the result saying so, which nudges without stopping the turn: debugging is
mostly failures.

Every way a turn can end that is not an answer now says so in the window and in
the session file. `Session.note(text)` emits `session.note` and records a
`SessionNote`; a stop and an error record one without an event, because the
window is already being told about those another way. `notes` is what gets
persisted alongside the transcript, and `restoreNotes()` puts them back when the
session is rebuilt; see `sessions.md`.

## Usage accounting

Every round emits a `usage` event with input/output/cacheRead/cacheWrite/
reasoning totals. The values are cumulative for the session's run (a renderer
that wants per-round deltas can diff consecutive events).

`input` means prompt tokens the provider read in full, with anything served
from cache counted under `cacheRead` instead, and `reasoning` is a breakdown of
`output` and not a sixth number. The two wires report neither of those the
same way, so both are normalized at the provider boundary; `providers.md` has
which wire sends what.

The event also carries `streamMs`: how long the model spent generating that
round, first chunk to last. It is there because the window shows a tokens-per-
second rate and the renderer cannot tell generating from waiting on a tool. A
subagent's usage arrives with no `streamMs`, since those tokens came off a
stream this session never timed.

A turn that delegates also carries `subagent`, the part of the same totals that
subagents of this session spent. It is a share of `usage` and not an addition to
it, so the two are never summed; the window shows it as a `by agents` pill, and
the stored session keeps it beside the total so a session opened a week later
still knows which of its output it wrote itself.

Each completed turn is also appended to `usage.jsonl` in the OS user-data dir,
never the repo. The line says which folder, session, agent and model spent it,
the two shares inside the total, and what each of those came to in dollars at
the prices the model carried at the time. It stores no names: folders get
renamed and sessions get deleted, so ids are what a line keeps and names are
resolved when it is read.

The line is stamped with a schema version and a build reads only its own, since
there is no converting a line that predates a change in what a field means. The
project is pre-1.0 and the log is a record and not a database, so a bump skips
the old lines and counts them, with no migration.

Reading it back is `cost.md`: one report, drawn by the window and printed by
`nh usage`. `clearUsage` deletes the file, which is what the spend view's Clear
button does. Nothing archives it first and nothing keeps a second copy, so a
cleared log is gone.

## IPC

Renderer talks to the main process over typed channels (`src/ipc/contract.ts`).
`config:get` reports whether a session can start at all and lists the configured
providers. `config:save-provider`, `config:delete-provider` and
`config:set-active` change them: the first two edit the registry, the third
switches provider, model or effort from the header. A write that changes what a
running session was built from retires it, so the next turn picks up the
change. `config:probe` asks an endpoint what it offers, which doubles as the
connection test.

`workspace:list`, `workspace:add` and `workspace:remove` are the folders in the
sidebar; `session:create`, `session:open` and `session:delete` are the
conversations inside them, and `session:open` returns the stored transcript
(see `sessions.md`). `session:send` runs a turn for one session id; every event
the session emits during the run is streamed live to the caller over
`session:event` (typed `AppEvent` payloads, each with an `at` timestamp), and
the invoke reply carries the usage and the session as it now stands, since the
first message names it.

Two of those events flow the other way in spirit. `permission.request` is
emitted when a tool reaches outside the session folder or wants to run a shell
command, and the turn stays parked until the renderer answers it over
`permission:respond`. `project.trust` is emitted when a project's hooks file or
`mcp.json` has not been approved, and the session build waits for the answer
over `project:trust-respond`. There is no HTTP listener in v1, and a session
can still be driven headlessly without a window, though a gate with nobody to
ask refuses the shell.