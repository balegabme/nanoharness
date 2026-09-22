# Auto mode: approving an action with a model

Files:
- src/core/approval.ts: the rules, the prompt, the ladder and the verdict

A session answers permission questions in one of two modes. In `ask`, the
default, anything the scope rule cannot settle stops the turn and waits for the
person. In `auto` a second model is put
in front of that prompt: it answers the questions it is sure about and hands the
rest over.

The mode lives on the session's `GateState` (`src/main/permission.ts`), so
switching it takes effect on the next tool call and not at the next session.

The choice is also stored, and stored app-wide: switching one session sets what
the *next new* session starts in, while every session already open keeps the
mode it is in. A mode forgotten at every restart is a mode nobody keeps on, and
per-session persistence would mean finding the switch again for every session.
The chip's tooltip says so, because a preference that reaches sessions the user
was not thinking about is one they should not have to discover.

## What reaches the judge

Only what would otherwise have put a dialog on screen. Work inside the session
folder never asks and never costs an approval call; `src/core/scope.ts` settles
it. That leaves two kinds of question, and they are the two the judge sees:

- A path outside the session folder, resolved, with symlinks and `..` already
  followed.
- A shell command, whole and redacted. A command line is a program, and
  nothing here reads it for paths. `sessions.md` has why that screen was
  removed.

## What the judge is shown

Three things:

1. The rules (below), as a system prompt, stable across a session, so it is the
   part a provider's cache can answer.
2. The user's own messages, newest last, bounded and each cut to length.
3. The action, fenced and labelled as data.

Not the assistant's messages, and above all no tool results. Tool output is the
part of a conversation somebody else can write into: a file the agent read, an
MCP server's answer, a fetched page. A judge that reads it can be argued into
an approval by the very thing it is judging. `goalsFrom` is where that line is
drawn, and `approval.test.ts` pins it with a tool result that tries to give
orders.

The user's words are in for one reason: without them the soft-deny tier cannot
work. "Discard my uncommitted changes" and a model deciding to run
`git reset --hard` on its own initiative are the same command and different
events, and only the transcript's user half tells them apart.

## The rules

Four buckets, in precedence order. Each one is a sentence, since the judge is a
language model and a list of command names is a list somebody has to maintain,
wrong the first time a project uses a tool nobody thought of.

- `hardDeny`: refused whatever the user asked for. Nothing overrides it.
- `softDeny`: refused unless the user's own words call for this specific thing.
- `allow`: ordinary work; runs without asking.
- `environment`: facts about this machine that change what counts as ordinary.

`DEFAULT_RULES` is what a fresh install runs with. A user's own rules are added
to each bucket, never substituted: a settings file that could drop the
never-allow list by supplying one extra allow rule would be a permission system
that fails open, and fails open silently. `mergeRules` is that guarantee.

## The two answers

`allow` and `deny`. There is no third.

Auto mode exists for the run nobody is watching: a task that goes for an hour
while the user is at lunch. A verdict meaning "put it to the person" would park
that run on a dialog two minutes after they left, and it would still be parked
when they got back, which is the exact failure the mode is there to prevent. So the
judge decides, every time, and the prompt tells it plainly that nobody is at the
keyboard and there is no one to defer to.

Uncertainty resolves to `deny`: a denial costs one step of a task that can be
restarted, and a wrong `allow` costs the thing it damaged with nobody there to
stop it. The prompt carries the other half of that instruction too, *do not
deny the ordinary*, because a judge that refuses every build and every test
finishes nothing.

An `allow` skips the dialog. A `deny` stops the tool with a refusal in the
approval step's own name, never the user's: they have not seen it, and telling
the agent "the user refused" is a lie it repeats back to them. The refusal also
names the one legitimate route onwards, which is to stop and say so in words,
because an agent with no route takes the other one and tries the same thing by
another road.

## When the judge cannot be reached

This is the only time auto mode puts a question to the person, and it happens
where there is no verdict to be had: the approval model was unreachable, the
endpoint is down, the key is rejected, the answer never parsed.

The ladder is fought through before that happens. Each rung is retried up to
`JUDGE_ATTEMPTS` times on a
short backoff before the ladder moves on, and only failures worth retrying are
retried: a dropped socket or a 503 is waited out, while an answer that could
not be read is not asked for again, because it would come back the same.
Only when every rung has failed that way does `ApprovalUnavailableError` travel
up, the dialog go up in its place, and the reason get printed on it.

An unreachable judge is never turned into a verdict in either direction. One
that was never reached has said nothing, and reading silence as a yes would be
the fail-open this whole design is built to avoid. Reading it as a no would
refuse work over an outage
that had nothing to do with the action. The person decides that one, and
if they are out, the turn waits. That is the one thing auto mode cannot promise,
and the retries above are what bound it.

Turning the mode on is checked separately and earlier. `approvalProblem` reports
in words when no approval model is configured, and the mode does not switch. A
mode that turned on and then prompted for everything would leave the user
believing actions were being judged when nothing was judging them.

## The ladder

`ApprovalConfig.candidates` is an ordered list of provider-and-model pairs. The
first one that answers wins and is pinned for the session. Plan §15 wants a
stable prefix, and a session whose verdicts came from two judges with nothing
recording the switch cannot be audited afterwards. A rung that fails is
unpinned, so the next question climbs from the top again and never sticks on
something that has stopped working. When every rung fails, that is an error
carrying every reason.

The ladder is re-read from settings on every question, so a provider edited or
deleted in the settings screen takes effect at once.

## What it costs, and where that lands

The judge runs on its own model at its own prices, so its tokens are never the
conversation's. `Session.addHarnessUsage` puts them in the session total, since
the user pays for them, under a separate `harness` split, with the dollars
computed at the approval model's own rate at the moment of the call. The window
adds that figure to the cost of the conversation and never prices those tokens
with the session model's facts, which would charge an approval check at the rate
of the model it was protecting.

## What is written down

Every pass through the judge, verdict or failure, appends one JSON line to
`sessions/<id>.approvals.jsonl` beside the transcript: the action, the verdict,
the rule, the reason, the model, the latency, the tokens and the cost.

Append-only, and separate from the transcript file on purpose. The transcript is
rewritten whole at the end of a turn and a decision happens in the middle of
one, so folding them together would mean a crashed turn losing the record of
what it had been allowed to do, the record whoever investigates that crash
wants most. Nothing draws this file. A decision the user never sees still has to
be one they can go and read, or "why did it do that" has no answer.

## What this is not

It is not a sandbox. A model reading a command is a mitigation, not containment:
an approved command runs with everything the user's own shell has. `SECURITY.md`
says so plainly. The action text is attacker-influenceable, which is why it is
fenced and labelled as data and why tool results stay out of the prompt.
Filesystem and network containment is a separate layer and is not built yet.
