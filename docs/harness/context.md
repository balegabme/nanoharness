# The context window

A session has two token figures. The spend only grows: every token the session
has paid for, by every request, subagents and harness calls included. The
context is the size of the next request, and it grows until a compaction brings
it back down. The spend says what the session cost. The context says how close
the next request is to the model's window, and a long session runs into that one
first.

This page is about the second figure: how it is measured, when the harness
compacts the conversation to keep it under the window, and what a compaction
writes. The spend is in `cost.md`, and the buttons that draw both are in `ui.md`.

Files:
- src/core/context.ts: the estimator, the ledger, calibration, the reserve and the thresholds
- src/core/compaction.ts: the summary instruction, where the cut falls, the pruner and the flattened history

The rest lives with the code it belongs to. `Session` in `src/core/session.ts`
(`overview.md`) builds the ledger, runs the check before each request and makes
the summary requests. `src/renderer/context-meter.ts` draws the ring and its
panel (`ui.md`).

## Measuring the context

The provider measures every request it answers, and that measurement is the only
exact figure available. The prompt a request carried is `input + cacheRead +
cacheWrite` from its usage, with `input` already normalised to exclude cached
tokens (`providers.md`). Everything appended after that request (the answer,
tool calls, tool results, the next user message) has not been measured by anyone
yet, so it is estimated.

The ledger is an anchor plus a delta. The anchor is the prompt of the last
request, taken in `attemptRound` from that response's own usage. A turn's usage
event adds several prompts together and would overcount by the number of rounds.
Beside the reported figure the anchor keeps what the estimator made of the same
messages, and the delta is how much the estimate has grown since:

```
tokens = anchor.reported + max(0, estimate now - anchor.estimated) * factor
```

The estimator divides characters by four and adds four tokens per content block
and four per message for the role framing. It needs no tokenizer of its own,
since calibration corrects it for the one answering. Thinking counts only where
it goes back on the wire, as a signed or redacted block. An unsigned block is
kept for the window alone.

An image counts as its pixels over 750, plus a block, which is the rate plan
§15 records for one wire. The wires that bill by tile or by patch come out near
that figure for a picture of the size the window sends, and calibration takes
up the rest.

The factor is ours. Each response gives one pair of figures, what the provider
reported for a prompt and what the estimator said for the same bytes. The first
pair sets the factor outright, and each later one moves it 30% of the way to the
new ratio, clamped to [0.5, 2]. It corrects the estimator for the tokenizer in
use, and the clamp keeps one odd response (an image, a wire that drops old
thinking) from swinging the meter. The ledger carries the factor as
`calibration`, with the model it was measured on. A session rebuilt from a
stored ledger on the same model starts from it as its first sample, so it
estimates its history the way it was last measured before it has sent anything.
On another model it starts again at 1, since the tokenizer may differ.

The breakdown is estimated part by part: the system prompt, the tool schemas,
the summary, the user's messages, the assistant's text and tool-call arguments,
thinking sent back, and tool results. The parts are then scaled so they sum to
the total, with the rounding remainder on the largest part. The panel says which
figure is which: so much as the provider counted the last request, and about so
much estimated since. A compaction drops the anchor, because it described a
history that no longer goes out, and the ledger runs on the estimate alone until
the next response measures it.

## The window and the budget

`ModelFacts.context` is the model's window in tokens. `readFacts` in
`src/providers/model-facts.ts` reads it from `/models` in every spelling seen so
far, and `catalogue.ts` reads `limit.context` beside `limit.output`
(`providers.md` has both). The settings sheet has a field for it under each
model, beside the prices. `factGaps` does not count it: a missing window turns a
feature off and costs no money.

The reserve is the room the next answer needs. A wire that declares an output
ceiling the server counts against the window reserves that ceiling, through the
optional `declaredOutput` on `ChatProvider`. The Anthropic wire does this,
because its server adds `max_tokens` to the prompt and refuses a request whose
sum is over the window, however short the answer would have been. At `max`
effort that ceiling can reach 73,728 tokens, and a 20k reserve would let
requests fail long before compaction ran. A wire that declares nothing reserves
the smaller of 20,000 and `maxOutput`, or 20,000 when `maxOutput` is unknown.
That covers a long answer with tool calls in it, and costs little on a large
window.

The user can set a limit on the context, one number for every session, stored
as `context.limit` in the config and absent unless set. The field for it is in
the context panel and writes over `config:set-context-limit`. The main process
hands it to every live session and each spawn host, as it does the automatic
toggle. Compaction works against the room, `ledger.room`: the smaller of the
window and the limit, or the limit alone where the window is unknown. A limit
over the window changes nothing. The ledger carries the limit and the room
beside the window, so the panel can say which one applies.

The usable space is the room minus the reserve. Automatic compaction runs once
the ledger passes 80% of it. The 20% it leaves is the room the summary request
needs, since that request is the same prompt with an instruction on the end.

With no known window and no limit there is no percentage and no automatic
compaction. The meter shows the size in tokens and says where to set either,
and "Compact now" still works. A reserve as large as the room leaves no usable
space and is treated the same way, with a warning that names both figures.

## Before each request

`fitContext` runs before every request, including the rounds inside a turn. A
subagent runs one long turn, and a main session running tools can cross the
window in the middle of one, so a check at turn boundaries alone would miss
both. It runs before `round.started`, so a compaction is never drawn inside the
round it made room for.

- At or under the threshold, nothing happens.
- Over the threshold and within the usable space, the conversation is summarised
  through the cache.
- Over the usable space, the summary request would not fit either, so the
  session shrinks the history the way it does after a refusal (below).

If the context is still over the threshold after that, the session stops trying
for the rest of the turn. Without the guard, a conversation whose kept tail
alone is over the threshold would be summarised before every round. The next
turn tries again.

The check does nothing when automatic compaction is off. That is one setting
for every session, stored as `context.auto` in the config and on when unset. The
toggle in the context panel writes it over `config:set-auto-compact`, and the
main process hands it to every live session and each session's spawn host, so a
running turn and its subagents pick it up on their next request.

## Compacting with the cache intact

The session has already paid for its prefix to be cached, and a summary request
that repeats that prefix byte for byte is a cache read. The cache belongs to
the model that wrote it, so the summariser is the session's own model. The
summary request is exactly the request the session would send next, with one
more user message carrying `SUMMARY_INSTRUCTION`. The tools stay in the request
because removing them changes the prefix, and the instruction tells the model not
to call any. The effort and output ceiling stay too, because some wires fold the
thinking settings into the cache key.

The instruction asks for a checkpoint of about 8,000 tokens under fixed
headings: the task, decisions and why, files read and changed, commands and what
they showed, open problems, and the next step. It asks for paths, identifiers,
error messages and numbers verbatim. The answer is kept whole when it runs long,
since cutting a summary loses its end, which is where the most recent state
sits.

A summary answer that calls a tool or carries no text is asked for once more. A
second failure falls through to the flattened summary described under the
refusal path, which loses the cache and asks nothing of the model beyond writing
text. If that fails too, the session writes a note and the round goes ahead
uncompacted. A summary request that fails outright writes a note of its own,
with the provider's error, as it happens.

Every summary request is billed through `addHarnessUsage`, beside approval
checks, at the session model's price, so the spend view counts it and the tokens
panel shows it under harness. A compaction the user starts runs between turns
and belongs to no turn, so the main process writes its spend to the usage log as
a line of its own (`cost.md`).

## The summary and where it goes

The answer is stored as a user message with `summary: true`, appended at the
end of the messages, where the compaction happened. The window draws it there
(`ui.md`). `Session.wireMessages()` sends it first, straight after the system
prompt, wrapped in `<compacted-summary>` tags so the model can tell a checkpoint
from something the user typed. The next compaction folds the previous summary in
with everything else, so there is only ever one live summary.

What stays verbatim after the summary is 16% of the room, counted back from the
newest message with the calibrated estimator, with a pruned result sized in the
shortened form it goes out in. That holds the last few rounds the model is
working from and leaves the context well under the threshold once the rest is
summarised. `planCut` keeps at least the newest round, so the model always sees
what it just did. The cut lands on a message boundary and never on a tool
result: a result sent without the call it answers is a request every wire
refuses, so the kept tail starts at a user or an assistant message.

The current turn's user message stays verbatim wherever the cut falls. When the
cut lands inside the current turn, which is the ordinary case for a subagent,
that message is left out of the summarised range and goes out after the summary
with the tail. A subagent's whole life is one turn, and summarising its task
would leave it working from a paraphrase of its own orders. Kept verbatim, the
message gives it the orders it was actually given.

The summary goes out as a user message, and so does the first kept message
after it. The OpenAI-compatible wires accept two user messages in a row. The
Anthropic builder joins them as separate text blocks in one message, the way it
already joined consecutive tool results (`providers.md`).

The request after a compaction pays a cache write for its new message prefix.
The system prompt and tools before it stay cached.

## When the provider refuses

The normal path runs on an estimate, and an estimate can be low. A provider that
refuses a request as too long is the definitive answer. `isContextOverflow` in
`src/core/provider.ts` recognises one by shape: status 413, an error code of
`context_length_exceeded` or `request_too_large`, or a message saying the prompt
or context is too long or over the window. A 5xx or a 429 that mentions the
context is left to `isRetryable`, since waiting is the answer to both.

The rescue runs once per round and only when automatic compaction is on. With it
off, the refusal ends the turn with the provider's error, which is what the
panel warns about. The refusal proves the request was at least the window less
the reserve, so the calibration factor is raised to meet that before anything
else is measured. The user's limit plays no part here: a limit above a window
nobody has stated would raise the factor past what the refusal proves, and
with no window known the factor is left as it was.

By the time the provider has refused, the cache is lost, so the rescue does not
try to keep it. It first prunes every tool result over 8,192 characters, the
newest included, down to its first 4,096 and last 1,024 characters with a line
saying how much was removed. A single oversized output in the last round is the
likeliest reason a request stopped fitting. The threshold is about 2,000 tokens,
so a result under it costs little to send whole. Pruning costs no request. If
the ledger is still over the threshold, the rescue summarises a flattened copy
of the history: no tools, no session prompt, plain text, every tool output cut
to 2,000 characters, pictures left out and only counted, and the whole within
half the usable space, since the
estimate has just been shown to run low. The previous summary goes in first and
is counted before any message, because it is the only record of what is older,
and the oldest messages are left out when the rest will not fit. Then the round
is asked for again. The rescue is not a retry of the same request, so it spends
none of the round's retries on a transient error. A second refusal ends the turn
with the provider's error.

The check before each request takes the same path when the context is already
over the usable space.

## Markers and the wire view

Compaction deletes nothing. A message carries `compacted: 'compacted'` when it
went into a summary and `compacted: 'pruned'` when it is a tool result that goes
out shortened. `wireMessages()` builds what the provider sees from the full
history: a compacted message is skipped, a pruned one goes out in its shortened
form, and the summary goes first. The shortened form is computed from the stored
content each time, so the marker is the only thing a compaction writes into a
message.

After any compaction the session drops the anchor and calls
`ReadIndex.dropSpans()`. The lines a file was read at may have gone into the
summary or been shortened, so `read` serves them again instead of answering that
the model has already seen them (`tools.md`). It then records the compaction
(when, why, the size before and after), emits `context.compacted` with the
summary and the ids of the pruned tool calls, and writes a note:

```
Compacted automatically: 12 messages summarised, context 151k to 41k tokens.
```

## Compacting by hand

"Compact now" in the context panel calls `session:compact`. The main process
builds the session if nobody has sent to it since launch, runs
`Session.compact()`, saves the transcript and the ledger, and returns whether
anything was compacted. The window then reloads the session to draw the result.
It summarises exactly as the automatic path does and reports what the summary
requests cost.

It runs between turns. The button is disabled while a turn runs, since the turn
already checks before every request. `Session.compact()` refuses while a turn
holds the session, and `run` refuses while a compaction does, so the two can
never rewrite the same history at once.

Stop ends a compaction the user started and leaves the history as it was, with a
note saying so. It leaves background subagents running, since they belong to an
earlier turn, which Stop during a turn does not. Stop during an automatic
compaction ends the turn it was part of, subagents with it.

## Subagents

A subagent is its own `Session` running one long turn, so the check before every
request covers it with no extra code, and it compacts on the same rules and the
same setting as the main session.

A clone copies the parent's history (`cloneHistory()` in `src/core/spawn.ts`)
with the markers on it. `Session` copies every message it is given, since
compaction marks messages in place, so a clone that compacts leaves the parent's
alone. The child builds its request
through the same `wireMessages()`, so its prefix is the parent's byte for byte
and its first request reads the parent's cache.

Each child emits its own `context` events under its job id, and its stored
record keeps the ledger it ended with. The subagent view draws the same meter
from them (`ui.md`), without the controls.

## Settings and a live session

Facts are resolved when a session is built, and a settings save that changes
only prices, limits or the window does not rebuild anything. `refreshFacts` in
`src/main/index.ts` hands the new facts to every live session through
`Session.setFacts`, which passes them to its spawn host, and each emits a new
`context` event. A window typed in mid-turn takes effect from the next request.

## Events, IPC and persistence

Three events carry the context, each under a subagent's job id when a child
sends it, as `usage` does:

- `context` carries the ledger, whenever it changes: a new user message, a
  finished round, a tool batch, a compaction, a settings change.
- `context.compacting` says a compaction has started and why (`auto`, `manual`
  or `overflow`), so the window can show it before the summary request returns.
- `context.compacted` carries the reason, the size before and after, how many
  messages were summarised, the ids of the pruned tool calls and the summary.

The transcript stores `compacted` and `summary` on each message, so a reopened
session rebuilds the same wire view. The session record stores the last ledger,
so the meter shows a session opened from the list as it was left, marked as
such, before anything has been sent. The compactions and the calibration in it
are handed to the rebuilt session, so the panel's history carries on across a
restart and the first estimate is as good as the last one. A stored ledger
missing a field it now needs is dropped whole, and the meter stays empty until
the session sends again.

## Defaults

These are constants in `src/core/context.ts`, `src/core/compaction.ts` and
`src/core/session.ts`. Only the automatic toggle, the limit and the window are
settings.
They are borrowed and have not been measured on our own task mix.

| Setting | Default | Source |
| --- | --- | --- |
| reserve | declared output ceiling, else min(20,000, `maxOutput`) | opencode `overflow.ts`, plus the wire rule above |
| automatic threshold | 80% of the usable space | deepseek-harness compacts at 0.8 of the window |
| kept tail | 16% of the room | deepseek-harness `retainRatio` |
| context limit | none | the user |
| summary length asked for | about 8,000 tokens | deepseek-harness `maxTokens` |
| summary attempts | 2 | deepseek-harness `compactionRetries` |
| rescues per round | 1 | deepseek-harness `maxOverflowRetries` |
| prune threshold, kept head, kept end | 8,192, 4,096, 1,024 characters | deepseek-harness pruner |
| flattened tool output | 2,000 characters | opencode `compaction.ts` |
| flattened history | half the usable space | ours |
| calibration | first sample whole, then 30% steps, clamped to [0.5, 2] | ours |

## What the other harnesses do

Claude Code's source is not public, so its column comes from its changelog.

| | opencode | deepseek-harness | Claude Code | nanoharness |
| --- | --- | --- | --- | --- |
| when | reported total reaches window minus reserve | 0.8 of the window | about 967k on a 1M window, and on "prompt too long" | 80% of window (or the user's limit) minus reserve, and on a refusal |
| summary request | no tools, no system, flattened text | same system, tools and messages, instruction appended | reuses the conversation's system prompt and hits the cache | as deepseek-harness |
| kept tail | 25% of usable, clamped to 2k to 15k | 16% of the window | not stated | 16% of the room, cut on safe boundaries |
| pruning | off by default; protects the last 2 turns and 40k tokens | long results cut to head and end | not stated | after a refusal, or past the usable space |
| history | not checked | not checked | full history kept in scrollback | kept, with markers and a divider |
| meter | not checked | anchor plus estimated delta | `/context` breakdown | anchor plus calibrated delta, per part |

Pruning runs only once the cache is already lost, because every prune on the
normal path changes the prefix and throws the cache away. The cut can fall
inside the current turn, with the user message kept after the summary, because
a subagent's whole life is one turn.

## Open questions

Before the defaults are called tuned, a handful of long sessions from our own
work should be replayed through a mock provider with their recorded usage, to
see where compaction runs and what the summary drops.

The figure for an image is one wire's published rate. Nobody has yet held it
against what the other wires report for the same picture.
