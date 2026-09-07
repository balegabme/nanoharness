# Agents, spawning and background jobs

Three roles, one at a time in the window, and a way to hand a piece of work to
a second agent without leaving the conversation. Plan §5.

Files:
- src/core/agents.ts — the role registry: tools, shell, brief
- src/core/spawn.ts — the spawn host: how a subagent is built and run
- src/core/jobs.ts — the job registry: what a background subagent reports through
- src/tools/spawn.ts — the `spawn` tool the model calls
- src/tools/job-update.ts — the `job_update` tool a background job reports with

## The three roles

A role is not a personality. It is the set of tools the agent gets and the
paragraph of context worth paying for on every request.

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
what keeps their handoff rule honest — an agent whose prompt never names the
harness cannot wander into its source, so a question about the harness has
exactly one route: the subagent. An earlier build told every role the location
and let each one price delegation for itself; reading one file directly looked
cheaper than a subagent, and the role went exploring mid-answer. The editor
does keep the CLI fact, because it is the one that does the configuring: `nh
mcp add` exists and can be run by the only agent that is ever asked to.

### Harness work goes to a subagent

Builder and planner both carry the same handoff rule, and it has no pricing in
it. Anything about NanoHarness itself — changing it, configuring it, adding an
MCP server or a skill, or a question about how it behaves — goes to a
harness-editor subagent, spawned `distinct`.

A question is answered directly only when the answer is already in the
conversation. Anything else would mean reading the harness, and the parent's
prompt does not say where it is — the subagent's does, along with the doc index
that turns "how does X work" into one file opened instead of a search. The
subagent also starts small, so it finishes in a couple of rounds where the
parent would grind through the same reading on top of a long context it is
paying for on every request.

Writing to the harness is always the subagent's — no exception for the case
where the parent has figured out the file and the path on its own, and none for
the case where a single command would do it. That last clause is not
hypothetical: the MCP block used to hand every writing role the `nh mcp add`
line, a builder read that against the delegate rule, argued the two out in its
own thinking and ran the command itself. Now the command only reaches an agent
that cannot spawn, and the rule only reaches one that can, so there is nothing
to weigh.

The parent is told what to hand over rather than how to do it: which change,
which file or scope, and whatever the user gave it quoted verbatim — a URL, a
key, a command line — because a distinct subagent cannot see the conversation
it was summoned from. And the subagent is asked to
report the files it touched and the diff, because its last message is the whole
of what the parent gets: a claim with no diff behind it is a claim. It also has
to say that a harness change reaches the running app only after a rebuild and a
restart, rather than reporting it as live.

Effort is not in that table, and used to be. Each role carried a default — the
planner thought hard, the harness editor barely at all — and switching agent
moved the effort chip under the user's hand. Two settings for one decision, and
the visible one was not the one in charge. Now every agent, in the window or
spawned, runs at the session's own effort.

The registry is data rather than three subclasses. Three separate consumers —
the session builder in `src/main/index.ts`, the `spawn` tool's JSON schema, and
the role chip on the composer — all need to enumerate the roles, and a list is
the only shape all three can read.

Switching the role of an open session retires the live `Session` and rebuilds
it from the stored transcript on the next message. The system prompt and the
tool list are decided at construction, so changing either in place would leave
the model holding tools its prompt never mentioned.

### The planner's shell

`GUARDED_BASH_TOOL` is the ordinary shell with `writeGuard` in front of it: one
pass of patterns over the command line, refusing redirects, `tee`, the file
verbs, in-place `sed`/`perl`, mutating git subcommands, package installs,
`curl -o`, and the PowerShell equivalents. A refusal explains itself in the
words of the role — *this agent reads but does not write* — rather than as a
policy error, because the model's next move should be to answer, not to look
for a way around it.

It is a screen, not a security boundary. A command that builds its target at
runtime, or writes through a program the patterns do not name, gets through.
The real answer is a sandbox, and the ledger says so.

## Spawning

Three ways to hand work to another agent, cheapest last:

| mode | prompt | history | when it is worth it |
|---|---|---|---|
| `distinct` | the named role's own | none | the work needs another agent, or must not see this conversation |
| `clone` | the parent's, byte for byte | the parent's | more of the work already in progress |
| staying in this loop | — | — | sequential work |

Staying in the loop is not a mode in the schema, because it is what happens
when nobody calls `spawn`. The tool's description says so outright: splitting
sequential work across agents costs far more and finishes no sooner.

### Choosing a mode

`clone` is much cheaper, and a tool description that says only that gets one
answer to every question. So the description names the work each mode is for
rather than leaving the model to price it:

- **clone** — the delegated piece carries on this conversation. Another pass
  over the file both agents are looking at; a search whose terms only make
  sense from what was just said; more of a job already under way.
- **distinct** — this conversation would bias the answer, or is beside the
  point. A fresh read of code the parent has already characterised, an
  independent estimate, a question about a part of the repo this session has
  not touched.

The case that decides the rule is review. A clone asked to check the work of
the turn that spawned it has read the reasoning behind that work, and it will
agree with it — the one thing a check must not do. So a reviewer, verifier or
critic is always `distinct`, and the description says that in as many words.
The default stays `clone`, because most delegated work really does continue the
conversation; what changed is that the expensive mode now has a stated job
instead of only a price.

The economics are the whole design. A provider's prompt cache answers a request
whose leading bytes it has already seen, so a clone — same system prompt, same
tool definitions, same history, differing only in the task appended at the end
— is paid for mostly at the cached rate. That is also why clone mode passes the
parent's exact tool array rather than a filtered one: dropping `spawn` from a
clone's list would be tidier and would invalidate precisely the bytes the mode
exists to reuse. `spawn` travels with the clone and refuses when it is called,
which costs nothing unless the model tries it.

A clone is the parent's prompt and the parent's tool list, so a clone is the
parent's *role* — there is nothing else it could be. Asking to clone as another
role used to be accepted and quietly ignored: the job appeared in the strip
labelled `planner`, and a builder ran it. The host now resolves that pair
itself, running the named role distinct and reporting the mode it actually
used, so the label and the agent agree.

The clone's history stops one message short of the parent's. The `spawn` call
is the last thing in the parent's transcript and has no result yet — the parent
is inside it — and a conversation that ends on an unanswered tool call is one a
provider refuses outright (OpenAI: *an assistant message with `tool_calls` must
be followed by tool messages*). `cloneHistory` cuts the in-flight turn instead
of inventing a result for it, which leaves the clone starting from the user's
own last message.

Nothing nests. A subagent is built without a spawn host, so `spawn` inside one
answers *a subagent cannot summon another one*. One level of delegation is
enough to parallelise real work, and a tree of agents spending each other's
budget is the failure mode that ends with an empty account.

A subagent runs against the parent's own access gate: it is held to exactly the
session's folder, and a path outside it prompts the person at the keyboard the
same way. It gets a fresh `EventBus` that nobody is listening to, so its
thinking and its tool calls do not scribble on the transcript the user is
reading. What comes back is its last assistant message, capped at 4000
characters — the parent pays for every word of it — with a line of usage
appended so the conversation shows what the delegation cost.

## Background jobs

`spawn` with `background: true` returns a job id immediately and lets the turn
carry on. The job is a subagent with no one waiting on it, so it reports
through events instead: `job.started` when it is created, `job.update` for each
line it posts with `job_update`, `job.finished` when it ends. The window draws
those in a strip under the session tree (see `ui.md`).

Only a background subagent is given `job_update`; in the foreground the parent
is already waiting for the answer, and a progress note would be a message to
nobody. A background *clone* has no `job_update` either, for the cache reason
above — it reports once, when it finishes.

The registry is in memory on purpose. A job is a thing that is happening, and
one that was happening when the app was killed is not resumable: its subagent
died with the process. What survives is whatever it wrote to disk before it
stopped. Every path out of a job ends in `finish`, so a job cannot be left
running in the list by a thrown error.

## What a role does not decide

Model, provider and effort. All three come from the active configuration, and a
subagent runs on the same settings as its parent — a role that silently
switched any of them would make the cost of a turn unpredictable in the one
place the user is not looking.
