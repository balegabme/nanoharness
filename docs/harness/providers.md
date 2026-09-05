# Providers

A provider turns a ChatInput (messages + tools) into a stream of ChatChunk.
Two wire formats ship: OpenAI-compatible and Anthropic-compatible. Neither is a
vendor. "OpenAI-compatible" means a server that answers `/chat/completions` the
way OpenAI documents it; "Anthropic-compatible" means one that answers
`/messages` the way Anthropic documents it. Which company runs it is not the
harness's business, and no vendor address is compiled in anywhere.

Files:
- src/providers/openai.ts — OpenAI chat-completions streaming (SSE)
- src/providers/anthropic.ts — Anthropic messages streaming (named SSE events)
- src/providers/factory.ts — the one place a provider kind becomes a client
- src/core/provider.ts — interface
- src/core/config.ts — the provider registry: records, effort, resolution, validation
- src/main/config-store.ts — settings on disk, keys encrypted by the OS

## OpenAI provider

`POST {baseURL}/chat/completions` — see [base URLs](#base-urls) for where the
version segment comes from — with `stream: true` and
`stream_options: {"include_usage": true}` — without the second one OpenAI sends
no usage at all and every turn records zero tokens. Servers that do not know
the field ignore it. SSE lines
(`data: ...`), tool-call arguments arrive as fragments and are accumulated
per call index. Usage maps `prompt_tokens_details.cached_tokens` to
`cacheRead` and `completion_tokens_details.reasoning_tokens` to `reasoning`.

Key: passed via `Authorization: Bearer`. Effort rides as `reasoning_effort`,
left out entirely at `none`, because which values a family accepts varies and an
unknown one either 400s or is silently dropped.

Thinking has no standard field on this wire. DeepSeek and vLLM send
`reasoning_content`, OpenRouter sends `reasoning`, OpenAI itself sends neither;
all the known spellings are read, and the thinking block simply stays empty
against a server that streams none.

## Anthropic provider

`POST {baseURL}/messages`, with `anthropic-version: 2023-06-01`.

That header is not a "latest" marker that ought to be bumped. It names the
request and response **format**, and every request must carry one; `2023-06-01`
is the version the Messages API documents, and the only one this code speaks.
Changing the string changes the wire contract, so it is pinned rather than
derived from a date or a package version.

The key goes out as both `x-api-key` and `Authorization: Bearer`. Anthropic's
own API reads the first; several Anthropic-compatible gateways read the second
(it is the same token Claude Code passes as `ANTHROPIC_AUTH_TOKEN`). Sending
both means the endpoint's convention does not have to be guessed at.

Five differences matter, and each is handled at the boundary rather than
leaking into the session loop:

- **`max_tokens` is required.** It is derived from the effort, because a
  thinking budget has to stay strictly below it.
- **The system prompt is a top-level field**, never a message.
- **Tool results are `tool_result` blocks on a user message**, and consecutive
  results merge into one message, because the API wants alternating roles.
- **Events are named** (`message_start`, `content_block_*`, `message_delta`),
  usage arrives in two halves, and tool arguments stream as `input_json_delta`
  fragments that are concatenated and parsed once at `content_block_stop`.
- **Thinking blocks are signed and must come back.** When a turn uses tools, the
  next request has to carry the assistant's `thinking` blocks — text plus the
  `signature` that arrived on `signature_delta` — ahead of the text and
  `tool_use` blocks, in the order they were produced. The API verifies the
  signature and rejects an edited, reordered or missing block. `redacted_thinking`
  blocks are encrypted, unreadable here, and passed back untouched. So thinking
  is collected whole (`ChatChunk` gains `thinking_block`), stored on the
  assistant message, and replayed on the wire — not merely streamed to the
  screen and dropped.

## Effort

One neutral scale — `none`, `low`, `medium`, `high` — because the two wires
express the same idea in different units. The mapping is not invented; each side
uses the field its own API documents:

| effort | OpenAI-compatible | Anthropic-compatible |
|---|---|---|
| `none` | `reasoning_effort` omitted | no `thinking` field |
| `low` | `reasoning_effort: "low"` | `thinking.budget_tokens: 4096` |
| `medium` | `reasoning_effort: "medium"` | `thinking.budget_tokens: 16384` |
| `high` | `reasoning_effort: "high"` | `thinking.budget_tokens: 32768` |

`reasoning_effort` is passed through as the same word the API takes. Newer
families accept more values than these four (`minimal`, `xhigh`), older ones
accept none at all; the ledger holds the per-family allow-list plan §11 asks
for. Anthropic has no effort word — it takes a token budget — so the four levels
become budgets. The floor is the API's own: a budget must be at least 1,024
tokens and strictly below `max_tokens`, which is why `max_tokens` is derived
from the budget rather than set independently.

## Configuration

Nothing about a vendor is compiled in. There is no default base URL, no default
model, and no fallback key: an incomplete configuration raises `ConfigError`
naming exactly what is missing, and the app opens its setup screen instead of
quietly talking to somebody's cloud.

The settings screen is the only way in. A provider has to be configured before
anything can run at all, so there is one place to configure it — no environment
variables shadowing what the screen shows, and nothing to export before the app
is usable. `resolveConfig` (`src/core/config.ts`) reads what was saved:

| file | holds |
|---|---|
| `<user-data>/config.json` | the provider records and the active selection |
| `<user-data>/credentials.bin` | every API key, encrypted by the OS, indexed by provider id |

A **provider record** is `{id, name, kind, baseURL, models}` — as many as the
user wants, mixing kinds freely: a local vLLM, an OpenRouter key, z.ai and an
Anthropic account side by side. The **active selection** is
`{providerId, model, effort}`: which of them a turn actually runs, switchable
from the header without opening settings.

### Base URLs

The base URL must be an absolute `http(s)` URL; trailing slashes are stripped.

The two ecosystems disagree about who owns the version segment. OpenAI clients
take a base that already ends in it (`https://api.deepseek.com/v1`,
`https://api.z.ai/api/paas/v4`), Anthropic clients take one without it and add
`/v1` themselves (`https://api.z.ai/api/anthropic`). People paste whichever
their provider's page showed them, so `endpointURL` adds the version only when
the base does not already end in one:

| pasted | reaches |
|---|---|
| `https://api.deepseek.com/v1` | `https://api.deepseek.com/v1/chat/completions` |
| `https://api.deepseek.com` | `https://api.deepseek.com/v1/chat/completions` |
| `https://api.z.ai/api/paas/v4` | `https://api.z.ai/api/paas/v4/chat/completions` |
| `https://api.z.ai/api/anthropic` | `https://api.z.ai/api/anthropic/v1/messages` |

What does **not** belong in the field is the endpoint path itself: the base ends
before `/chat/completions` or `/messages`. The settings screen says so under the
field, with examples for the kind that is selected.

A settings file written by the single-provider version is migrated on read: its
`baseURL`, `model` and `models` become one record under the id `legacy`, which
is also the id its stored key is found under, so an existing install keeps
working without anything being retyped.

The settings file is **secret-free by schema** (plan §16) — `StoredConfig` has
no `apiKey` field at all, so it can be read, copied or pasted into an issue
without leaking anything. The key lives in its own file, encrypted through
Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on
Linux). Where the OS has no such store, the app refuses to save a key rather
than falling back to plaintext. Neither file is ever written to the repo.

`models` is the allowlist the user ticked for that provider. Saving refuses an
active model that is not on it, so a session can only ever run something chosen
on purpose. An empty list means no list — the model is whatever is typed, which
is how a proxy without `/v1/models` still works.

Every settings write retires the live sessions, so the next turn is built
against the new endpoint, model or effort rather than the one the window
started with.

## Listing models

`listModels` calls `GET {baseURL}/models` — the same path on both wires, each
with its own auth headers, and the same version rule as every other endpoint —
and returns sorted, de-duplicated ids. The settings
screen uses it for both its buttons: reaching the endpoint at all
is the connection test, and the ids are the model picker. A 404 is reported as
"this server has no model list" rather than as a failure, because plenty of
OpenAI-compatible proxies do not implement it. Failures come back as values, not
exceptions — a typo in a URL is an expected outcome of a settings screen — and
an unreachable host is named with its address and error code instead of Node's
bare `fetch failed`.
