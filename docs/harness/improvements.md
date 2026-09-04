# Improvements

Flaw and improvement ledger (plan §4 rule 5). The `log_improvement` tool
appends entries under dated headings; the harness-editor ticks one off with a
ref once it is fixed.

In this repo the ledger is this file. In any other workspace it is
`.nanoharness/improvements.md` — the installed package directory is never
written to.

## 2026-09-04

- [x] The OpenAI request omits `stream_options: {"include_usage": true}`, so real OpenAI never sends the final usage chunk and every recorded turn reads as zero tokens. (fixed: src/providers/openai.ts)
- [x] `nh doc-check` reported "no problems" when the target had no `src/` or `docs/harness/` at all, so a wrong path would pass the CI gate. (fixed: src/cli/doc-check.ts)
- [x] A failed usage-log write rejected the whole IPC turn after the model had already answered. (fixed: src/main/index.ts)
- [x] The `nh` CLI had no top-level error handling, so any throw surfaced as an unhandled rejection. (fixed: src/cli/index.ts)
- [x] A bash command killed by the 60s timeout reported `exit code ?` instead of saying it timed out. (fixed: src/tools/bash.ts)
- [x] The README claimed Anthropic support "from day one" when no Anthropic provider exists. (fixed: README.md)
- [ ] The provider has no request timeout and no retry: a hung connection hangs the session with no way out except quitting the app. Needs a stall deadline on the SSE reader plus backoff on 429 and 5xx — src/providers/openai.ts.
- [ ] There are no tests, and `vitest --passWithNoTests` keeps CI green anyway, so the badge on a public README currently proves only that the code compiles. Plan §16 names the strategy: recorded fixtures for the SSE and schema translation layers, smoke tests against a mock provider.
- [ ] Running out of `maxToolRounds` emits `session.finished` like a normal completion. The last round's tool results are never sent back to the model and nothing tells the user the turn was cut short — src/core/session.ts.
- [ ] `parseWire` assigns `JSON.parse` straight into a typed variable, so a malformed provider payload is trusted rather than rejected — src/providers/openai.ts.
- [ ] An unknown tool name returns a result without `isError` or `content`, unlike every other error path in the loop — src/core/session.ts.
- [ ] `usage.jsonl` grows without bound. It needs rotation or a size cap before long-running installs accumulate years of turns — src/core/usage-log.ts.
- [ ] `pnpm start` launches Electron with no window, and because no window ever opens, `window-all-closed` never fires and the app cannot quit on its own. Expected until the renderer lands (build step 5), but the README should say so.
- [ ] The preload ships as an ES module, which forces `sandbox: false` on the window. Building it as CommonJS instead would let the sandbox go back on; context isolation covers the bridge either way — src/main/window.ts.
- [ ] Main and renderer share one tsconfig, so `lib` carries DOM types into main-process code that has no business using them. Split the two once the renderer grows — tsconfig.json.
- [ ] The `read` tool's `offset` is a zero-based line index and the tool description does not say so, so a model that thinks in line numbers reads one line off — src/tools/read.ts.
