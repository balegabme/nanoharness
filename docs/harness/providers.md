# Providers

A provider turns a ChatInput (messages + tools) into a stream of ChatChunk.
Step 1 ships the OpenAI-compatible provider.

Files:
- src/providers/openai.ts — OpenAI chat-completions streaming (SSE)
- src/core/provider.ts — interface
- src/core/config.ts — provider configuration: resolution, validation, env keys
- src/main/config-store.ts — settings on disk, key encrypted by the OS

## OpenAI provider

`POST {baseURL}/v1/chat/completions` with `stream: true` and
`stream_options: {"include_usage": true}` — without the second one OpenAI sends
no usage at all and every turn records zero tokens. Servers that do not know
the field ignore it. SSE lines
(`data: ...`), tool-call arguments arrive as fragments and are accumulated
per call index. Usage maps `prompt_tokens_details.cached_tokens` to
`cacheRead` and `completion_tokens_details.reasoning_tokens` to `reasoning`.

Key: passed via `Authorization: Bearer`.

## Configuration

Nothing about a vendor is compiled in. There is no default base URL, no default
model, and no fallback key: an incomplete configuration raises `ConfigError`
naming exactly what is missing, and the app opens its setup screen instead of
quietly talking to somebody's cloud.

The setup screen is the only way in. A provider has to be configured before
anything can run at all, so there is one place to configure it — no environment
variables shadowing what the screen shows, and nothing to export before the app
is usable. `resolveConfig` (`src/core/config.ts`) reads what was saved:

| file | holds |
|---|---|
| `<user-data>/config.json` | `baseURL`, `model`, `models` |
| `<user-data>/credentials.bin` | the API key, encrypted by the OS |

The base URL must be an absolute `http(s)` URL; trailing slashes are stripped so
`${baseURL}/v1/...` never doubles up.

The settings file is **secret-free by schema** (plan §16) — `StoredConfig` has
no `apiKey` field at all, so it can be read, copied or pasted into an issue
without leaking anything. The key lives in its own file, encrypted through
Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on
Linux). Where the OS has no such store, the app refuses to save a key rather
than falling back to plaintext. Neither file is ever written to the repo.

`models` is the allowlist the user ticked in setup. Saving refuses an active
model that is not on it, so a session can only ever run something chosen on
purpose. An empty list means no list — the model is whatever `model` says, which
is how a proxy without `/v1/models` still works.

Saving new settings retires the live sessions, so the next turn is built
against the new endpoint rather than the one the window started with.

## Listing models

`listModels` calls `GET {baseURL}/v1/models` and returns sorted, de-duplicated
ids. The setup screen uses it for both its buttons: reaching the endpoint at all
is the connection test, and the ids are the model picker. A 404 is reported as
"this server has no model list" rather than as a failure, because plenty of
OpenAI-compatible proxies do not implement it. Failures come back as values, not
exceptions — a typo in a URL is an expected outcome of a settings screen — and
an unreachable host is named with its address and error code instead of Node's
bare `fetch failed`.
