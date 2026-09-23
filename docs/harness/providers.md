# Providers

A provider turns a ChatInput (messages + tools) into a stream of ChatChunk.
Three wire formats ship: OpenAI-compatible, Anthropic-compatible and
Responses. None of them is a vendor. "OpenAI-compatible" means a server that
answers `/chat/completions` the way OpenAI documents it; "Anthropic-compatible"
means one that answers `/messages` the way Anthropic documents it; "Responses"
means one that answers `/responses`. Which company runs it is not the harness's
business, and no vendor address is compiled in anywhere.

Files:
- src/providers/openai.ts: OpenAI chat-completions streaming (SSE)
- src/providers/anthropic.ts: Anthropic messages streaming (named SSE events)
- src/providers/responses.ts: Responses streaming (named SSE events, items and not messages)
- src/providers/factory.ts: the one place a provider kind becomes a client
- src/core/provider.ts: interface
- src/core/config.ts: the provider registry, its records, effort, resolution and validation
- src/main/config-store.ts: settings on disk, keys encrypted by the OS
- src/providers/headers.ts: the user agent, and the conversation id where an endpoint asked for one
- src/providers/profiles.ts: the endpoints the harness has met before, and the one file allowed to name them
- src/providers/catalogue.ts: what the public model catalogue says about the models at an address
- src/providers/model-facts.ts: what a `/models` answer says about each model, where it says anything
- src/core/cost.ts: what a run of tokens came to, at one model's prices

## OpenAI provider

`POST {baseURL}/chat/completions`, with `stream: true` and
`stream_options: {"include_usage": true}`. See [base URLs](#base-urls) for where
the version segment comes from. Without that second option OpenAI sends no
usage at all and every turn records zero tokens. Servers that do not know the
field ignore it. The stream is plain SSE lines (`data: ...`), and tool-call
arguments arrive as fragments, accumulated per call index.

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
breakdown of `output` and not a sixth figure to add to it.

The cached count has two spellings. The documented one is
`prompt_tokens_details.cached_tokens`; some servers send
`prompt_cache_hit_tokens` at the top level instead, with
`prompt_cache_miss_tokens` beside it. Both are read, the documented one
first. A usage report that arrives without its two totals, or with more cached
tokens than prompt tokens, is rejected and never smoothed over: the session
keeps the answer and records one fault saying the turn's cost
is unknown. Capping the count or defaulting it to zero would put a number true
under nothing into the window and the append-only log, where an entry cannot be
repaired later.

Cache writes have no field here: this wire bills them at the ordinary input rate
and never names them, so `cacheWrite` stays 0 and only Anthropic ever reports
one.

Key: passed via `Authorization: Bearer`. Effort rides as `reasoning_effort`,
left out entirely at `none`, because which values a family accepts varies and
an unknown one either 400s or is dropped without a word.

Thinking has no standard field on this wire. Servers that stream it send it as
`reasoning_content` or as `reasoning`, and the documented shape has neither;
both spellings are read, and the thinking block stays empty against a server
that streams none.

## Anthropic provider

`POST {baseURL}/messages`, with `anthropic-version: 2023-06-01`.

That header is not a "latest" marker to bump. It names the request and response
*format*, and every request must carry one; `2023-06-01` is the version the
Messages API documents, and the only one this code speaks. Changing the string
changes the wire contract, so it is pinned, and never derived from a date or a
package version.

The key goes out as both `x-api-key` and `Authorization: Bearer`. Anthropic's
own API reads the first; several Anthropic-compatible gateways read the second
(the same token they document as `ANTHROPIC_AUTH_TOKEN`). Sending
both means the endpoint's convention does not have to be guessed at.

Five differences matter, and each is handled at the boundary, so none of it
leaks into the session loop:

- `max_tokens` is required. It is derived from the effort, because a thinking
  budget has to stay strictly below it. The server adds it to the prompt and
  refuses a request whose sum is over the window, so the provider reports it
  through `declaredOutput` and the session keeps that much of the window free
  (`context.md`).
- The system prompt is a top-level field, never a message.
- Tool results are `tool_result` blocks on a user message, and consecutive
  results merge into one message, because the API wants alternating roles.
  Consecutive plain user messages merge the same way, as separate text blocks
  in one message. That happens after a compaction, where the summary goes out
  as a user message and the first message kept after it is often another.
- Events are named (`message_start`, `content_block_*`, `message_delta`),
  and tool arguments stream as `input_json_delta` fragments that are
  concatenated and parsed once at `content_block_stop`.
- Usage arrives in two halves, and in the units the harness stores.
  `message_start` carries `input_tokens`, `cache_read_input_tokens` and
  `cache_creation_input_tokens`, and `message_delta` carries `output_tokens` at
  the end. `input_tokens` here is the uncached part of the prompt already, with
  nothing to subtract, which is the shape the OpenAI wire has to be converted
  into. This wire names cache writes, so `cacheWrite` is only ever non-zero on
  it. It reports no reasoning count, so `reasoning` stays 0 even on a turn that
  thought: the thinking tokens are inside `output_tokens` and are not broken
  out.
- Thinking blocks are signed and must come back. When a turn uses tools, the
  next request has to carry the assistant's `thinking` blocks, text plus the
  `signature` that arrived on `signature_delta`, ahead of the text and
  `tool_use` blocks, in the order they were produced. The API verifies the
  signature and rejects an edited, reordered or missing block. `redacted_thinking`
  blocks are encrypted, unreadable here, and passed back untouched. So thinking
  is collected whole (`ChatChunk` gains `thinking_block`), stored on the
  assistant message, and replayed on the wire, and never streamed to the screen
  and dropped.

## Responses provider

`POST {baseURL}/responses`, with `stream: true` and `store: false`. Left
storing, the endpoint keeps the turn and hands back an id to carry on from,
which would make it the owner of a transcript the harness already has on disk.

Three things make it its own file instead of a branch inside `openai.ts`. The
request carries `input` where the other carries `messages`. A tool definition
is flat, `{type, name, description, parameters}`, where the other wire nests
the last three under `function`. And the stream is a sequence of named events,
not deltas hanging off a choice, so there is no shape in common to branch on.

`input` is a flat list and not a list of messages. A plain turn is a role
with its content (`input_text` going up, `output_text` coming back), and a tool
round is two loose items beside it: a `function_call` carrying the arguments the
model asked with, and a `function_call_output` carrying what the tool returned,
paired by `call_id`. One assistant turn can therefore become several entries,
and an assistant turn that only called tools becomes no message item at all,
since an empty one would be a turn the model never took.

Four of the events matter. `response.output_text.delta` is the answer.
`response.reasoning_summary_text.delta` is the thinking, and what arrives is
the summary the model wrote of its own reasoning and not the reasoning itself.
`response.output_item.done` closes an item, and the finished `function_call`
carries its arguments in full, so the fragments streamed ahead of it are read
past and never reassembled. `response.completed` carries the usage.

Thinking does not go back on the next request. This wire hands out a summary and
no signature to verify it against, so as on the OpenAI wire the block is kept
for the window and the stored transcript alone. A tool round replayed without
it was accepted by every endpoint this has been run against.

`response.incomplete` is read for usage exactly as `response.completed` is: a
turn cut short still spent what it spent, and the log it goes to is append-only.
A `response.failed` or a bare `error` event becomes an `error` chunk instead of
an ending with nothing said, so a turn that failed halfway is not recorded as a
turn that finished. It carries status 500, because a stream that has already
answered 200 and then gives up is the provider's fault as far as asking again
goes, and this wire publishes no table of codes to read a finer answer from.

Usage is the same arithmetic the OpenAI wire does under different names.
`input_tokens` holds the cached tokens inside it, so the cached half is
subtracted out; `output_tokens` already holds the reasoning tokens, so
`reasoning` is a breakdown of `output` and is never added on top. This wire
names no cache write and bills one at the ordinary input rate, so `cacheWrite`
is zero.

## Effort

One neutral scale, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`,
because the three wires express the same idea in different units. Each side
uses the field its own API documents:

| effort | OpenAI-compatible | Responses | Anthropic-compatible |
|---|---|---|---|
| `none` | `reasoning_effort` omitted | `reasoning` omitted | no `thinking` field |
| `minimal` | `reasoning_effort: "minimal"` | `reasoning.effort: "minimal"` | `thinking.budget_tokens: 1024` |
| `low` | `reasoning_effort: "low"` | `reasoning.effort: "low"` | `thinking.budget_tokens: 4096` |
| `medium` | `reasoning_effort: "medium"` | `reasoning.effort: "medium"` | `thinking.budget_tokens: 16384` |
| `high` | `reasoning_effort: "high"` | `reasoning.effort: "high"` | `thinking.budget_tokens: 32768` |
| `xhigh` | `reasoning_effort: "xhigh"` | `reasoning.effort: "xhigh"` | `thinking.budget_tokens: 49152` |
| `max` | `reasoning_effort: "max"` | `reasoning.effort: "max"` | `thinking.budget_tokens: 65536` |

Both OpenAI-shaped wires pass the level through as the same word the API takes;
`none` leaves the field out, which is what each of them reads as the model's
own default. No model takes all six words: families differ, and a value a model
does not know comes back as a 400 or is dropped without a word. Which ones a
model does take is a fact about that model, so it is read from the endpoint and
kept per model, and never guessed from the id. See [Model facts](#model-facts).

Anthropic has no effort word. It takes a token budget, so the levels become
budgets. The floor is the API's own: a budget must be at least 1,024 tokens and
strictly below `max_tokens`, which is why `max_tokens` is derived from the
budget and not set independently. The four original levels kept their budgets
when the scale was widened, so a session that ran at `medium` still thinks exactly as
hard as it did.

The top two levels want more output than several Claude models will produce, so
the request is fitted to the model's own ceiling where anyone has said what it is
(`maxOutput`, below). `max_tokens` never exceeds it; the budget keeps the answer
its 8,192 tokens where the ceiling is roomy enough, splits the ceiling in half
where it is not, and drops to no thinking at all where half is under the API's
floor. A model nobody has described is asked the way it always was, and a model
that wants less says so in the error.

## Model facts

Five things about a model are worth knowing before a turn runs on it: which
effort levels it takes, what it charges, the most output it will produce, how
big its context window is, and whether it takes images. `readFacts`
(`src/providers/model-facts.ts`) reads them out of the `/models` answer, and
`ModelFacts` in `src/core/config.ts` is what comes back. Prices are stored as US
dollars per million tokens, because that is the unit vendors quote; every wire
that carries a price sends dollars per token, and the multiplication happens
once, here.

There is no standard for any of this. The two documented answers carry an id, an
owner, a timestamp and sometimes a display name, and nothing about money or
thinking. Servers that do answer those questions each picked their own field
names, so the reader knows every spelling anyone has been seen to use:

| shape | prices | effort levels | ceiling | images |
|---|---|---|---|---|
| a `capabilities` block | n/a | `capabilities.effort.<level>.supported` | `max_tokens` | `capabilities.vision.supported`, or `vision` in a `capabilities` list |
| a `pricing` block | `pricing.prompt`, `.completion`, `.input_cache_read`, sometimes as strings | n/a | n/a | n/a |
| reasoning metadata | n/a | `metadata.reasoning.supported_efforts` | n/a | n/a |
| per-token costs | `model_info.input_cost_per_token` and friends, or the same names at the top level | n/a | n/a | `supports_vision`, at the top level or in `model_info` |
| an `architecture` block | n/a | n/a | n/a | `architecture.input_modalities`, or the older `modality: "text+image->text"` |

A `capabilities` block is the one shape that states the levels outright, so it
is read first. `none` is added to whatever it names, because on that wire the
level is the thinking block left out of the request and no model needs
permission for that; `minimal` is not added, because it is a budget the list does
not mention and inventing it here is how a 400 arrives mid-turn. A model whose
`capabilities.thinking.supported` is false takes `none` and nothing else. A
`capabilities` block that says nothing about effort leaves the levels unknown,
which marks the model instead of guessing for it.

A field that only says whether a model reasons at all, as `supported_parameters`
does, is read by nothing: it never names the levels, and turning "reasons" into
a list of seven would be inventing the answer.

Images are the one fact with three states. A list of input modalities that
does not name `image` is a no, and a flag set false is a no. An endpoint that
mentions neither has not answered at all, and `vision` comes back undefined.
The settings screen offers the same three, so a model nobody has described
stays undescribed instead of being recorded as text only.

The window is read from `context_length`, `context_window` or
`max_context_length` on the entry, `max_input_tokens` at the top level or in
`model_info`, `top_provider.context_length` on an aggregator that routes one
model to several upstreams, and `limit.context` on a server that groups its
ceilings under one key. `max_input_tokens` is the prompt alone where the others
are prompt and answer together. It is read anyway, because a window sized a
little small makes compaction run a little early and nothing worse. A model
with no window has no context percentage and never compacts on its own, and the
settings screen has a field for it beside the prices. `factGaps` does not count
it, since a missing window turns a feature off and costs no money.

### When nothing describes a model

Most endpoints are in none of those rows. Asked directly, many answer with the
bare shape, an id, an object type, a timestamp and an owner, with nothing about
price or thinking. The catalogue below fills that in.

A model neither the endpoint nor the catalogue describes ends up with no facts,
which is not an error. The settings screen marks it, the composer keeps
offering every level, and the user can type the answer in: `overrides` on the
provider record
holds what they typed, wins over the endpoint field by field, and survives the
next fetch. `resolveFacts` does that merge, so one wrong price corrected by hand
does not throw away an effort list the endpoint got right.

Fetching the models of a provider that is already saved stores what came back
straight away, key and URL having just been proved by the same call. The ticked
list, the prices and the effort levels are on disk before the user gets to the
Save button. A provider being typed in for the first time is left alone until
they press it.

A settings write that changes the active provider's record, meaning its
address, wire kind, key or allowlist, or that moves the active selection,
retires the live sessions, which rebuild from the stored transcript on their
next turn. A write
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

### Prices that climb with the prompt

Some models charge a higher rate once a prompt passes a length. `tiers` holds
those rates, each with the prompt size it starts at, and the whole request is
billed at whichever tier the prompt reaches, and not only the tokens above the
line, which is how the endpoints doing this actually bill. Cached tokens
count towards the length: the endpoint sizes the request it was sent, and a
cache hit is still context the model reads. A tier that names only some rates
keeps the base ones for the rest.

Tiers arrive from the table above, and the settings form has no field for one.
A price typed by hand therefore drops them, because keeping a tier would double
a figure the user had just corrected. A correction that says nothing
about price leaves them where they are.

## Configuration

Nothing about a vendor is compiled in. There is no default base URL, no default
model, and no fallback key: an incomplete configuration raises `ConfigError`
naming exactly what is missing, and the app opens its setup screen instead of
talking to somebody's cloud unasked.

The settings screen is the only way in. A provider has to be configured before
anything can run at all, so there is one place to configure it. No environment
variable shadows what the screen shows, and there is nothing to export before
the app is usable. `resolveConfig` (`src/core/config.ts`) reads what was saved:

| file | holds |
|---|---|
| `<user-data>/config.json` | the provider records and the active selection |
| `<user-data>/credentials.bin` | every API key, encrypted by the OS, indexed by provider id |

A **provider record** is `{id, name, kind, baseURL, models}`, as many as the
user wants, mixing kinds freely: a local server, a gateway and a vendor account
side by side. The **active selection** is
`{providerId, model, effort}`: which of them a turn actually runs, switchable
from the header without opening settings.

### Who is asking, and about which conversation

Every request the harness makes carries `user-agent: nanoharness/<version>`.
Node sends the name of its HTTP library otherwise, and endpoints route,
rate-limit and refuse on that field, so a request that says what it is gets
treated as what it is. The model-list fetches send it too.

Some endpoints also want to know which conversation a request belongs to, so
they can pin it to one upstream or keep its prompt cache warm. There is no
standard header for this. Each endpoint that wants it chose a spelling, and
most want nothing, so the name is a per-provider setting and not something the
harness assumes.

Known addresses are answered by `src/providers/profiles.ts`. An unlisted host is
sent the user agent and nothing more.

No screen offers the header name, on purpose. It is not something a user can be
expected to know, and a new public endpoint that wants one is better fixed by a
line in `profiles.ts`, where it works for everybody, than by one person finding
a text box. A private gateway that needs session affinity is the exception, and
`sessionHeader` on the record is editable in the settings file for it. A save
from the window leaves whatever is there.

### The model catalogue

`src/providers/catalogue.ts` reads `https://models.dev/api.json`, a public
directory describing the models of several hundred endpoints, keyed by the same
base URL the user pastes into settings. Prices, effort levels, output ceilings,
context windows, whether a model reads images and which wire it answers on all
come from there.

It is read when the user presses **Fetch models** and at no other time, and
nothing is kept between presses, so a model added this morning is described this
morning. The alternative was a table of prices typed out of a vendor's web page:
correct on the day it was written, and by the following week missing two of the
three models at one endpoint that answer on a wire of their own. Every turn on
either of those two failed with a 503.

A catalogue that cannot be reached fails the fetch. The model list is not filled
in from a stale copy or waved through undescribed, because a price nobody can
source is how a wrong number reaches the spend view.

The request carries no key, no model id and no address. It is one public file,
the same file for every user, and the configured endpoint is matched against it
here, and never asked about. What models.dev learns is that somebody running
this harness pressed the button.

A figure from a catalogue is the vendor's published rate and not what this
particular key is billed, and the same model id at a subscription address and a
pay-per-token address is two different prices. So the endpoint stays the
authority on itself: `describe()` fills only the fields the `/models` answer left
empty and overwrites none it filled, and a correction typed in settings outranks
both. A model the catalogue has never heard of is offered undescribed and
marked, and never left out, and a model only the catalogue knows about is not
conjured into the list.

The wire is read the same way and stored with the model's prices. A gateway
fronts many upstreams and does not translate between every pair of formats, so
one model in a catalogue can be reachable on one wire alone. The catalogue names
the SDK each model is reached with and `WIRES` maps those names onto the three
this harness speaks; a name nobody has mapped leaves the record's wire standing.
`createProvider` then takes that wire alongside the record, which keeps such an
endpoint a single record in settings instead of two the user would have to know
to pick between. A model's own wire outranks the record's, the other way round
from the session header: a header the user typed is a preference, and a wire the
endpoint refuses is a 400.

### Endpoints the harness has met before

`src/providers/profiles.ts` is the one file in this layer allowed to name an
address. Nothing in it changes how a request is built or how an answer is read,
so a kind is still a wire format and the rule at the top of this page holds. It
holds what a person would otherwise have to type correctly from memory: a
label, the wire, the base URL, and the session header where one is wanted.

Settings builds its **Provider** picker from that list. Choosing an entry fills
the fields and stops there, leaving the key and the model list to the user, and
what gets saved is an ordinary record: editable, deletable, and repointable at a
staging address like any other. Nothing about it is a separate kind of provider.
`ui.md` has what the sheet does with an entry once it is picked.

What each of its models costs is not in this file. That is the catalogue's
answer, read live, and the section below has it.

The window cannot import this layer, because `app://` serves `out/renderer`
alone. The list travels on `ConfigStatus` instead of being written down twice,
which is the difference between this and `src/renderer/facts.ts`.

The value is the session's own id, which is already stable across its turns and
distinct between sessions. The approval judge sends `<session id>-approval`
instead: it shares the session's lifetime and nothing else, and two message
histories under one id are two histories fighting over one cache.

A name that `fetch` would reject is dropped on the way in, from the window and
from disk alike. Carrying one would fail every turn with an error about the
header and not about the endpoint that wanted it.

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

What does *not* belong in the field is the endpoint path itself: the base ends
before `/chat/completions` or `/messages`. The settings screen says so under the
field, with examples for the kind that is selected.

A settings file written by the single-provider version is migrated on read: its
`baseURL`, `model` and `models` become one record under the id `legacy`, which
is also the id its stored key is found under, so an existing install keeps
working without anything being retyped.

The settings file is **secret-free by schema** (plan §16): `StoredConfig` has
no `apiKey` field at all, so it can be read, copied or pasted into an issue
without leaking anything. The key lives in its own file, encrypted through
Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on
Linux). Where the OS has no such store, the app refuses to save a key and never
falls back to plaintext. Neither file is ever written to the repo.

`facts` is what the last fetch reported for each model and `overrides` is what
the user typed over it; both are keyed by model id and both are absent until
there is something to hold. `models` is the allowlist the user ticked for that
provider. Saving refuses an
active model that is not on it, so a session can only ever run something chosen
on purpose. An empty list means no list: the model is whatever is typed, which
is how a proxy without `/v1/models` still works.

A settings write that changes the active provider's record or the selection
retires the live sessions, so the next turn is built against the new endpoint,
model or effort, and not the one the window started with.

## Listing models

`listModels` calls `GET {baseURL}/models`, the same path on every wire, each
with its own auth headers and the same version rule as every other endpoint. It
returns sorted, de-duplicated ids, each with whatever the answer said about
it. The settings screen uses it for both its buttons: reaching the endpoint at
all is the connection test, and the ids are the model picker. A 404 is reported
as "this server has no model list" and not as a failure, because plenty of
OpenAI-compatible proxies do not implement it. Failures come back as values,
not exceptions, because a typo in a URL is an expected outcome of a settings
screen, and an unreachable host is named with its address and error code, in
place of Node's bare `fetch failed`.

## When a request fails

A round is asked for up to five times. Both wires throw `ProviderError`, which
carries the HTTP status where there was one, and `isRetryable` in
`src/core/provider.ts` decides from it by the rule HTTP already states, and not
from a list of numbers. A 5xx is the server saying it failed, so the same
request may well work a second time; a 4xx is the server saying the request was
wrong, and it will be wrong in the same way when it arrives again. Three 4xx
statuses are exceptions, because each means "not now" and not "not this":
408, 425 and 429.

Most hosted endpoints sit behind a proxy
that answers in numbers of its own; Cloudflare alone has 520 through 527. A
hand-written list of retryable statuses would have to name every one of them,
and a 522 it had not heard of would read as a malformed request not worth
sending again, the opposite of what it means.

Two things are retried without a status. A stream that broke, whether the body
never arrived or an SSE event stopped halfway, is thrown as `StreamBrokenError`,
which is a class and not a message, so rewording the sentence cannot switch the
retry off. A connection that never delivered a response at
all is recognised by the `code` in its `cause` chain, which is where Node keeps
the reason behind a bare `fetch failed`; the codes are named because they are a
closed set, and what is outside it is a misconfiguration that fails identically
on every further attempt: an expired certificate, or a hostname that does not
match. An `AbortError` is the user pressing Stop and is never retried.

The waits are 0.5s, 1.5s, 4s and 8s, each shortened by a random part of its last
quarter so that several windows coming off the same rate limit do not all return
on the same tick. A `Retry-After` header replaces the schedule for that attempt
and is honoured up to a minute, past which the provider is asking for longer
than a turn should hang on one header. Stop cuts a wait short: a person who has
pressed it does not get another attempt made on their behalf.

`backoffFor` and `sleep` live here and not in the session, because the
approval judge in `src/core/approval.ts` retries a rung of its ladder on the
same policy with a shorter schedule of its own. One backoff, one place that
honours `Retry-After`.

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

A retry starts the round from the top, which means whatever had already
streamed is thrown away and never welded onto the answer that replaces it.
Nothing partial reaches the transcript, because the transcript is written when
a round returns, and the window is told to take back
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

A request refused as longer than the model's window is a 4xx that the same
bytes will get again, and shorter bytes will not. `isContextOverflow`, beside
`isRetryable`, recognises one by shape, since no two servers word it alike:
status 413, an error code of `context_length_exceeded` or `request_too_large`
in the body the error quotes, or a message saying the prompt, input or context
is too long or over the window. A 5xx or a 429 that mentions the context is left
to `isRetryable`, because the server failing and a per-minute quota are both
answered by waiting. The session answers a refusal once, by shrinking the
history and asking again (`context.md`).
