# The nh CLI

`nh` is the terminal half of the harness: the checks and dumps that want to run
in CI or a shell, without booting Electron.

Files:
- src/cli/index.ts — argument dispatch, `--version`, help
- src/cli/doc-check.ts — doc-map verification
- src/cli/mcp.ts — the MCP config as commands: list, add, remove, check
- src/cli/usage.ts — usage aggregation and report formatting

The version comes from `package.json` and nothing else (plan §16).

## nh doc-check [dir]

Verifies the doc map both ways: every source file links to a doc, every doc
lists the files it owns. Defaults to the current directory. Exits 1 with one
line per problem, 0 with a count when clean. `docs/harness/doc-map.md` has the
rules.

The plan also runs this as a `SessionStart` hook; that arrives with the hook
runner in build step 7. Until then it is the `pnpm doc-check` script and a CI
job.

## nh usage [--json]

Reads the usage log and reports totals, the cache hit rate
(`cacheRead / (cacheRead + input + cacheWrite)`, plan §15's headline metric),
and a per-model breakdown. A cache write is in the denominator because it is
prompt the provider read in full and charged extra for, and it is printed on
any row that has one so the percentage can be checked by hand.

Each line carries the schema version it was written under. A line from another
version is skipped, not summed: before version 2, `input` on an
OpenAI-compatible turn included the cached tokens that `cacheRead` also
counted, and a line already on disk cannot be converted because it does not
record which wire wrote it. The log is never rewritten, and there is no
compatibility path: this project is pre-1.0, so a build reads its own schema
and skips the rest.

`--json` dumps the raw records instead, for piping somewhere else.

The log is `usage.jsonl` in the OS user-data dir (`%APPDATA%`,
`~/Library/Application Support`, `$XDG_DATA_HOME`), one JSON line per completed
turn, appended by the main process. It never lands in the repo. A torn or
malformed line is skipped and counted rather than aborting the read.

Nothing has been recorded until a session runs, so a fresh install prints an
empty report rather than an error.

## nh mcp <command>

The MCP config as commands rather than a file to hand-write. It exists because
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
wrong and the help says what to write instead. That is not politeness. An agent
that asked `nh mcp add --help` and got `unknown flag --help` back spent two more
calls guessing at the syntax, which is the whole saving the command exists for.

`--global` writes `~/.nanoharness/mcp.json`, the file every workspace reads;
without it the target is this folder's own `.nanoharness/mcp.json`. `--dir DIR`
treats `DIR` as the workspace instead of the current folder, and `--disabled`
writes the entry switched off.

Every write goes through the same `parseServer` a session uses, and `check`
connects through the same client, so a pass means the session will connect
rather than that the JSON parsed. `mcp.md` has the file format and what an entry
may hold.

It does not mean the credential works. A remote server answers `initialize` and
`tools/list` to anyone and only looks at the key when a tool is called, so
`check` once printed `ok tavily 5 tools` for an entry whose key was nonsense:
five tools in the prompt, every call an auth error. So the plain form says what
it did not check, and `--call <tool>` makes one real call and prints what the
server said, which is the only part of the protocol a key has to survive. The
tool is named rather than chosen for you, because a catalog is not a list of
safe things to run. `--args` takes a JSON object, and a name the server does not
have comes back with the list of the ones it does.

`--env` and `--token-env` name an environment variable rather than taking a
token. A `--url` that carries its own key is the exception, and `mcp.md` says
why that one writes a live credential to disk.

A session builds its tool list once, at startup, so a server added now is
connected the next time the app starts or a session is opened. The command says
so rather than leaving an agent to report a tool the running session has not
got.
