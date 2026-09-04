# Harness core overview

The core runs in the Electron main process (pure TypeScript, no sidecar).
Everything the harness does is a typed event on the bus; the renderer
(step 5) is only a renderer of those events.

Files:
- src/core/types.ts — shared types: events, usage, messages, tools
- src/core/event-bus.ts — EventBus: emit + subscribe
- src/core/session.ts — one session loop: provider stream, tool rounds, usage
- src/core/usage-log.ts — append-only usage record in the OS user-data dir
- src/main/index.ts — Electron entry, typed IPC wiring
- src/ipc/contract.ts — IPC channel names and payloads

The provider contract (`src/core/provider.ts`) is documented in
`providers.md`.

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
`session:send` runs a turn; every event the session emits during the run is
streamed live to the caller over `session:event` (typed `AppEvent` payloads,
each with an `at` timestamp), and the invoke reply carries the session id and
final usage. There is no HTTP listener in v1. The IPC layer is dormant until
step 5 brings the renderer; until then sessions can be driven headlessly.