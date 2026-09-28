# The nh CLI

`nh` is the terminal half of the harness: the checks and dumps that want to run
in CI or a shell, and the agent itself run from a script, without booting
Electron.

Files:
- src/cli/index.ts: argument dispatch, `--version`, help
- src/cli/doc-check.ts: doc-map verification
- src/cli/mcp.ts: the MCP config as the commands list, add, remove and check
- src/cli/run.ts: one task run headless, its flags and its output
- src/cli/usage.ts: the usage report, printed

The version comes from `package.json` and nothing else (plan §16).

## nh run [message..]

Runs one task in a folder with nobody at the keyboard and exits when the agent
is done. It is what a benchmark harness or a CI job calls, and it is built to
behave like the other coding agents' own run commands so that one adapter
shape fits all of them.

```
nh run "fix the failing test"             the task as arguments
nh run < task.md                          or from stdin, when no message is given
nh run - "and then"                       stdin after the message
nh run -c "now add a test for it"         carry on the folder's latest session
nh run --approve all --format json --timeout 1800 "..."
```

The session is put together by `src/main/assemble.ts`, the same code the window
uses, so the prompt, the tools, skills, hooks, MCP servers and subagents are the
ones a person would get. It is stored where the window stores its sessions and
shows up in the sidebar under its folder, which is added if it is not there
yet. `-c` picks the folder's most recent session and `-s ID` a given one, in
whatever folder it was started in, so `--dir` means nothing beside it;
without either, every run is a new session. `--role` sets the session's role,
builder by default.

What the window would ask a person about, `--approve` answers ahead of time.
`none`, the default, refuses it: paths outside the folder, and every shell
command, since the shell's question is the one no parser can scope. `judge`
turns auto mode on and lets the approval model decide, which needs one
configured, and what the judge cannot settle is refused. `all` allows
everything, for a run inside a container that exists to be thrown away. A
project's hooks and MCP servers run only if the window has already approved the
file as it reads now; a run has nobody to approve one.

The model comes from the settings the window saved, and `-m provider/model`
picks another saved provider or another model; the part before the first slash
names a provider only when a saved one has that id or name, since model ids
hold slashes of their own. `--effort` is refused for a model known not to take
that level. The key is read from the OS credential store, and `NH_API_KEY`
stands in when the store has none for that provider. A machine with no saved
settings and no credential store, a container, describes the endpoint in the
environment instead: `NH_BASE_URL` switches the settings off, and
`NH_API_KIND` (`openai` unless set), `NH_API_KEY` and `NH_MODEL` (or `-m`)
fill in the rest. Nothing is fetched from `/models` for such an endpoint, so a
run on it records tokens and no price.

`--format text`, the default, writes the answer to stdout and a line per tool
call, refusal, note and error to stderr, so `nh run ... > answer.md` keeps the
answer alone. `--format json` writes every event the window would have drawn,
one JSON object per line, subagents' included, and ends with a `result` line:
the session id, a status, the number of turns, the tokens and cost of the run
(the cost is null when the model has no prices) and the last answer. Each
question `--approve` answered is a `permission.request` line with the
`decision` it got. A run that cannot start, for want of settings or of the
session asked for, says why on stderr and exits 1 with no `result` line.

A background job that outlives the turn is waited for. In the window its
answer arrives between turns and the user replies to it; here the run replies
for them with a fixed message saying the answers are in, and the agent carries
on, until a turn ends with no job out. A job still running when the run ends,
on a timeout or Ctrl+C, is written into the transcript as never finished.

`--timeout SECONDS` stops the agent the way the window's stop button does,
counted from when the session is open and its MCP servers are up. The
exit status is 0 when the agent finished, 1 when the run failed, 2 for a
command typed wrong (answered with the help), 3 on a timeout and 130 when
Ctrl+C stopped it. A second Ctrl+C exits at once, without closing the MCP
servers or terminals the run started.

## nh doc-check [dir]

Verifies the doc map both ways: every source file links to a doc, every doc
lists the files it owns. Defaults to the current directory. Exits 1 with one
line per problem, 0 with a count when clean. `docs/harness/doc-map.md` has the
rules.

In this repo it is the `pnpm doc-check` script and a CI job.
`examples/hooks.json` also runs it as a `SessionStart` hook, which puts the
problems in front of the agent when a session opens and says nothing when the
map is clean.

## nh usage [--days N] [--json]

Reads the usage log and prints what was spent: the totals, the cache hit rate
(`cacheRead / (cacheRead + input + cacheWrite)`, plan §15's headline metric),
throughput, and a breakdown per day, folder, session, model, agent and phase. A
cache write is in the denominator because it is prompt the provider read in
full and charged extra for, and the counts are printed above the percentage so
it can be checked by hand.

This is the same report the window draws, built by `src/core/usage-report.ts`;
`cost.md` explains the grouping, how an unpriced turn is counted, and why a
deleted session keeps its row.

`--days N` counts back N whole local days with today included. Without it the
report covers everything the log holds. Anything that is not a day count is
refused, and never read as all time, which would print a report for a window
nobody asked for.

Each line carries the schema version it was written under. A line from another
version is skipped, not summed: version 3 gives a line the folder, agent and
per-phase money the report groups by, and version 2 before it changed what
`input` means on an OpenAI-compatible turn. Neither can be converted from what
is already on disk. The log is never rewritten, and there is no compatibility
path: this project is pre-1.0, so a build reads its own schema and counts the
rest as skipped.

`--json` dumps the raw records instead, for piping somewhere else.

The log is `usage.jsonl` in the OS user-data dir (`%APPDATA%`,
`~/Library/Application Support`, `$XDG_DATA_HOME`), one JSON line per completed
turn, appended by the app and by `nh run`. It never lands in the repo. A torn or
malformed line is skipped and counted, and never aborts the read.

Nothing has been recorded until a session runs, so a fresh install prints an
empty report and not an error.

## nh mcp <command>

The MCP config as commands, in place of a file to hand-write. It exists because
of what an agent did without it: wrote the JSON by hand, then wrote a throwaway
script that re-implemented this project's own parser to check its work, and
spent five rounds on a job that is one command. A private copy of the parser can
disagree with the real one, so the pass proved nothing either.

```
nh mcp list [--json]              what is configured, in both files
nh mcp add <name> --command <cmd> [--arg A]... [--env VAR]... [-- args...]
nh mcp add <name> --url <url> [--token-env VAR]
nh mcp remove <name>              take one entry out (the file stays)
nh mcp check [name]               actually connect, and say what happened
nh mcp check <name> --call <tool> [--args JSON]   make one real call
```

`--help` is answered wherever it appears, whether `nh mcp --help`, `nh mcp add
--help` or `nh help mcp`, and so is a wrong flag: the message names what was
wrong and the help says what to write instead. An agent that asked `nh mcp add
--help` and got `unknown flag --help` back spent two more calls guessing at the
syntax, which is the whole saving the command exists for.

`--global` writes `~/.nanoharness/mcp.json`, the file every workspace reads;
without it the target is this folder's own `.nanoharness/mcp.json`. `--dir DIR`
treats `DIR` as the workspace in place of the current folder, and `--disabled`
writes the entry switched off.

Every write goes through the same `parseServer` a session uses, and `check`
connects through the same client, so a pass means the session will connect,
and not merely that the JSON parsed. `mcp.md` has the file format and what an
entry may hold.

It does not mean the credential works. A remote server answers `initialize` and
`tools/list` to anyone and only looks at the key when a tool is called, so
`check` once printed `ok tavily 5 tools` for an entry whose key was nonsense:
five tools in the prompt, every call an auth error. So the plain form says what
it did not check, and `--call <tool>` makes one real call and prints what the
server said, which is the only part of the protocol a key has to survive. The
tool is yours to name, because a catalog is not a list of safe things to run.
`--args` takes a JSON object, and a name the server does not have comes back
with the list of the ones it does.

`--env` and `--token-env` name an environment variable and never take a
token. A `--url` that carries its own key is the exception, and `mcp.md` says
why that one writes a live credential to disk.

A session builds its tool list once, at startup, so a server added now is
connected the next time the app starts or a session is opened. The command says
so, so no agent reports a tool the running session has not got. A server added
to the workspace file also waits for the user: the file has changed, and that
session asks them to approve it first.

`check` never asks. It has nobody to show the file to, since the agent runs it
as often as a person does, and a shell approval shows the command line and not
the file it reads. So it starts a server from the workspace file only once the
app has approved that file as it reads now, and otherwise says the file is not
approved. `list` starts nothing, so it lists every entry and names a workspace
file that still needs approving. `hooks.md` describes the approval.
