# The nh CLI

`nh` is the terminal half of the harness: the checks and dumps that want to run
in CI or a shell, without booting Electron.

Files:
- src/cli/index.ts — argument dispatch, `--version`, help
- src/cli/doc-check.ts — doc-map verification
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
(`cacheRead / (cacheRead + input)` — plan §15's headline metric), and a
per-model breakdown. `--json` dumps the raw records instead, for piping
somewhere else.

The log is `usage.jsonl` in the OS user-data dir (`%APPDATA%`,
`~/Library/Application Support`, `$XDG_DATA_HOME`), one JSON line per completed
turn, appended by the main process. It never lands in the repo. A torn or
malformed line is skipped and counted rather than aborting the read.

Nothing has been recorded until a session runs, so a fresh install prints an
empty report rather than an error.
