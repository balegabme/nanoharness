# Agents, spawning and subagent jobs

Three roles, one at a time in the window, and a way to hand a piece of work to
a second agent without leaving the conversation. Plan §5.

Files:
- src/core/agents.ts — the role registry, with tools, shell and brief
- src/core/spawn.ts — the spawn host, how a subagent is built and run
- src/core/jobs.ts — the job registry, every subagent this window has run, waited on or not
- src/tools/spawn.ts — the `spawn` tool the model calls
- src/tools/job-update.ts — the `job_update` tool a background job reports with

## The three roles

A role is the set of tools the agent gets and the paragraph of context worth
paying for on every request. None of it is a personality.

| role | may write | shell | extra context |
|---|---|---|---|
| Builder | yes | full | none |
| Planner | no | guarded | none |
| Harness editor | yes | full | where the harness is, plus the doc index and the ledger |

The planner is the one role that cannot change a file. The harness editor gets
the doc index on top, because "fix the thing" only becomes an edit in the right
file if the agent knows which file that is. The index is read from the harness
checkout's own `doc-map.md`, so it is empty when the app is running from a
packaged install with no `docs/` beside it; a stale index would be worse than
none.

Only the harness editor is told the three facts about the harness itself: the
folder its source is in, the path of the doc map, and the exact command that
runs its CLI. Builder and planner are told none of them, and that exclusion is
what keeps their handoff rule honest. An agent whose prompt never names the
harness cannot wander into its source, so a question about the harness has
exactly one route, which is the subagent. Telling every role the location and
letting each price delegation for itself does not survive contact: reading one
file directly looks cheaper than a subagent, and the role goes exploring
mid-answer. The editor does keep the CLI fact, because it is the one that does
the configuring. `nh mcp add` exists, and it can be run by the only agent that
is ever asked to.

### Harness work goes to a subagent

Builder and planner sessions both carry the same handoff rule, and it has no
pricing in it. Anything about NanoHarness itself goes to a harness-editor
subagent, spawned `distinct`: changing it, configuring it, adding an MCP server
or a skill, or a question about how it behaves. A distinct subagent does not
carry the rule: it has no `spawn` tool, and a prompt that names a tool the agent
was never given is an instruction it cannot follow.

A question is answered directly only when the answer is already in the
conversation. Anything else would mean reading the harness, and the parent's
prompt does not say where it is. The subagent's prompt does, along with the doc
index that turns "how does X work" into one file opened instead of a search. The
subagent also starts small, so it finishes in a couple of rounds where the
parent would grind through the same reading on top of a long context it is
paying for on every request.

Writing to the harness is always the subagent's, including the case where the
parent has figured out the file and the path on its own, and the case where a
single command would do it. That last clause is not hypothetical: the MCP block
used to hand every writing role the `nh mcp add` line, and a builder read that
against the delegate rule, argued the two out in its own thinking and ran the
command itself. Now the commands and the entry shape go only to the
harness-editor, which cannot spawn, and a spawn-capable agent gets neither, so
there is nothing to weigh.

The parent is told what to hand over and not how to do it: the outcome, and
whatever the user gave it quoted verbatim, such as a URL, a key or a command
line, because a distinct subagent cannot see the conversation it was summoned
from. The subagent is asked to report the files it touched and
the diff, because its last message is the whole of what the parent gets, and a
claim with no diff behind it is a claim. It also has to say that a harness
change reaches the running app only after a rebuild and a restart, instead of
reporting it as live.

Effort is not in that table. Every agent, in the window or spawned, runs at the
session's own effort. A per-role default would be a second setting for one
decision, and the setting the user can see, the effort chip on the composer,
would not be the one in charge.

The registry is data. Three separate consumers have to enumerate the roles: the
session builder in `src/main/index.ts`, the `spawn` tool's JSON schema, and the
role chip on the composer. A list is the only shape all three can read.

Switching the role of an open session retires the live `Session` and rebuilds it
from the stored transcript on the next message. The system prompt and the tool
list are decided at construction, so changing either in place would leave the
model holding tools its prompt never mentioned.

### The planner's shell

`GUARDED_BASH_TOOL` is the ordinary shell with `writeGuard` in front of it: one
pass of patterns over the command line, refusing redirects, `tee`, the file
verbs, in-place `sed`/`perl`, mutating git subcommands, package installs,
`curl -o`, and the PowerShell equivalents. A refusal explains itself in the
words of the role, *this agent reads but does not write*, instead of as a policy
error, so the model's next move is to answer rather than to look for a way
around it.

It is a screen and not a security boundary. A command that builds its target at
runtime, or writes through a program the patterns do not name, gets through. The
real answer is a sandbox, and the ledger says so.

## Spawning

Three ways to hand work to another agent, cheapest last:

| mode | prompt | history | when it is worth it |
|---|---|---|---|
| `distinct` | the named role's own | none | the work needs another agent, or must not see this conversation |
| `clone` | the parent's, byte for byte | the parent's | more of the work already in progress |
| staying in this loop | none | none | sequential work |

Staying in the loop is not a mode in the schema, because it is what happens when
nobody calls `spawn`. The tool's description says so outright: splitting
sequential work across agents costs far more and finishes no sooner.

### Writing the task

The task states the outcome the parent wants. The parent quotes whatever the
user gave it, a URL, a key, a command line, because the child cannot see the
conversation, and then stops there: no file to edit, no field names, no format,
no command to run. The parent has not read the code it is delegating into and
the child has. A guess that reaches the child arrives as a requirement, and the
child spends its rounds satisfying or disproving it.

Asked to install an MCP server, one parent wrote *"an HTTP entry with `url` and
`tokenEnv` fields … decide the correct layout"*. `tokenEnv` was its own
invention, and it contradicted the endpoint, which takes its key in the query
string. The child spent fifteen rounds and 130k tokens settling a contradiction
nobody had, and wrote a field the server will never use. The same request,
handed over as *"install this MCP server in the global config, here is the URL
verbatim"*, was four rounds: `nh mcp --help`, `nh mcp add`, verify, report. The
harness editor is told the reverse of the rule as well: a task that names a file
or a field is to be read as a guess and corrected in one line, rather than
researched to exhaustion.

### Choosing a mode

`clone` is much cheaper, and a tool description that says only that gets one
answer to every question. So the description names the work each mode is for
instead of leaving the model to price it:

- clone: the delegated piece carries on this conversation. Another pass over the
  file both agents are looking at, a search whose terms only make sense from
  what was just said, more of a job already under way.
- distinct: this conversation would bias the answer, or is beside the point. A
  fresh read of code the parent has already characterised, an independent
  estimate, a question about a part of the repo this session has not touched.

The case that decides the rule is review. A clone asked to check the work of the
turn that spawned it has read the reasoning behind that work, and it will agree
with it, which is the one thing a check must not do. So a reviewer, verifier or
critic is always `distinct`, and the description says that in as many words. The
default stays `clone`, because most delegated work really does continue the
conversation, and the expensive mode now has a stated job of its own on top of a
price.

The economics are the whole design. A provider's prompt cache answers a request
whose leading bytes it has already seen, so a clone is paid for mostly at the
cached rate: same system prompt, same tool definitions, same history, differing
only in the task appended at the end. That is also why clone mode passes the
parent's exact tool array instead of a filtered one. Dropping `spawn` from a
clone's list would be tidier and would invalidate precisely the bytes the mode
exists to reuse, so `spawn` travels with the clone and refuses when it is
called, which costs nothing unless the model tries it.

A clone is the parent's prompt and the parent's tool list, so a clone is the
parent's *role*, and there is nothing else it could be. A request to clone as
another role would otherwise be accepted and quietly ignored, labelling the job
`planner` while a builder ran it. The host resolves that pair itself, running the
named role distinct and reporting the mode it actually used, so the label and the
agent agree.

The clone's history stops one message short of the parent's. The `spawn` call is
the last thing in the parent's transcript and has no result yet, because the
parent is inside it, and a provider refuses a conversation that ends on an
unanswered tool call outright (OpenAI: *an assistant message with `tool_calls`
must be followed by tool messages*). `cloneHistory` cuts the in-flight turn
instead of inventing a result for it, which leaves the clone starting from the
user's own last message.

Nothing nests. A subagent is built without a spawn host, so `spawn` inside one
answers *a subagent cannot summon another one*. One level of delegation is
enough to parallelise real work, and a tree of agents spending each other's
budget is the failure mode that ends with an empty account.

A subagent runs against the parent's own access gate: it is held to exactly the
session's folder, and a path outside it prompts the person at the keyboard the
same way. Its own stream goes to an `EventBus` of its own, so its thinking and
its tool calls do not scribble on the transcript the user is reading. That bus
has a listener: the window supplies one per subagent, tagged with the subagent's
session id, which is what lets the window draw a subagent working exactly the
way it draws the main agent (see `ui.md`). What comes back is its last assistant
message, with a line of usage appended so the conversation shows what the
delegation cost, and a `[subagent:<id>]` marker that ties the result to the
child's own stored transcript.

That message comes back whole. There is no length limit on an answer: the
model's own output limit is the bound, and that is a real one in the right
place. A second limit inside the harness would only remove the end of a finding,
and remove it silently. The parent reads a tool result as the whole of what the
subagent found, so a review whose verdict was in its last paragraph would arrive
as a review with no verdict. The job row in the sidebar shows the answer's first
line, clipped to 200 characters, because a row is a label and the answer is one
click behind it.

A subagent's tokens are the parent's tokens. They are spent on the parent's key,
against the parent's budget, on the parent's say-so, so the parent's counter
includes them. The window rolls each usage event a subagent emits into the
parent session's running total as it arrives, as a delta against what that child
had already reported, so the same tokens are never counted twice. That puts
subagents into the count in real time, while they are still running. It does
not put them into the tok/s rate: a spawn generates at the same moment its
parent does, on a stream this session never timed, so there is no interval the
two of them share to divide by. The rate stays the parent's own.
A background subagent that outlives its parent's turn keeps
adding to the same total, and the total is written back to the session index
when it finishes, so a reopened session shows what it really cost.

Every subagent's whole conversation is kept. The host takes a `save` hook, and
the window uses it to write the child's messages and notes to a transcript file
of its own beside the parent's (see `sessions.md`) on every path out: done,
failed, stopped. The answer is what the parent needs to carry on, and a person
debugging the subagent needs everything behind it.

A write that fails does not fail the turn, since the answer the parent is
waiting for is already in hand and losing it over a file would be the worse
trade. It is not swallowed either. The host takes a second hook, `problem`, and
the window points it at the session's own notes, so the failure is drawn where
the user is already looking and stored in the transcript beside the turn it
belongs to. This matters because the tool result carries `[subagent:<id>]`: the
window offers to open a conversation that was never written, and a silent
failure means the user finds that out by clicking it. A caller that supplies no
`problem` gets stderr. There is no arrangement in which the error goes nowhere.

## Jobs, in the background and not

Every spawn gets a registry entry, and the entry's id **is** the subagent's
session id, which is what lets its stream events reach the window already tagged
with something the renderer can route. `job.started` when it is created,
`job.update` for each line it posts with `job_update`, `job.finished` when it
ends. The window follows those to keep a running subagent's view current (see
`ui.md`). There is no list of subagents to draw, because one is opened from the
`spawn` call that made it.

`spawn` with `background: true` returns a job id immediately and lets the turn
carry on; without it the parent's turn is blocked until the subagent answers.
The `background` flag on `JobView` is the difference, and it decides three
things: whether the child gets `job_update`, whether the parent's journal gets
notes about the job, and whether the window says the parent's turn is waiting. A
foreground job gets no notes, because its answer arrives as a tool result and a
note would be the same event told twice.

A background job's answer comes back to the model, and not only to the window.
The spawn host hands the finished answer back through `finished`, the window
passes it to `Session.deliver`, and the session folds it into the conversation
as a message: whole, with the task it came from and whether the job ended `done`,
`failed` or `stopped`. Without that the parent gets a note holding the first
line, and the model never sees a note, while the whole answer sits on disk under
the app's data directory, outside the workspace the agent may read. An agent that
started three jobs and was asked to combine what they found would have no way to
do it and no way to say why.

A job that never finishes is written down too. Jobs live in memory and die with
the process, so quitting the app used to end a background subagent in silence:
one session's last message said a reviewer's report would land when it was
ready, the app closed a few minutes later, and the reopened conversation held
no report and no reason. `JobRegistry.abandon` now ends everything still
running as `stopped` on the way out, and the main process delivers one message
per background job into the conversation that started it, saying what it was
asked and that its answer is gone. The `spawn` description says the same thing
up front, so an agent does not finish its work on the promise of a job that may
not come back.

The timing is the whole of it. A registry belongs to a window and is dropped
when that window's `webContents` is destroyed, so this runs on `before-quit`,
which fires while the windows are still up, and not on `will-quit`, which fires
after the last of them is gone and would find nothing to abandon. The delivered
message is then flushed into the transcript rather than queued: a turn is
usually still in flight, that is what background means, and the queue is
drained at the end of a round that is not going to come.

The answer is queued rather than pushed, because a job finishes whenever it
finishes and a message inserted between a tool call and its result is a request
both providers reject. It is flushed wherever the transcript is balanced, which
is every place one can be: the end of a round, the end of the turn, the top of
the next turn before the user's own message, and immediately when no turn is
running at all. So a job started early in a long turn is usable before that turn
ends, one that finishes in the turn's last round is not stranded there, and one
that lands while the user is away is written to the transcript on the spot. A
session is retired whenever settings are saved, and a queue nothing is coming to
drain loses what is in it. The `spawn` description says all of this, so the model
does not go looking for an output file.

The foreground case has an entry too. Without one it is the least visible thing
the harness does: the window sits there for a minute with nothing to say what it
is waiting for. A foreground spawn's tool card becomes a way into the subagent
the moment the job starts, instead of when it answers.

Only a background subagent is given `job_update`. In the foreground the parent is
already waiting for the answer, so a progress note would be a message to nobody.
`job_update`'s note and `spawn`'s task are both `keepsPlaceholders` tools; see
`secrets.md`, and read the reason there before writing another tool like them. A
background *clone* has no `job_update` either, for the cache reason above. It
reports once, when it finishes.

The registry holds what is running and nothing else. An entry is dropped as soon
as its job finishes, because by then the child's whole conversation has been
written to disk and the transcript is the record. A job is a thing that is
happening, and one that was happening when the app was killed cannot be resumed:
its subagent died with the process, and what survives is whatever it wrote to
disk before it stopped. Every path out of a job ends in `finish`, so a thrown
error cannot leave a job running in the list.

`stopAll()` stops every subagent the host still has running. `Session.stop()`
calls it before aborting its own request, so the stop button ends the whole tree
the turn started, down to the background subagents, which by then are the only
thing still spending. A subagent stopped that way finishes as state `stopped`.

## What a role does not decide

Model, provider and effort. All three come from the active configuration, and a
subagent runs on the same settings as its parent. A role that silently switched
any of them would make the cost of a turn unpredictable in the one place the
user is not looking.
