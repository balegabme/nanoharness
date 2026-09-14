# Tools

Files:
- src/tools/bash.ts — shell command, cwd-scoped, capped output
- src/tools/read.ts — offset/limit read with caps, parallel-safe
- src/tools/write.ts — create/overwrite write
- src/tools/edit.ts — literal replace in an existing file
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

Writes the command to a temporary script and runs it as `bash -l <script>`
from the project cwd. On Windows it looks up Git Bash under Program Files and
errors clearly if none is found (PowerShell fallback arrives with the env
probe, plan §12). Output capped at 1 MB with an explicit
`[output truncated at 1 MB]` marker, never silent. Failures report the exit
code.

The script file is there because Git Bash cuts a `-c` string at 8 KiB and runs
the front of it anyway. A 12 KB patch script arrived with its heredoc
terminator missing, the shell warned about an unterminated heredoc, and the
file being patched had already been half written. Nothing about the shell
changes otherwise: it is still a login shell, so `grep`, `sed` and `curl` are
on PATH. The file is written readable by this user alone, because it holds the
command and the temp directory is shared.

CRLF is folded to LF on the way in, since bash counts the carriage return as
part of a heredoc terminator. The fold is over the whole command, so a heredoc
meant to lay down a CRLF fixture lays down LF: `printf` is the way to write one
on purpose.

The command is not screened for paths. A command line is a program, and every
parser for one has read a script body, a heredoc, a sed address or an HTML tag
as somewhere on disk; `sessions.md` has the failures. The tool asks
`access.checkCommand` before it runs: the app's gate shows the person the
command, "Allow once" runs that one, "Allow all shell commands" trusts the
shell for the session, and a gate with nobody to ask refuses it. The command
runs from the session root.

## read

Caps: 2000 lines, 2000 chars per line, 256 KB pre-read gate. Past a cap it
errors explicitly with a continuation hint, never silently truncating.

Several `read` calls in one message run together (`executeTools` in
src/core/session.ts, via the tool's `parallel` flag), since reading changes
nothing.

## write

Creates parent dirs. For a change to an existing file, `edit` is the cheap path:
a full rewrite pays for every unchanged line in output tokens, and a targeted
replace does not.

## edit

Replaces literal text in an existing UTF-8 file, ported from `deepseek-harness`.
`old_string` must appear exactly once unless `replace_all` is true; a missing or
ambiguous match comes back as an error that says which. Matching is done with
CRLF folded to LF and the file is written back with the line endings it came in
with, so a model that copies what `read` showed it still matches a CRLF file.
Binary files and files that do not decode as UTF-8 are refused, and so is an
edit whose two strings are the same. The result is one confirmation line, not
the file, so a model has nothing to gain from reading it back.

## log_improvement

Appends a dated entry to the improvement ledger (plan §4 rule 5). In the
nanoharness repo itself that is `docs/harness/improvements.md`; in any other
workspace it is `.nanoharness/improvements.md`, so the installed package
directory is never written to. Entries land as `- [ ] title — detail` under a
`## YYYY-MM-DD` heading, appended to today's section if one already exists.

## Scope

Every path argument goes through an `AccessGate`: `read`, `write` and `edit`
call `access.check` on the path before they touch it, and `bash` calls
`access.checkCommand` on the whole command, because a command is not a path and
nothing reads it as one. What the question costs depends on which gate the
session got: in the app it is a modal to the user, and everywhere else — the
CLI, a test, a subagent host — it is a flat refusal, since there is no window
to ask in. `sessions.md` has the rule and what it takes to enforce it.
