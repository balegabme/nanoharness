# Hooks

A hook is a command of the user's that runs at a set point in a session: when
it opens, before and after each tool call, and when the agent says it is done.
It can refuse a tool call, send the agent back to work, or put text in front of
the model. Plan §10.

Files:
- src/hooks/config.ts: the two hook files, their format, and the parser
- src/hooks/hooks.ts: running a hook, reading what it said, and the prompt lines about hooks
- src/core/project-trust.ts: which project hook and MCP files the user has approved

`examples/hooks.json` has one hook per event, ready to copy.

## Where they live

Two files, both optional:

- `~/.nanoharness/hooks.json` holds the hooks for every workspace.
  `NANOHARNESS_HOME` moves the home directory, as it does for `mcp.json`.
- `<root>/.nanoharness/hooks.json` holds one project's hooks.

Both run, the global file first and then the project's. A workspace opened at
the home folder finds one file at both paths and reads it once.

The files are read when a session is built. That is at its first message, and
again when a setting it was built from changes: the provider it talks to, the
model, or the Run hooks switch. A file edited in the middle of a turn changes
nothing until then, so a turn cannot start under one set of hooks and finish
under another.

The Run hooks switch in Settings, under General, turns every hook off. It is on
until someone turns it off.

## The format

A JSON object keyed by event name. Each event holds a list of hooks:

```json
{
  "PreToolUse": [
    { "match": "bash", "command": "./scripts/check-command.sh", "timeout": 10 }
  ]
}
```

- `command` is a bash script, run with `bash -c` from the workspace root. On
  Windows that is Git Bash. The shell is the one the `bash` tool uses, with the
  same PATH (`env-detection.md`). It may be up to 8,000 bytes long, because Git
  Bash cuts a longer `-c` string short and runs the front half. A longer script
  goes in a file the command runs.
- `match` is a regular expression on the tool name, matched whole, so `write`
  is the `write` tool and not every tool with the word in its name. Only
  `PreToolUse` and `PostToolUse` take it. Without it the hook runs for every
  tool.
- `timeout` is in seconds, 60 when absent and at most 600.

A broken entry is skipped and named in a note on the session, and the rest of
the file still loads. One typo does not switch off every hook the user relies
on. A file that is not valid JSON loads nothing and says so.

## What a hook reads and how it answers

A hook gets one JSON object on stdin: `event`, `sessionId`, `cwd`, and the
fields of its event.

| event | fields | exit 2 |
|---|---|---|
| `SessionStart` | none | a note; the hooks after it do not run |
| `PreToolUse` | `tool`, `args` | the call is refused and never runs |
| `PostToolUse` | `tool`, `args`, `result: {ok, output}` | the reason is added to the result, since the call has already run |
| `Stop` | `answer`, `continued` | the agent is sent back to work |

`args` is the call's arguments as the model wrote them. A secret in them is
still its `{{secret:name}}` placeholder, because the real value is filled in
only at the moment the tool runs (`secrets.md`). `output` is the result after
the same scrub the model's copy goes through.

A hook answers with its exit status and what it prints:

- Exit 2 refuses, with stderr as the reason, or stdout when stderr is empty.
- Exit 0 with nothing printed says nothing.
- Exit 0 with a JSON object on stdout is read for `block` and `context`. A
  non-empty `block` refuses exactly as exit 2 does, and `context` is text for
  the model.
- Exit 0 with anything else on stdout is that text, for the model.
- Any other exit, a hook that cannot start and a hook that runs out of time are
  problems. Each becomes a note on the session and the work goes on as if the
  hook were not there.

Each stream is cut at 10,000 characters, with a line saying so. A hook that
prints a whole test log would otherwise spend a round's worth of tokens on
every call.

The hooks for one event run one after another, in file order. The first
refusal ends the run, and the hooks after it do not run.

A hook that runs out of time is killed along with everything it started. So
is one running when the user stops the turn. The call it was checking does not
run, and the hooks after it are skipped without a note, since the stop was the
user's. Quitting the app kills every hook still running.

A hook is done when it exits, even if something it started is still running. A
server started with `&` holds the hook's pipes open for as long as it lives, so
the harness reads what arrived in the second after the exit and leaves the
process alone. Neither case waits for the pipes to close, or a `sleep` the
script left behind would hold the turn for as long as it slept.

## Where the words go

What a hook prints reaches the model in the place it belongs to.

`SessionStart` output goes into the system prompt, under a line saying where it
came from. It is there because a project check ("the doc map is broken", "you
are on a release branch") is a fact about the whole session. The hooks run
again at every build, so output that changes between builds changes the prompt
and costs a cache miss at that point. A hook that prints only when something is
wrong keeps the prompt the same across builds.

`PreToolUse` and `PostToolUse` output is appended to the tool result under a
`[PreToolUse hook]` or `[PostToolUse hook]` line. A refused call comes back as
an error that says a hook refused it, and it counts as prevented in the line
under the turn, the same as a call the permission system stopped.

A `Stop` refusal becomes a message to the model: "A Stop hook did not let the
turn end yet", followed by the reason. The transcript marks it as the hook's,
so it is not counted as a turn, not read as the user's goal by the approval
model, and drawn as a note when the session is opened again. The window shows
it as a note while it happens.

A Stop hook can send the agent back three times in one turn. The fourth refusal
lets the turn end, with a note saying so and what the hook said. A hook that
never passes cannot hold a session in a loop that spends money until someone
notices. `continued` tells the hook how many times it has already refused this
turn.

The system prompt says hooks exist only when the session has some, in one line
per kind: that a tool result can carry hook lines and a refused call stays
refused, and that a Stop hook can reply in place of the user.

## Subagents

A subagent runs the parent's `PreToolUse` and `PostToolUse` hooks, because its
tool calls touch the same files. It runs neither `SessionStart` nor `Stop`. Its
session start is the parent's, and its answer goes back to the parent, which is
where a Stop hook already stands between the work and the user.

## Trusting a project's files

Two files in a project make the harness run something on the user's machine:
`.nanoharness/hooks.json` lists commands, and `.nanoharness/mcp.json` lists MCP
servers to start or connect to, with the environment variables each one is
handed. Both arrive with the repository, and so does anything the agent wrote
into them. Cloning a project and opening it must not be enough to run either.

So each asks first, in the same way. The window shows the whole file and asks
whether to use it. Yes is recorded against the file's path and SHA-256 in
`project-trust.json` in the app's data folder. The approval covers that text
and nothing else: an edit to the file, including one a pull brought in, asks
again, and approving one of the two files approves nothing about the other. A
refusal holds until the app restarts or the file changes, and the session runs
without that file, with a note saying so.

The approval covers the file and not the scripts it names. A hook or a server
whose command runs a script from the repository runs that script as it reads
at the time, and a pull that changes only the script asks nothing.

A hooks file asks when it holds a hook. An `mcp.json` asks when it would start
or reach a server of its own; one that only switches global servers off starts
nothing and is used without a question (`mcp.md` has the layering).

The session build waits on the answers, the hooks file first, and both are
asked before any MCP server is spawned. Two sessions opening in one folder at
once share one question. A window closed with the question still up has
answered no.

The global files never ask. They are in the user's home folder, and only the
user put them there. `nh mcp check` never asks either, because it has nobody to
show the file to: it starts a project's servers only once the app has approved
the file as it reads now (`cli.md`).

An approval that cannot be written to disk still holds for the rest of the run,
and the next launch asks again.
