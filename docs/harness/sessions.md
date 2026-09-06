# Sessions, folders and scope

A session belongs to a folder. You add a folder to the sidebar, start a session
inside it, and that folder is the session's root for as long as it exists —
its working directory and the boundary every tool is held to.

Files:
- src/core/scope.ts — path containment: `..`, absolute paths, symlinks, `~`
- src/main/workspace-store.ts — folders, sessions and transcripts on disk
- src/main/permission.ts — the prompt a tool waits on when it reaches outside
- src/core/prompt.ts — the system prompt: where the session stands, and the rules

## What the agent is told

A session's system prompt is built per session (`buildSystemPrompt`), not
hard-coded, and it names the four things the model cannot see and will otherwise
invent: the workspace root, the platform, the shell, and today's date. On
Windows it says outright that `bash` is Git Bash and not WSL — there is no
`/mnt/c` and no `/proc` — because a model without that line reasons from its
training set, decides it is on Linux, and spends a turn probing a filesystem
that does not exist.

The rules that follow are short on purpose: every token is paid for on every
request of every turn. Stay in the workspace and say why when you cannot. Prefer
relative paths. Do the task that was asked, and do not explore the machine.
Ask about a gap in the request rather than inventing work to fill it — an agent
handed "spawn three subagents, one of them a weather job" will otherwise make
the other two up. Read before editing. Do not retry a failed call unchanged.

## Stopping a turn

Stop is cooperative. `Session.stop()` aborts the in-flight request through an
`AbortController` that is handed to the provider as `fetch`'s `signal`; the
abort ends the stream, and the loop winds down at the next boundary rather than
being killed mid-write. Whatever arrived before the abort is kept, and any tool
call the stop landed on top of gets a tool message saying it never ran —
otherwise the next request would carry a `tool_use` block nothing ever answered,
which both APIs reject. The turn ends with `session.stopped`, and the session
can be asked to continue.

## The sidebar model

| thing | is | lives in |
|---|---|---|
| workspace | a folder on disk | `workspaces.json` |
| session | a conversation started inside one folder | `workspaces.json` |
| transcript | the messages of one session | `sessions/<id>.json` |

The index and the transcripts are deliberately separate files. The sidebar
draws itself from the index alone, so opening the app reads one small file no
matter how much has been said in how many sessions.

A workspace is a directory the user picked, resolved through symlinks, and
never stored twice: adding the same folder again returns the entry that is
already there rather than splitting its sessions across two identical groups.
Removing a folder removes its sessions and their transcripts, and touches
nothing on disk inside it.

A session is named after the first thing asked of it, trimmed to one line. That
is the only automatic rename; later messages just move it up the list.

Transcripts are written after a turn completes, not while it streams. A
half-finished answer is not a message, and a crash mid-turn leaves the session
exactly as it was before the message was sent. What is stored is the
conversation the model sees — user text, assistant text, tool calls and their
results. Thinking is not part of that, so a re-opened session shows no thinking
blocks, only what was said and done.

Re-opening a session rebuilds it with that transcript as history, so the model
picks up the thread. The system prompt is not restored from the file; it is
built fresh each launch, because a stored one would silently freeze whatever
the harness said about itself the day the session started.

## Scope

The rule is one sentence: a tool may touch the session's folder and nothing
else. Enforcing it takes a little more than a `startsWith`, which is why it
lives in `scope.ts` rather than in each tool:

- a relative path can walk out with `..`;
- an absolute path ignores the root entirely;
- `~` is the home directory, and resolving it as a relative path would put it
  *inside* the root — the opposite of the truth;
- a symlink inside the root can point anywhere on disk, and a file that does
  not exist yet cannot be resolved at all, so the check walks up to the deepest
  existing ancestor, resolves *that*, and re-appends the rest.

Only after all of that is the path compared with the root.

The `read`, `write` and `log_improvement` tools ask the gate before they touch
anything. `bash` is the awkward one: a command line is not a path list. Every
path-shaped token in the command is checked — absolute paths, `~`, anything
walking through `..` — and the command runs with the root as its working
directory, but a path built at runtime out of variables will not be caught.
That is a screen, not a sandbox, and the ledger says so.

## Asking

Outside the root the turn stops and waits for the person at the keyboard. The
prompt names the *resolved* path, after symlinks and `..` have been followed,
because seeing where the agent actually ended up pointing is the entire point
of asking.

Three answers, and they mean what they say:

| answer | effect |
|---|---|
| Allow once | this one path, this one time |
| Allow for this session | that directory, until the app closes |
| Deny | the tool gets an error and the turn carries on |

"Allow for this session" grants the directory rather than the single file. A
tool let at one path in a folder invariably wants its neighbours next, and
prompting per file is how people learn to click yes without reading.

Grants live in memory. Closing the app forgets them; nothing on disk records
that a session was ever allowed out of its folder.

Two things cannot be answered, and both resolve to a denial rather than a hang:
a prompt for a session that is not the one on screen, and a prompt whose window
went away. A tool waiting on a promise that can never settle would park the
turn forever.
