# Plan: opencode Go

Go is a $10/month subscription behind `https://opencode.ai/zen/go/v1`. Zen
already works in nanoharness as an ordinary OpenAI-compatible record. Go rejects
every request with a 400 until the client sends a header nanoharness has no way
to produce.

Status: steps 1, 3, 4 and 5 are in `src/`. Step 2 was probed against the live
gateway and dropped; the note under it says what came back. Step 6 is open, and
every model the endpoint offers is now reachable. What has shipped is described
in `docs/harness/providers.md` in the harness's own terms, and this page keeps
the vendor detail behind it until the list at the end is finished.

Sources, because the docs are the least informative of the three. The console
serving `/zen/*` is public at `anomalyco/opencode` under
`packages/console/app/src/routes/zen/`, and it settles most questions outright;
claims from it are cited by path. Model behaviour was probed directly against
the live gateway. Operational quirks come from `can1357/oh-my-pi`'s
`docs/provider-quirks.md`, written by someone running Go in production. Anything
still unknown is listed at the end.

## The error

```
provider 400: {"type":"error","error":{"type":"MissingSessionID",
"message":"Request is missing x-opencode-session and cannot be routed
efficiently."}}
```

Go asks every client for a stable session ID in `x-opencode-session`, one per
conversation, and for a user agent naming the client and not the HTTP
library. nanoharness sends neither. `src/providers/openai.ts:90` sends
`content-type` and `authorization`, `src/providers/anthropic.ts:162` adds
`anthropic-version` and `x-api-key`, and no `user-agent` appears anywhere in
`src/`, so requests go out under undici's default.

The value Go wants already exists: `SessionOptions.sessionId`
(`src/core/session.ts:186`). It has no route to the wire. `ChatInput`
(`src/core/provider.ts:9`) carries a model, messages, tools, effort, maxTokens
and a signal, and no conversation identity, so neither `stream()` call site
(`src/core/session.ts:775`, `src/core/approval.ts:362`) has anything to pass.

### What the header has to be

opencode sends its own session id, unmodified
(`packages/opencode/src/session/llm/request.ts:191`):

```ts
"x-opencode-session": input.sessionID,
"x-opencode-request": input.user.id,
"x-opencode-client": input.flags.client,
"User-Agent": USER_AGENT,
```

The server reads it as a bucket key for sticky provider selection, logs it as a
metric, and deletes it before forwarding upstream
(`routes/zen/util/handler.ts`):

```ts
const stickyId = sessionId ? sessionId : (authInfo?.workspaceID ?? ip)
const stickyTracker = createStickyTracker(modelInfo.id, modelInfo.stickyProvider, stickyId)
```

There is no validation, no format, and no length check anywhere it is handled.
Any stable opaque string works, so nanoharness session ids go through as they
are. The fallback also confirms why the header matters: with none, the bucket is
the whole workspace or an IP, which is the coarsest sticky key there is.

### Where the 400 comes from

`MissingSessionID` is not one of the console's error types.
`routes/zen/util/error.ts` declares `AuthError`, `CreditsError`,
`MonthlyLimitError`, `UserLimitError`, `ModelError`, `RegionError`,
`DataPolicyError`, `RateLimitError`, `FreeUsageLimitError`, `GoUsageLimitError`
and `BlackUsageLimitError`, and nothing else.

It comes from a second service. `handler` calls `proxyInference` first, and that
function forwards the whole request to a private inference host whenever the key
is new-style (`lib/inference-proxy.ts`):

```ts
const legacy = !key.startsWith("oc_sk_")
const workspace = legacy ? await migratedWorkspace(key, generation?.provider) : undefined
if (legacy && !workspace) return undefined
```

A key beginning `oc_sk_` never reaches the open code path at all. The session
check, and the 400, live on the other side, which is not public. That is also
why the error cannot be reproduced without a real key: an invalid key is not
`oc_sk_`-prefixed, falls through to the console, and gets `AuthError` from
there. `proxyInference` builds the forwarded request from the original, so the
header survives the hop.

### About the user agent

Node's fetch sends `undici` unless told otherwise, so nanoharness arrives at
every endpoint today as a generic HTTP library. Go reads that field, asks for a
name like `my-coding-agent/1.0`, and monitors traffic for abuse.
`nanoharness/<version>` from `package.json` costs one constant and one header,
says something true, and carries no vendor name, so it belongs on every request
the harness makes.

One exception, already recorded in `subscription-usage.md`: the usage route
refuses anything that is not a browser `User-Agent`. That route keeps the
browser string; the chat routes get the real one.

## Which wire, per model

The docs publish an endpoint table assigning each model one of
`/v1/chat/completions`, `/v1/messages` or `/v1/responses`. It is not a hard
routing rule, and it is not free to ignore either. Three separate facts decide
what nanoharness should do.

The gateway converts between formats. `handler` builds converters from
`providerInfo.format`, the wire the upstream vendor speaks, and `opts.format`,
the path the client called (`provider/provider.ts:182`):

```ts
export function createBodyConverter(from: ZenData.Format, to: ZenData.Format)
export function createStreamPartConverter(from: ZenData.Format, to: ZenData.Format)
export function createResponseConverter(from: ZenData.Format, to: ZenData.Format)
```

Conversion is lossy, in exactly the places nanoharness cares about.
Everything funnels through one intermediate, and `CommonRequest` is the whole of
it: `model`, `max_tokens`, `temperature`, `top_p`, `stop`, `messages`, `stream`,
`tools`, `tool_choice`. No thinking parameter, no `reasoning_effort`, no
`cache_control`. `CommonChunk`'s delta is `role`, `content` and `tool_calls`,
and its usage is `prompt_tokens`, `completion_tokens`, `total_tokens` and
`prompt_tokens_details.cached_tokens`. No reasoning content, no reasoning token
count, no cache-write count. Neither converter file mentions thinking or
reasoning at all. A converted request loses the effort level; a converted
response loses the thinking and half the cache accounting `cost.md` reports on.

Most models accept most paths anyway. `validateModel` refuses a format only
when a model's config entry is a list and no member matches
(`handler.ts:546`):

```ts
const modelData = Array.isArray(zenData.models[modelId])
  ? zenData.models[modelId].find((model) => opts.format === model.formatFilter)
  : zenData.models[modelId]
if (!modelData) throw new ModelError(...)
```

That check runs before `authenticate`, so an invalid key is enough to map it.
Every live model was probed against all three paths. A made-up id gives
`Model … is not supported`; a real id on a refused path gives `Model … is not
supported for format <x>`. Re-run on 2026-09-21, when the list held 31 ids:

| Path | Refused by |
| --- | --- |
| `/chat/completions` | `grok-4.6` only |
| `/messages` | `grok-4.6` only |
| `/responses` | `kimi-k3`, `minimax-m3`, `minimax-m2.5`, and all five Qwen ids |

So 30 of the 31 answer on `/chat/completions`, and `grok-4.6` is the single
model that cannot be reached without a Responses client. The membership moves:
the first run of this probe saw 37 ids and a `grok-4.5` that has since gone.
Reach is read from the endpoint at fetch time for that reason, and nothing in
`src/` holds a list of which models exist.

The pieces add up to this. Thirty-six models go over `/chat/completions`.
Those whose upstream is already OpenAI-compatible get no converter at all, and
oh-my-pi reaches the same conclusion from the other direction: it deliberately
forces `minimax-m2.7`, `minimax-m3`, `qwen3.5-plus` and `qwen3.6-plus` onto
chat completions "to prevent gateway 404 HTML errors or raw tool-call markup
leaks", so the Anthropic route is worse in practice for the models the docs
assign to it.

`grok-4.6` goes over `/responses`, which nanoharness cannot speak. Reaching it
means a third wire client. That is not a compromise of the `providers.md` rule:
Responses is a wire format like the other two, no vendor is named by it, and
`kind: 'responses'` sits beside `openai` and `anthropic` honestly. `openai.ts`
cannot be bent into it either, since the request takes `input` in place of
`messages`, tools are flat instead of nested under `function`, and the stream is
named events (`response.output_text.delta`, `response.output_item.done`,
`response.completed`) and not deltas on a choice. It is its own file, about
the size of `anthropic.ts`.

Which leaves one record that has to speak two wires. `kind` is one value, so the
`profile` below answers `wireFor(model)` and `createProvider` builds whichever
client it names. Without that, Go is two provider records in settings for no
reason the user would understand.

## Quirks that will bite

All three come from oh-my-pi's production notes, and one of them is a live
conflict with nanoharness's current code.

`authHeaders` sends a header combination Go rejects. On opencode's Anthropic
endpoints, "Bearer-only requests fail with HTTP 401 Missing API key", and
oh-my-pi deletes the `Authorization` header so only `X-Api-Key` goes out.
`src/providers/anthropic.ts:28` sends both:

```ts
return { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` }
```

Sending both may well be fine, and our probe with an invalid key got a normal
`AuthError` and not `Missing API key`. Worth knowing about before debugging
a 401 that looks like a bad key. Routing over `/chat/completions` sidesteps it
entirely.

Thinking models demand `reasoning_content` on tool-call replays. Reported, and
then not reproducible. When reasoning is on, the gateway is said to return 400
if a prior assistant tool-call message arrives without `reasoning_content`, 400
again if one arrives while thinking is off, and 400 for a synthetic
placeholder.

Twenty-eight replays went out against the live gateway on 2026-09-21: glm-5.2,
glm-5.2:max, kimi-k3 and minimax-m3, each carrying no `reasoning_content`, the
real text, a truncated copy, a placeholder and an empty string, with thinking on
and off. All twenty-eight returned 200 and a real completion. Whatever the
report describes is not what `/chat/completions` does on this gateway today, so
building the replay would be writing a workaround against no failure, and
sending an unasked-for field is how a 400 arrives on the next endpoint. Left
out, with the door open: if the 400 does turn up, `session.ts:675` already
stores the text and `toWireMessage` is the only thing to change.

One real defect came out of those probes and is unrelated to any of this:
`minimax-m3` writes its thinking into `content` wrapped in `<think>` tags, and
not into `reasoning_content`, so it reaches the transcript as the answer.

Less work than it sounds. `openai.ts:21` already reads `reasoning_content` off
the delta, and `session.ts:675` already stores the result on the assistant
message's `thinking`, so the text is on hand. What is missing is the send:
`toWireMessage` (`openai.ts:167`) builds four fields and thinking is not among
them, by an explicit decision recorded at `openai.ts:110` back when nothing
asked for it. It becomes conditional, since sending the field with thinking off
is itself a 400.

One thing to watch. An unsigned block's text is scrubbed before it is stored
(`session.ts:800`), so what goes back is not byte-for-byte what came out. That
is fine if the gateway only checks the field is present and non-empty, and not
fine if it checks the content. The refusal of placeholders hints at some
checking. Worth trying before building around it.

MiniMax M2/M3 accept only `low`, `medium` and `high`. They reject `minimal`
and `xhigh`. `clampEffort` already handles this given the right `efforts` list,
which models.dev supplies.

## Facts, because Go's `/models` states nothing

The route returns `Object.keys(ZenData.list("lite").models)` and emits bare
OpenAI entries (`routes/zen/go/v1/models.ts`):

```json
{"id":"kimi-k3","object":"model","created":1789932681,"owned_by":"opencode"}
```

No key is involved and no narrowing happens, so it is the same 37 ids for
everyone. `readFacts` returns `{}` for all of them, which puts the warning mark
on every model in settings.

models.dev fills it in. Its `opencode-go` provider carries 36 models with
everything nanoharness models:

```
cost.input / output / cache_read / cache_write   →  ModelFacts prices
modalities.input includes "image"                →  ModelFacts.vision
limit.output                                     →  ModelFacts.maxOutput
reasoning_options                                →  ModelFacts.efforts
```

The effort values land exactly on nanoharness's seven-level scale, and they
differ sharply per model. Kimi K3 accepts `max` alone. GPT 5.6 Luna accepts six
of the seven. GLM-5.2 accepts `high` and `max`. Two of the three
`reasoning_options` shapes need a mapping:

- `{"type":"toggle"}`: thinking on or off. Reads as `['none','high']`.
- `{"type":"budget_tokens"}`: a token budget, the Anthropic thinking parameter
  `anthropic.ts` already computes from an effort level.

Use the live `/models` list for reach and models.dev for facts. The two disagree
on membership in both directions: `ox-alpha-free` is only in models.dev,
`deepseek-flash` and `hy3-preview` only in the live list.

## Cost, and the multiplier that changes what it means

Go charges $10 and meters consumption in dollars, so a Go turn's dollar figure
is allowance spent and not money leaving a card. The important part is that
the allowance is not spent at face value (`handler.ts:1194`):

```ts
const quotaCost = Math.round(cost * modelInfo.costMultiplier)
```

There is *one* account-wide dollar allowance, and each model carries a
`costMultiplier` applied before the usage counters move. The docs' per-model
"monthly limit" of $60, $30 or $15 is that one allowance divided by a multiplier
of 1, 2 or 4, which is why the docs annotate DeepSeek V4.1 Flash as "4x". So a
turn that costs $0.04 on a 4x model takes $0.16 of the plan.

Two different true numbers exist here: what the tokens cost, which models.dev
prices and `costOf` already computes, and what the allowance lost, which is that
times the multiplier.

Only the first is the harness's to compute. The multiplier appears in no
machine-readable source, the allowance is a share of a window and not an
amount of money, and a figure built here out of transcribed prices and a
transcribed ratio would be a guess presented as an account balance. The meter
reads from `GET /usage`, which is the account itself answering, and the
multiplier is already applied in what it returns. This section is why that route
matters, not a specification for arithmetic to do instead of calling it.

`costOf` also needs context tiers, which `cost.ts:16` does not have. Seven Go
models double or triple their rate above a threshold, and they include the ones
people will actually run:

| Model | Base in/out | Above | Threshold |
| --- | --- | --- | --- |
| `grok-4.6` | 2 / 6 | 4 / 12 | 200K |
| `grok-4.5` | 2 / 6 | 4 / 12 | 200K |
| `gpt-5.6-luna` | 0.2 / 1.2 | 0.4 / 1.8 | 272K |
| `qwen3.7-plus` | 0.4 / 1.6 | 1.2 / 4.8 | 256K |
| `qwen3.6-plus` | 0.5 / 3 | 2 / 6 | 256K |
| `mimo-v2-pro` | 1 / 3 | 2 / 6 | 256K |
| `minimax-m3` | 0.3 / 1.2 | 0.6 / 2.4 | 512K |

The server charges this way (`calculateCost` reads `cost200K`), so flat prices
under-report a long context by up to 3x, and the error grows exactly when a
session has been running long enough for someone to care. The threshold differs
per model, so it is a field on `ModelFacts` and not a constant, and
models.dev already publishes it as `cost.tiers[].tier.size`.

The gateway also computes cost per request and puts it in the stream
(`provider/provider.ts:169`):

```ts
case "oa-compat":
  return `data: ${JSON.stringify({ choices: [], cost })}\n\n`
```

`calculateCost` applies both the DeepSeek peak window and the 200K context tier
at request time, so that number is more accurate than any local table. It is
worth reading when it appears, and worth not depending on: it is emitted by the
public console path, no third-party client documents receiving it, and the
private service may not send it at all. Local pricing stays primary, and
`openai.ts` needs to skip chunks with an empty `choices` array either way.

## The subscription meter

`subscription-usage.md` recorded that Go's usage route gives percentages and no
way to turn a tick into money. The route's source now answers both halves
(`routes/zen/go/v1/usage.ts`):

```ts
rolling: formatUsage(Subscription.analyzeRollingUsage({
  limit: limits.rollingLimit, window: limits.rollingWindow,
  usage: row.rollingUsage ?? 0, timeUpdated: row.timeRollingUpdated ?? new Date(),
}))
```

`row` is one `LiteTable` record selected by workspace and user; `limits` is a
single `getLimits()["lite"]` triple held in dollars and compared in microcents.
The percentages are account-wide and multiplier-adjusted, and the same three
windows are what `GoUsageLimitError` fires on. There is no per-model dimension
anywhere in the accounting, which resolves the apparent contradiction with the
docs' per-model table: that table is the multiplier expressed as dollars.

One caveat from oh-my-pi worth carrying into the adapter: an exhausted monthly
window can still serve when the console's "Use balance" option is on, so
`monthly` is a display figure and not a gate. The hard failure is a
`401 Insufficient balance`.

## Steps

The goal is every Go model usable, so the list runs to the end instead of
stopping at the 400.

1. Done. `conversationId` on `ChatInput`, threaded from `sessionId` through
   both `stream()` call sites. A `user-agent` of `nanoharness/<version>` on
   every provider request. `src/providers/headers.ts` holds both, and the
   session header comes from the address, and not from a field the user has
   to fill in.
2. Dropped, for the reason under the quirk above: twenty-eight replays, no
   400 to work around.
3. Done, without a `profile` field. `src/providers/profiles.ts` names the
   address and `src/providers/opencode-go.ts` holds the table; `describe()`
   lays it over whatever the endpoint returned, so the record that gets saved
   is an ordinary one and `ProviderRecord` grew nothing. Thirty models arrive
   with prices, vision, ceilings and effort levels.
4. Done. `ModelFacts.tiers`, read by `costOf` in both copies, with the whole
   request charged at whichever tier the prompt reaches.
5. Done. `kind: 'responses'` and `src/providers/responses.ts`, written
   against the live stream and not the specification. `OPENCODE_GO_WIRES`
   names the one model that needs it and `wireFor()` answers for the address,
   so `createProvider` takes the model along with the record and the endpoint
   stays one record in settings. Verified end to end in the app: a tool round
   over `/responses` on `grok-4.6`, with `kimi-k3` still going over
   `/chat/completions` from the same record.
6. The Go adapter in `src/subscription/`, per `subscription-usage.md`, reading
   the three windows off `GET /usage`.

Only steps 3 and 6 are Go-specific. The session header, context tiers and a
Responses client are things the harness is missing in general, and Go is just
the endpoint that made each one unavoidable. That is why step 3 ended up as a
table one address happens to be listed in, and not a field on every
provider record: the next endpoint that publishes its prices on a web page
instead of on the wire is a second entry in the same file.

What is in `src/` today turns a hard failure into a working provider for every
model the endpoint offers, each with its prices and its effort levels. What is
left is the subscription meter, which says how much of the month is gone, and
not whether a turn can run at all.

## Session identity

Go wants one stable ID per conversation, held across turns and across a resume.
`SessionOptions.sessionId` is exactly that. Three callers make requests:

- The turn (`session.ts:775`): the session's own id.
- A subagent (`agents.ts`): its own id, not the parent's. It runs a
  separate message history, and the header exists to keep a prompt cache warm;
  two histories under one id defeat that.
- The approval judge (`approval.ts:362`): its own id, stable for the
  session. Go's client table calls these auxiliary requests and expects the
  header on them too. oh-my-pi sends it on usage polls as well.

## What is still unknown

One question, and it only decides whether a nice-to-have is available.

Does the private inference service emit the same in-stream `cost` chunk the
public console does? No third-party client documents consuming it, including one
that documents Go's quirks in detail, which is weak evidence that it does not
arrive or is not trusted. The plan treats it as a bonus and prices locally
regardless, so the answer changes nothing structural.
