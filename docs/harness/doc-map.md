# The doc map

Every source file names the doc that explains it; every doc lists the files it
explains. The two directions are checked by `nh doc-check`, so the map cannot
quietly rot the way a hand-maintained index does.

An agent editing the harness gets this page first — path plus one line each —
reads only the pages it needs, then edits code. List first, read on demand:
the convention doubles as a token-efficiency measure.

## Rules

1. A source file's header carries `// doc: docs/harness/<file>.md`, optionally
   with a `#anchor`. It sits in the first five lines, after a shebang if there
   is one.
2. The doc it points at lists that file under a `Files:` heading, as
   `- path — one-line summary`. The list ends at the first blank line.
3. `nh doc-check` fails on a source file with no header, a header pointing at a
   missing doc, a file the doc does not list back, a doc listing a file that no
   longer exists, and a doc with no `Files:` section at all.
4. One doc owns a file. Other docs may discuss it in prose, but only the owner
   lists it — otherwise "which page explains this?" has two answers.
5. `doc-map.md` and `improvements.md` are exempt from rule 3's last clause:
   they describe the convention and the ledger, not code.

Run it locally, or read it in CI where it gates every pull request:

```bash
pnpm doc-check
```

## Index

- `overview.md` — architecture, session loop, usage accounting, IPC
- `providers.md` — provider layer, wire format, auth, provider settings
- `tools.md` — tool specs, the arg-validation boundary, caps
- `cli.md` — the `nh` command: `doc-check`, `usage`
- `ui.md` — the desktop window, the context bridge, the renderer
- `improvements.md` — the flaw and improvement ledger (living doc)
- `doc-map.md` — this page

Pages arrive with the features they document; plan §4 lists the ones still to
come (agents, mcp, skills, snippets, hooks, sessions, env-detection,
security).
