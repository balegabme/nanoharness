# Sessions, folders and scope

A session belongs to a folder. You add a folder to the sidebar, start a session
inside it, and that folder is the session's root for as long as it exists: its
working directory and the boundary every tool is held to.

Files:
- src/core/scope.ts — path containment, `..`, absolute paths, symlinks, `~`
- src/main/workspace-store.ts — folders, sessions and transcripts on disk
- src/main/permission.ts — the prompt a tool waits on when it reaches outside
- src/core/prompt.ts — the system prompt, where the session stands and the rules

## What the agent is told

A session's system prompt is built per session (`buildSystemPrompt`) instead of
being hard-coded, and it names the four things the model cannot see and will
otherwise invent: the workspace root, the platform, the shell, and today's date.
On Windows it says outright that `bash` is Git Bash and not WSL, with no
`/mnt/c` and no `/proc`, because a model without that line reasons from its
training set, decides it is on Linux, and spends a turn probing a filesystem
that does not exist.

The rules that follow are short on purpose: every token is paid for on every
request of every turn. Stay in the workspace and say why when you cannot. Prefer
relative paths. Do the task that was asked, and do not explore the machine. Ask
about a gap in the request instead of inventing work to fill it, because an
agent handed "spawn three subagents, one of them a weather job" will otherwise
make the other two up. Change an existing file with `edit` rather than
rewriting it. Do not retry a failed call unchanged. Ask for
everything you already know you need in one message, since the read-only calls
run together.

Three of them are there because of what a model does when it is *nearly* sure.
"Do not invent a fact about this machine or this project", meaning a path, a
config field, a flag, a format or a convention, because a model that has almost
read something states it as read, and a plausible invented field name is the
most expensive kind of wrong: the next agent treats it as a requirement. "Use
what the project already has", because a repo with a CLI or a task runner has
one command for the job the agent is about to hand-write, and `--help` on it is
one call against the five or ten it takes to derive a file format from the
source that parses it. "Stop when the outcome is done and checked", because an
agent that has finished the task and keeps reading is answering a question
nobody asked. All three came out of one turn: an editor asked to add an MCP
server spent fifteen rounds and 130k tokens deriving the config layout from
`src/`, with the doc that says "neither file has to be hand-written" already
open in its context.

Three came out of one run where the user's first line was that browser tools
are pointless for a model with no eyes. The agent probed for Chrome, Edge, the
puppeteer cache and the playwright cache anyway, twice after being interrupted
to ask why, and each probe was a path outside the workspace, so each one put a
modal in front of the user. So the prompt now says there is no screen, no
browser and no image here, and that work is checked by running it and reading
what it prints. It says that a limit the user states is part of the task, and
that going to look for a ruled-out tool is the same as using it. And it says to
answer an interruption in words before running anything else, because a person
who asks "why do you keep doing that" and gets three more commands has been
ignored.

Two more are there because of what a model does with silence. "Do not install
anything" is scoped to dependencies and machine state, and says so, because an
agent asked to add an MCP server read the unqualified version as covering a JSON
file in its own workspace and refused. The rule after it is the general form:
never state a rule, a permission or a limit you were not given. Asked what it
can do, an agent answers from its tools and its configuration, and something
unconfigured is unconfigured rather than forbidden. A model with nothing to go
on fills that gap from its training set, and a plausible invented policy is much
harder to catch than an error.

## Stopping a turn

Stop is cooperative. `Session.stop()` aborts the in-flight request through an
`AbortController` that is handed to the provider as `fetch`'s `signal`; the
abort ends the stream, and the loop winds down at the next boundary instead of
being killed mid-write. Whatever arrived before the abort is kept, and any tool
call the stop landed on top of gets a tool message saying it never ran.
Otherwise the next request would carry a `tool_use` block nothing ever answered,
which both APIs reject. The turn ends with `session.stopped`, and the session
can be asked to continue.

Stop reaches the subagents too. `stop()` calls `spawn.stopAll()` first, which
stops every subagent this session still has running, foreground and background
alike, before aborting the parent's own stream. Aborting the parent's request
alone would leave the child spending, and a background child would go on
spending after the turn it belonged to was over. A subagent that was stopped
rather than finished ends as state `stopped`, which is neither a result nor a
fault: its note says `Stopped.`, and whatever it had written to disk before then
is kept.

## The sidebar model

| thing | is | lives in |
|---|---|---|
| workspace | a folder on disk | `workspaces.json` |
| session | a conversation started inside one folder | `workspaces.json` |
| transcript | one session's messages, and the notes beside them | `sessions/<id>.json` |
| subagent transcript | one subagent's whole conversation | `sessions/<id>/subagents/<job id>.json` |

The index and the transcripts are deliberately separate files. The sidebar draws
itself from the index alone, so opening the app reads one small file no matter
how much has been said in how many sessions.

A workspace is a directory the user picked, resolved through symlinks, and never
stored twice: adding the same folder again returns the entry that is already
there instead of splitting its sessions across two identical groups. Removing a
folder removes its sessions, their transcripts and their subagents' transcripts,
and touches nothing on disk inside it.

A session is named after the first thing asked of it, trimmed to one line. That
is the only automatic rename; later messages just move it up the list.

Transcripts are written after a turn completes, and never while it streams. A
half-finished answer is not a message, and a crash mid-turn leaves the session
exactly as it was before the message was sent.

The file holds two things, `{ messages, notes }`, because what the window showed
is more than the conversation. The messages are what the model sees: user text,
assistant text, tool calls and their results, plus the thinking blocks, which
are stored because they are what explains the turn. Anthropic signs its blocks
and they go back on the next request. An OpenAI-wire one carries no signature,
so it is kept for the window and the file and never sent; a session that
reasoned for twelve thousand tokens and stored none of it is a transcript with
the explanation cut out, which is exactly the part you want when the turn went
wrong. The notes are everything else the window drew: an error, a stop, a turn
that ended without an answer, a repeated call the harness refused, a background
job starting and finishing, and the summary line every turn ends on. The summary
is a kind of its own, for the reason `ui.md` gives. Each note carries `after`,
the number of messages
written when it happened, so a re-opened session puts it back between the same
two blocks the user saw it between. A file written before notes existed, or one
whose notes are unreadable, opens as a conversation with no notes and no error.

A subagent keeps its own transcript, referenced from the parent's. The parent's
history holds the subagent's final answer as a tool result and nothing more, so
without a transcript of its own there is no evidence anywhere about what went
wrong inside it. Every spawn writes its whole conversation, messages and notes
both, to `sessions/<parent id>/subagents/<job id>.json` the moment it ends,
whether it finished, failed or was stopped. The parent's own transcript carries
a `[subagent:<job id>]` marker in the tool result and in the background job's
note, which is what the window follows to open the child's conversation (see
`ui.md`) and what a person reading the file by hand follows to the right file.
It is written for the case where something has already gone wrong, so it is
written even when the subagent throws.

Stored with that transcript is the subagent's tool count: how many calls it
made, how many worked and how many came back an error. It travels out of a
failure as well as a success, so a job that made forty calls before it broke is
not filed as one that made none. A file written before the count existed has
none, and the line is left out where a zero would read as a claim (see
`agents.md`).

Re-opening a session rebuilds it with that transcript as history, so the model
picks up the thread, and hands it back its notes so the window reads the way it
did live: a turn that stopped looks stopped, a turn that failed looks failed,
and neither looks like a turn that simply had nothing to say. The system prompt
is built fresh each launch rather than restored from the file, because a stored
one would silently freeze whatever the harness said about itself the day the
session started.

## Scope

The rule is one sentence: a tool may touch the session's folder and nothing
else. Enforcing it takes a little more than a `startsWith`, which is why it
lives in `scope.ts` instead of in each tool:

- a relative path can walk out with `..`;
- an absolute path ignores the root entirely;
- `~` is the home directory, and resolving it as a relative path would put it
  *inside* the root, which is the opposite of the truth;
- a symlink inside the root can point anywhere on disk, and a file that does
  not exist yet cannot be resolved at all, so the check walks up to the deepest
  existing ancestor, resolves *that*, and re-appends the rest.

Only after all of that is the path compared with the root.

Windows has one more wrinkle. The shell is Git Bash, which prints `/c/project`
where Windows writes `C:\project`, and a model that has just read a path out of
shell output writes it straight into the next `read`. Taken literally,
`/c/project/file` resolves against the current drive as
`<drive>:\c\project\file`, a path that does not exist, reported as a missing
file. So `normalizeTarget` accepts both spellings and every gate goes through
it. Only `/<letter>/…` is translated: `/usr/bin` has a two-letter first segment
and is left exactly as it is.

The `read`, `write` and `edit` tools ask the gate before they touch anything.
`bash` asks too, but its question is different, because a command line is a
program and not a path list. This project has paid for every attempt to read
one as a list: a heredoc carrying `</script>` became a prompt for `C:\script`,
a Python patch script's `2>/dev/null` became a prompt for `C:\dev\null`, a
browser probe found Chrome and Edge under Program Files and stopped on each, and
a README that contained a URL became a prompt for `e://`. Every one of those
prompts named a place the command was not going, and the command did not run.

So the shell is approved whole. The modal shows the person the command itself,
and the answer is one of the three below. "Allow all shell commands" then covers
the rest of the session, because there is nothing finer to remember: once the
shell is allowed it can reach anything the user can, and the prompt says so.
This is the one place the harness cannot scope what it approves, and a real
boundary would need an OS sandbox; the ledger keeps that entry open. What does
not come back is the parser: paths are resolved where they are used and never
guessed out of a string.

## Asking

Outside the root the turn stops and waits for the person at the keyboard. The
prompt names the *resolved* path, after symlinks and `..` have been followed,
because seeing where the agent actually ended up pointing is the entire point
of asking.

Three answers, and they mean what they say:

| answer | paths | shell |
|---|---|---|
| Allow once | this one path, this one time | this one command |
| Allow for this session | that directory, until the app closes | every shell command, until the app closes |
| Deny | the tool gets an error and the turn carries on | the command does not run; that same command is not asked about again |

"Allow for this session" grants the directory rather than the single file. A
tool let at one path in a folder invariably wants its neighbours next, and
prompting per file is how people learn to click yes without reading. The shell
gets the same answer at the other scale, and the button says "Allow all shell
commands" so the size of the grant is on the label.

Grants live in memory. Closing the app forgets them; nothing on disk records
that a session was ever allowed out of its folder. A grant also outlives the
live session being rebuilt, which happens on every settings save, secret
capture and role switch, because it was an answer about that session. Deleting
the session forgets it.

One directory is readable without a prompt: the NanoHarness checkout itself,
when the app is running from source. The harness editor is the one role told in
its prompt where the harness lives and what its doc map is, and a question
about the harness that stops on a permission prompt for the harness's own
source is a question that does not get answered. Reading it is allowed; writing
to it still asks, and a workspace that *is* the checkout is unaffected either
way.

Two things cannot be answered, and both resolve to a denial rather than a hang:
a prompt for a session that is not the one on screen, and a prompt whose window
went away. A tool waiting on a promise that can never settle would park the
turn forever.

A refusal says what was refused and that going looking for another way to the
same place will stop the turn again. It used to say "you denied access to it",
which reads as a refusal of that one path: an agent told no for `chrome.exe`
asked next about the puppeteer cache, then about the playwright one, and each
attempt put another modal in front of the user. A path already refused this
session is answered from the earlier answer, and says so. A shell command is
remembered by its text: the same command is not asked about twice, and the next,
different command is.
