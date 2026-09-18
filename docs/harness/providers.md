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
- src/providers/model-facts.ts — what a `/models` answer says about each model, where it says anything
- src/core/cost.ts — what a run of tokens came to, at one model's prices

## OpenAI provider

`POST {baseURL}/chat/completions` — see [base URLs](#base-urls) for where the
version segment comes from — with `stream: true` and
`stream_options: {"include_usage": true}` — without the second one OpenAI sends
no usage at all and every turn records zero tokens. Servers that do not know
the field ignore it. SSE lines
(`data: ...`), tool-call arguments arrive as fragments and are accumulated
per call index.

### Usage on this wire

Two of the numbers this wire sends are totals that already contain a smaller
number sent beside them, and reading either as a separate figure counts those
tokens twice.

`prompt_tokens` is the whole prompt, cached part included, so the cached count
is subtracted out and `input` records only what the server had to read in full.
Left in, every cached token landed in `input` and in `cacheRead` both, which
doubled the denominator of the cache hit rate and capped the displayed figure at
50%. A prompt that was 90% cached showed as 47.4%. Anthropic's wire reports the
uncached part directly, so this is the one place the two have to be brought into
line, and `input` means the same thing afterwards.

`completion_tokens` already contains the reasoning tokens, so `reasoning` is a
breakdown of `output` rather than a sixth figure to add to it.

The cached count has two spellings. The documented one is
`prompt_tokens_details.cached_tokens`; some servers send
`prompt_cache_hit_tokens` at the top level instead, with
`prompt_cache_miss_tokens` beside it. Both are read, the documented one
first. A usage report that arrives without its two totals, or
with more cached tokens than prompt tokens, is rejected rather than smoothed
over: the session keeps the answer and records one fault saying the turn's cost
is unknown. Capping the count or defaulting it to zero would put a number true
under nothing into the window and the append-only log, where an entry cannot be
repaired later.

Cache writes have no field here: this wire bills them at the ordinary input rate
and never names them, so `cacheWrite` stays 0 and only Anthropic ever reports
one.

Key: passed via `Authorization: Bearer`. Effort rides as `reasoning_effort`,
left out entirely at `none`, because which values a family accepts varies and an
unknown one either 400s or is silently dropped.

Thinking has no standard field on this wire. Servers that stream it send it as
`reasoning_content` or as `reasoning`, and the documented shape has neither;
both spellings are read, and the thinking block stays empty against a server
that streams none.

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
  and tool arguments stream as `input_json_delta` fragments that are
  concatenated and parsed once at `content_block_stop`.
- **Usage arrives in two halves**, and in the units the harness stores.
  `message_start` carries `input_tokens`, `cache_read_input_tokens` and
  `cache_creation_input_tokens`, and `message_delta` carries `output_tokens` at
  the end. `input_tokens` here is the uncached part of the prompt already, with
  nothing to subtract, which is the shape the OpenAI wire has to be converted
  into. This wire names cache writes, so `cacheWrite` is only ever non-zero on
  it. It reports no reasoning count, so `reasoning` stays 0 even on a turn that
  thought: the thinking tokens are inside `output_tokens` and are not broken
  out.
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

One neutral scale — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
— because the two wires express the same idea in different units. The mapping is
not invented; each side uses the field its own API documents:

| effort | OpenAI-compatible | Anthropic-compatible |
|---|---|---|
| `none` | `reasoning_effort` omitted | no `thinking` field |
| `minimal` | `reasoning_effort: "minimal"` | `thinking.budget_tokens: 1024` |
| `low` | `reasoning_effort: "low"` | `thinking.budget_tokens: 4096` |
| `medium` | `reasoning_effort: "medium"` | `thinking.budget_tokens: 16384` |
| `high` | `reasoning_effort: "high"` | `thinking.budget_tokens: 32768` |
| `xhigh` | `reasoning_effort: "xhigh"` | `thinking.budget_tokens: 49152` |
| `max` | `reasoning_effort: "max"` | `thinking.budget_tokens: 65536` |

`reasoning_effort` is passed through as the same word the API takes; `none`
leaves the field out. No model takes all six words: families differ, and a value
a model does not know comes back as a 400 or is dropped without a word. Which ones a model does take is a fact about
that model, so it is read from the endpoint and kept per model rather than
guessed from the id — see [Model facts](#model-facts).

Anthropic has no effort word — it takes a token budget — so the levels become
budgets. The floor is the API's own: a budget must be at least 1,024 tokens and
strictly below `max_tokens`, which is why `max_tokens` is derived from the budget
rather than set independently. The four original levels kept their budgets when
the scale was widened, so a session that ran at `medium` still thinks exactly as
hard as it did.

The top two levels want more output than several Claude models will produce, so
the request is fitted to the model's own ceiling where anyone has said what it is
(`maxOutput`, below). `max_tokens` never exceeds it; the budget keeps the answer
its 8,192 tokens where the ceiling is roomy enough, splits the ceiling in half
where it is not, and drops to no thinking at all where half is under the API's
floor. A model nobody has described is asked the way it always was, and a model
that wants less says so in the error.

## Model facts

Three things about a model are worth knowing before a turn runs on it: which
effort levels it takes, what it charges, and the most output it will produce.
`readFacts`
(`src/providers/model-facts.ts`) reads both out of the `/models` answer, and
`ModelFacts` in `src/core/config.ts` is what comes back. Prices are stored as US
dollars per million tokens, because that is the unit vendors quote; every wire
that carries a price sends dollars per token, and the multiplication happens
once, here.

There is no standard for any of this. The two documented answers carry an id, an
owner, a timestamp and sometimes a display name, and nothing about money or
thinking. Servers that do answer those questions each picked their own field
names, so the reader knows every spelling anyone has been seen to use:

| shape | prices | effort levels | ceiling |
|---|---|---|---|
| a `capabilities` block | — | `capabilities.effort.<level>.supported` | `max_tokens` |
| a `pricing` block | `pricing.prompt`, `.completion`, `.input_cache_read`, sometimes as strings | — | — |
| reasoning metadata | — | `metadata.reasoning.supported_efforts` | — |
| per-token costs | `model_info.input_cost_per_token` and friends, or the same names at the top level | — | — |

A `capabilities` block is the one shape that states the levels outright, so it
is read first. `none` is added to whatever it names, because on that wire the
level is the thinking block left out of the request and no model needs
permission for that; `minimal` is not added, because it is a budget the list does
not mention and inventing it here is how a 400 arrives mid-turn. A model whose
`capabilities.thinking.supported` is false takes `none` and nothing else. A
`capabilities` block that says nothing about effort leaves the levels unknown,
which marks the model rather than guessing for it.

A field that only says whether a model reasons at all, as `supported_parameters`
does, is read by nothing: it never names the levels, and turning "reasons" into
a list of seven would be inventing the answer.

### When nothing describes a model

Most endpoints are in none of those rows. Asked directly, many answer with the
bare shape — an id, an object type, a timestamp, an owner — and nothing about
price or thinking. Nothing else is consulted when that happens. The harness
talks to the endpoints the user configured and to nothing else (plan §16), so a
third-party price list is not fetched behind their back, and a figure from one
would in any case be the published rate rather than what this key is billed:
the same model id at a subscription address and a pay-per-token address of one
vendor is two different prices.

A model no shape describes ends up with no facts, which is the common case and
not an error. The settings screen marks it, the composer keeps offering every
level, and the user can type the answer in: `overrides` on the provider record
holds what they typed, wins over the endpoint field by field, and survives the
next fetch. `resolveFacts` does that merge, so one wrong price corrected by hand
does not throw away an effort list the endpoint got right.

Fetching the models of a provider that is already saved stores what came back
straight away, key and URL having just been proved by the same call. The ticked
list, the prices and the effort levels are on disk before the user gets to the
Save button. A provider being typed in for the first time is left alone until
they press it.

A settings write that changes the active provider's record — its address, wire
kind, key or allowlist — or moves the active selection retires the live
sessions, which rebuild from the stored transcript on their next turn. A write
that touches another provider's fields, or one carrying nothing but prices and
effort levels, leaves them running: **Fetch models** makes that write on its
own, and a fetch must not end a turn running on a different endpoint. The next
session to be built reads what was learned.

Typing a different address or switching the wire holds the fetched facts and
the typed corrections out of the save, and `saveProvider` drops what the
endpoint that is gone had stored when it lands. A field put back before a fetch
takes them up again. They described the endpoint that used to be there, and the
same model id at two addresses of one vendor is two different prices.

Effort levels are stored in the order the scale runs, whichever order they
arrived in. Endpoints tend to list them alphabetically; the composer's picker
reads the list top to bottom.

## What a turn cost

`costOf` (`src/core/cost.ts`) prices a `TurnUsage` against one model's
`ModelFacts` and returns dollars, or `null` when the model has no price. Input,
output and both halves of the cache are charged at their own rate; a cache rate
nobody has given falls back to the input rate, which is what a provider that
bills cached reads as ordinary input does. Reasoning tokens are left out on
purpose: every provider that reports them has already counted them inside the
output figure, so charging them again would double the most expensive half of
the bill.

A turn is priced by the model that ran it, in `Session.run`, and the figure goes
into the summary line stored with the transcript. The running total in the
corner of the window is priced by whatever model is selected now, so a session
that changed models mid-way reads as an estimate; its tooltip says so.

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
user wants, mixing kinds freely: a local server, a gateway and a vendor account
side by side. The **active selection** is
`{providerId, model, effort}`: which of them a turn actually runs, switchable
from the header without opening settings.

### Base URLs

The base URL must be an absolute `http(s)` URL; trailing slashes are stripped.

The two ecosystems disagree about who owns the version segment. OpenAI clients
take a base that already ends in it, Anthropic clients take one without it and
add `/v1` themselves, and a gateway's path counts as part of the base either
way. People paste whichever their provider's page showed them, so `endpointURL`
adds the version only when the base does not already end in one:

| pasted | reaches |
|---|---|
| `https://host/v1` | `https://host/v1/chat/completions` |
| `https://host` | `https://host/v1/chat/completions` |
| `https://host/api/paas/v4` | `https://host/api/paas/v4/chat/completions` |
| `https://host/api/anthropic` | `https://host/api/anthropic/v1/messages` |

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

`facts` is what the last fetch reported for each model and `overrides` is what
the user typed over it; both are keyed by model id and both are absent until
there is something to hold. `models` is the allowlist the user ticked for that
provider. Saving refuses an
active model that is not on it, so a session can only ever run something chosen
on purpose. An empty list means no list — the model is whatever is typed, which
is how a proxy without `/v1/models` still works.

A settings write that changes the active provider's record or the selection
retires the live sessions, so the next turn is built against the new endpoint,
model or effort rather than the one the window started with.

## Listing models

`listModels` calls `GET {baseURL}/models` — the same path on both wires, each
with its own auth headers, and the same version rule as every other endpoint —
and returns sorted, de-duplicated ids, each with whatever the answer said about
it. The settings screen uses it for both its buttons: reaching the endpoint at
all is the connection test, and the ids are the model picker. A 404 is reported as
"this server has no model list" rather than as a failure, because plenty of
OpenAI-compatible proxies do not implement it. Failures come back as values, not
exceptions — a typo in a URL is an expected outcome of a settings screen — and
an unreachable host is named with its address and error code instead of Node's
bare `fetch failed`.

## When a request fails

A round is asked for up to five times. Both wires throw `ProviderError`, which
carries the HTTP status where there was one, and `isRetryable` in
`src/core/provider.ts` decides from that: 408, 409, 425, 429, 500, 502, 503, 504
and 529 are worth asking again, a 400 or a 401 would be refused the same way
however often it was sent, and an `AbortError` is the user pressing Stop. A
socket that drops mid-stream, a malformed SSE chunk and a `fetch failed` are all
retried too, since none of them is an answer. The waits are 0.5s, 1.5s, 4s and
8s, each shortened by a random part of its last quarter so that several windows
coming off the same rate limit do not all return on the same tick. A
`Retry-After` header replaces the schedule for that attempt and is honoured up
to a minute, past which the provider is asking for longer than a turn should
hang on one header. Stop cuts a wait short: a person who has pressed it does not
get another attempt made on their behalf.

The harder failure arrives after the headers. Anthropic reports an
overloaded model as an `error` event inside a stream whose status was 200, so
there is no status to read; the event's `type` is what says whether asking again
is worth anything. `ERROR_STATUS` in `src/providers/anthropic.ts` maps each
documented type to the status the same failure would have carried had it come
back before the stream started: `overloaded_error` to 529, `rate_limit_error` to
429, `invalid_request_error` to 400. The session throws that as a
`ProviderError`, so one rule decides both cases. A type not on the list is read
as 500, because what breaks halfway through a stream is nearly always the
provider having trouble. `src/providers/failure.test.ts` holds that table to its
word.

A retry starts the round from the top, which means whatever had already streamed
is thrown away: half a sentence of one answer with another answer welded onto it
is worse than either. Nothing partial reaches the transcript, because the
transcript is written when a round returns, and the window is told to take back
what it drew by the `round.retry` event. What a failed attempt was charged for
is carried onto the round that succeeds, so a rate-limited turn still counts the
prompt it paid to have read twice. That only works where the wire says what it
has spent before it finishes: Anthropic reports the prompt's cost in
`message_start`, and the provider passes it on as a `usage` chunk, so an attempt
that breaks after that still says what it cost. An OpenAI-compatible stream
reports usage once, in its last chunk, so an attempt that never gets there
carries nothing and the successful round's own count is all there is. Each retry
leaves a note in the flow saying which attempt is being made, and the fifth
failure ends the turn with the error.
