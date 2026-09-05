# Harness core overview

The core runs in the Electron main process (pure TypeScript, no sidecar).
Everything the harness does is a typed event on the bus; the renderer
(step 5) is only a renderer of those events.

Files:
- src/core/types.ts — shared types: events, usage, messages, tools
- src/core/event-bus.ts — EventBus: emit + subscribe
- src/core/session.ts — one session loop: provider stream, tool rounds, usage
- src/core/usage-log.ts — append-only usage record in the OS user-data dir
- src/core/roots.ts — workspace root vs harness root, and the harness-editor cwd
- src/main/index.ts — Electron entry, typed IPC wiring
- src/ipc/contract.ts — IPC channel names and payloads

The provider contract (`src/core/provider.ts`) is documented in
`providers.md`; how a provider is configured is documented there too.

## Two roots

A session has a **workspace** — the project it is working on, which is its
`cwd` — and the harness has a **root**, the nanoharness install itself. They
are different directories and `src/core/roots.ts` is the only place that knows
how to find either.

The distinction matters most for the harness-editor agent (plan §5). It edits
the harness, not the user's project, so it runs with `harnessEditorCwd()` as
its cwd no matter which workspace it was summoned from. That call also refuses
to hand back a packaged install: an app bundle has no `src/` to edit and is
never written to (plan §4 rule 5), so a harness-editor job asks for a source
checkout rather than silently editing files inside the bundle. The improvement
ledger uses the same test — `isHarnessRepo(cwd)` decides between the repo's
`docs/harness/improvements.md` and a workspace's `.nanoharness/`.

## Session loop

`Session.run(userText)` emits `session.started`, appends the user message,
streams a provider turn, emits `usage`, and if the model called tools it
executes them and repeats until no tool calls remain (bounded by
`maxToolRounds`). The assistant message (with its tool calls) is always kept
in history so later turns see it. Provider or harness failures emit
`session.error` and rethrow.

## Usage accounting

Every round emits a `usage` event with input/output/cacheRead/cacheWrite/
reasoning totals. The values are cumulative for the session's run (a renderer
that wants per-round deltas can diff consecutive events). Cached-token fields
come from the provider (step 1 already carries cache fields from turn one).

Each completed turn is also appended to `usage.jsonl` in the OS user-data dir,
never the repo. `nh usage` reads it back — see `cli.md`.

## IPC

Renderer talks to the main process over typed channels (`src/ipc/contract.ts`).
`config:get` reports whether a session can start at all and lists the configured
providers. `config:save-provider`, `config:delete-provider` and
`config:set-active` change them — the first two edit the registry, the third
switches provider, model or effort from the header — and each retires the live
sessions so the next turn picks up the change. `config:probe` asks an endpoint
what it offers, which doubles as the connection test.

`workspace:list`, `workspace:add` and `workspace:remove` are the folders in the
sidebar; `session:create`, `session:open` and `session:delete` are the
conversations inside them, and `session:open` returns the stored transcript
(see `sessions.md`). `session:send` runs a turn for one session id; every event
the session emits during the run is streamed live to the caller over
`session:event` (typed `AppEvent` payloads, each with an `at` timestamp), and
the invoke reply carries the usage and the session as it now stands, since the
first message names it.

One of those events flows the other way in spirit: `permission.request` is
emitted when a tool reaches outside the session folder, and the turn stays
parked until the renderer answers it over `permission:respond`. There is no HTTP listener in v1, and a session can still be driven
headlessly without a window.