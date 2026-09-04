# Tools

Files:
- src/tools/bash.ts — shell command, cwd-scoped, capped output
- src/tools/read.ts — offset/limit read with caps
- src/tools/write.ts — create/overwrite write
- src/tools/log-improvement.ts — append an entry to the improvement ledger

A Tool wraps a JSON schema (ToolInput) plus a `run` function. Tools list is
frozen per session start (cache rule, plan §12).

Args arrive as untrusted JSON off the wire, so each tool is built with
`defineTool` (src/core/session.ts): a `parse` step validates the raw object
once, and `run` then receives a real argument type instead of casting fields
one by one. A failed parse comes back as a normal tool error
(`toolname: command must be a string`), not a thrown exception, so the model
can correct itself on the next round.

## bash

Runs `bash -lc <command>` from the project cwd. On Windows it looks up Git
Bash under Program Files and errors clearly if none is found (PowerShell
fallback arrives with the env probe, plan §12). Output capped at 1 MB with an
explicit `[output truncated at 1 MB]` marker, never silent. Failures report
the exit code.

## read

Caps: 2000 lines, 2000 chars per line, 256 KB pre-read gate. Past a cap it
errors explicitly with a continuation hint, never silently truncating.

## write

Creates parent dirs. Plan §15 later makes str_replace-style narrow patches
the default; this skeleton is create/overwrite.

## log_improvement

Appends a dated entry to the improvement ledger (plan §4 rule 5). In the
nanoharness repo itself that is `docs/harness/improvements.md`; in any other
workspace it is `.nanoharness/improvements.md`, so the installed package
directory is never written to. Entries land as `- [ ] title — detail` under a
`## YYYY-MM-DD` heading, appended to today's section if one already exists.

## Scope

`read` and `write` resolve paths from the session cwd and are not sandboxed
(the plan's agent table scopes only `bash`). The model can reach anywhere the
OS user can. This is by design, not a security boundary.