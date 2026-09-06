# Agents, spawning and background jobs

Three roles, one at a time in the window, and a way to hand a piece of work to
a second agent without leaving the conversation. Plan §5.

Files:
- src/core/agents.ts — the role registry: tools, shell, default effort, brief
- src/core/spawn.ts — the spawn host: how a subagent is built and run
- src/core/jobs.ts — the job registry: what a background subagent reports through
- src/tools/spawn.ts — the `spawn` tool the model calls
- src/tools/job-update.ts — the `job_update` tool a background job reports with

## The three roles

A role is not a personality. It is the set of tools the agent gets, how hard it
thinks by default, and the paragraph of context worth paying for on every
request.

| role | may write | shell | default effort | extra context |
|---|---|---|---|---|
| Builder | yes | full | medium | none |
| Planner | no | guarded | high | none |
| Harness editor | yes | full | low | doc index and the ledger |

The planner is the one role that cannot change a file, and that is why it is
also the one worth paying thinking tokens for: its entire output is reasoning,
so nothing is lost by making it reason harder. The harness editor is the other
way round — it works from a ledger entry that already says what to do — but it
is the only role that gets extra context, because "fix the thing" only becomes
an edit in the right file if the agent knows which file that is. It is read
from the workspace's own `doc-map.md`, so it is empty when the open folder is
not NanoHarness; a stale index would be worse than none.

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
| `distinct` | the role's own | none | the isolation is the point |
| `clone` | the parent's, byte for byte | the parent's | almost always |
| staying in this loop | — | — | sequential work |

Staying in the loop is not a mode in the schema, because it is what happens
when nobody calls `spawn`. The tool's description says so outright: splitting
sequential work across agents costs far more and finishes no sooner.

The economics are the whole design. A provider's prompt cache answers a request
whose leading bytes it has already seen, so a clone — same system prompt, same
tool definitions, same history, differing only in the task appended at the end
— is paid for mostly at the cached rate. That is also why clone mode passes the
parent's exact tool array rather than a filtered one: dropping `spawn` from a
clone's list would be tidier and would invalidate precisely the bytes the mode
exists to reuse. `spawn` travels with the clone and refuses when it is called,
which costs nothing unless the model tries it.

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

Model and provider. Both come from the active configuration, and a subagent
runs on the same model as its parent — a role that silently switched models
would make the cost of a turn unpredictable in the one place the user is not
looking.
