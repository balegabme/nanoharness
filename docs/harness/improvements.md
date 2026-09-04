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
- [x] `pnpm start` launched Electron with no window, so `window-all-closed` never fired and the app could not quit on its own. (fixed: src/main/index.ts, src/renderer/index.html)
- [ ] The preload ships as an ES module, which forces `sandbox: false` on the window. Building it as CommonJS instead would let the sandbox go back on; context isolation covers the bridge either way — src/main/window.ts.
- [ ] Main and renderer share one tsconfig, so `lib` carries DOM types into main-process code that has no business using them. Split the two once the renderer grows — tsconfig.json.
- [ ] The `read` tool's `offset` is a zero-based line index and the tool description does not say so, so a model that thinks in line numbers reads one line off — src/tools/read.ts.
- [x] Settings could only be reached when they were broken; there was no way back into the setup screen to change the model or rotate the key. (fixed: src/renderer/index.ts — settings chip in the header)
- [ ] The key is encrypted with Electron `safeStorage`, not the OS credential store plan §11 asks for (Windows Credential Manager / Keychain / libsecret). safeStorage is DPAPI-backed on Windows and good enough to ship, but a key encrypted under one OS user cannot be read by another, and the failure is silent — setup simply asks again — src/main/config-store.ts.
- [x] Setup accepted any base URL and model without checking they exist. (fixed: src/providers/openai.ts, src/main/config-store.ts, src/renderer/index.ts — test connection plus a model list the user ticks). Capability warnings per model, the rest of plan §11, are still to come.
- [ ] Saving new settings retires the live sessions, but the transcript on screen still shows the old session's turns with no marker that history restarted — src/renderer/index.ts.
- [ ] `harnessEditorCwd()` exists and is tested by hand, but nothing calls it yet: the harness-editor agent itself is build step 3 — src/core/roots.ts.
- [ ] The model picker has no capability warnings. Plan §11 wants per-model checks — no vision, no tool use, no effort levels — from Anthropic `capabilities` or a one-token probe on OpenAI-compatible servers — src/renderer/index.ts.
- [ ] Switching the active model means opening settings and saving. The header chip shows the model but is not a picker, even though the allowlist is right there — src/renderer/index.ts.
- [ ] There is no electron-builder configuration yet, so the brand mark is the window icon but not the installer or executable icon — package.json.
- [ ] `Menu.setApplicationMenu(null)` also removes the accelerators that came with the default menu. Text editing is handled by Chromium so copy and paste still work, but a deliberate keyboard map (plan §13) has to register its own shortcuts — src/main/window.ts.
- [ ] With the environment variables gone, a machine whose OS has no secret store (Linux without libsecret) cannot save a key at all, so the app is unusable there. It needs a real fallback — an OS-agnostic encrypted store or an explicit, clearly labelled plaintext opt-in — rather than a refusal — src/main/config-store.ts.
- [ ] Nothing can configure a provider without the GUI, so headless runs and CI have no way in. A `nh config` subcommand writing the same files is the missing half — src/cli/index.ts, src/main/config-store.ts.
