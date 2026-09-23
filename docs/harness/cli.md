# The nh CLI

`nh` is the terminal half of the harness: the checks and dumps that want to run
in CI or a shell, without booting Electron.

Files:
- src/cli/index.ts: argument dispatch, `--version`, help
- src/cli/doc-check.ts: doc-map verification
- src/cli/mcp.ts: the MCP config as the commands list, add, remove and check
- src/cli/usage.ts: the usage report, printed

The version comes from `package.json` and nothing else (plan §16).

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
turn, appended by the main process. It never lands in the repo. A torn or
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
