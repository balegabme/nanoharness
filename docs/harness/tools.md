# Tools

Files:
- src/tools/bash.ts: shell command, cwd-scoped, capped output
- src/tools/read.ts: offset/limit read with caps, parallel-safe
- src/tools/search.ts: grep and glob, in process, no shell
- src/tools/ignore.ts: what a .gitignore excludes from a walk
- src/tools/write.ts: create/overwrite write
- src/tools/edit.ts: literal replace in an existing file
- src/tools/text.ts: whether a file's bytes are text a tool may rewrite
- src/core/read-index.ts: what the session has read, and at which version
- src/core/diff.ts: the unified diff a write or an edit hands back
- src/tools/log-improvement.ts: append an entry to the improvement ledger

A Tool wraps a JSON schema (ToolInput) plus a `run` function. The tool list is
frozen when a session starts (cache rule, plan §12).

Args arrive as untrusted JSON off the wire, so each tool is built with
`defineTool` (src/core/session.ts): a `parse` step validates the raw object
once, and `run` then receives a real argument type. A failed parse comes back
as a normal tool error (`toolname: command must be a string`), so the model can
correct itself on the next round.

## bash

Writes the command to a temporary script and runs it as `bash <script>` from
the project cwd, through the shell `env-detection.md` describes: Git Bash on
Windows, with the PATH a login shell would have and without paying for the
profile on every command. Output is capped at 1 MB with an explicit
`[output truncated at 1 MB]` marker. Failures report the exit code.

The script file is there because Git Bash cuts a `-c` string at 8 KiB and runs
the front of it anyway. A 12 KB patch script arrived with its heredoc
terminator missing, the shell warned about an unterminated heredoc, and the
file being patched had already been half written. The script is readable by
this user alone, since it holds the command and the temp directory is shared.

CRLF is folded to LF on the way in, since bash counts the carriage return as
part of a heredoc terminator. The fold covers the whole command, so a heredoc
meant to lay down a CRLF fixture lays down LF. Use `printf` to write one on
purpose.

The command is not screened for paths. A command line is a program, and every
parser for one has read a script body, a heredoc, a sed address or an HTML tag
as somewhere on disk; `sessions.md` has the failures. The tool asks
`access.checkCommand` before it runs: the app's gate shows the person the
command, "Allow once" runs that one, "Allow all shell commands" trusts the
shell for the session, and a gate with nobody to ask refuses it. The command
runs from the session root.

## read

Caps: 2000 lines, 2000 chars per line, 256 KB pre-read gate. Past a cap it
errors with a continuation hint and never truncates silently.

Every line comes back prefixed with its number, `12: const answer = 42`. The
number is what an error, a diff and a person all refer to, and without it the
model counts lines by hand and gets it wrong on long files. The description
says the prefix is not part of the file, since a model that copies a line out
of a read into `old_string` with its number attached gets a match failure it
cannot explain.

A read of lines the session already has, of a file that has not changed since,
comes back as a sentence naming the lines. See "What the session has already
read" below.

An offset past the last line is an error saying how many lines the file has.
Answering it with nothing reads as an empty file, and answering it from the
index reads as lines the model already has.

Several `read` calls in one message run together (`executeTools` in
src/core/session.ts, via the tool's `parallel` flag), since reading changes
nothing.

## grep and glob

`grep` searches file contents for a JavaScript regular expression and answers
with `path:line:text`. `glob` finds files by path pattern and answers with a
sorted list. Both are marked `parallel`, so a message that asks four questions
about the codebase gets four answers in one round.

Neither starts a process. A search through `bash` costs a shell startup,
measured at roughly 0.9 seconds on Windows even for a command that does
nothing, and a shell command cannot run beside another one. Searching is also
the most common thing a session does before it knows what it is looking at, so
that cost lands at the front of every task.

Both are pure Node, and the harness has no runtime dependencies. The walk is
breadth-first over `readdir`, and the caps keep a search of a large repository
from filling the context window: 20,000 files walked, 2 MB per file, 200
matches, 500 paths, 400 characters of a matching line. Every cap that bites is
named in the result.

Three things keep it fast, all measured over a checkout of 19,859 files.

The walk starts where the pattern does. A pattern is rooted at whatever
directory precedes its first wildcard, and nothing outside that directory can
match it. `grep`'s `include` narrows the walk as well as the matches, which is
why its description asks for one. A search of `src/**/*.ts` went from 6,989 ms
to 86 ms.

Files are read 64 at a time. In a row, 2000 files took 7.8 seconds; 64 at a
time, 1.1 seconds. A serial read spends most of the search waiting on the disk.

Searches running at once share a walk. The entry lives only while the walk is
running, so a search that starts after one finishes walks again and sees what
is on disk then. Nothing is cached between searches, and no answer can be
stale.

A search with no `include` and no `path` reads every file the walk reaches, so
what the walk reaches is the third thing that decides how fast it is.

`.git`, `.hg`, `.svn` and `node_modules` are never walked. Past those it is the
`.gitignore` files that decide: the one at the root, and every one the walk
meets on its way down, since a subdirectory often carries its own.
`src/tools/ignore.ts` reads them the way git does. A pattern with no slash in
it matches a name at any depth. A leading or inner slash ties it to the
directory its file sits in. A trailing slash means a directory and not a file
of the same name, `**` crosses directories, and a `!` line re-includes what an
earlier line excluded, which is what keeps `.env.*` from hiding a committed
`.env.example`. The closest file decides, and inside one file the last matching
line does.

A line holding a character class or a backslash escape is counted and not
half-applied, and the count goes in the answer. Reading part of a pattern
language is how a search misses a directory, or walks one it was told to skip,
without saying so. Of the 74 rule lines in this project's own `.gitignore`, 73
are applied.

Both tools take `ignored: true` and walk everything the ignores excluded, for
when the build output or a `.env` is the thing being looked for. Leaving it off
by default is what makes a workspace opened at a parent directory usable. Over
`PycharmProjects`, the directory this project sits in, a walk that honours the
ignores reads 4,667 files in 0.8s and finishes; one that does not reaches the
20,000-file cap in 1.2s and is cut off. A grep over the same tree costs 3.2s
against 10.6s, and answers with three matches in the source instead of six
spread across the source and its own compiled copy.

Every answer says what it left out. One that found nothing names the
directories never walked and how many paths the ignores excluded, so "no
matches" can be told apart from "did not look". One that found something names
only the exclusions, since the fixed list is noise on an answer that worked.

Symlinks are not followed, in either kind. A link is the one entry that can
leave the workspace or point back at its own parent, and the name does not say
which.

A pattern that is not a valid regular expression is an error naming the syntax
problem. An empty result and a broken pattern read identically to a model, and
only one of them means the code is not there. The walk cap is named for the
same reason: a search that gave up after 20,000 files says so, and still
reports what it found in the part it did walk. Answering "no matches" off a
truncated walk is the one failure a search cannot be allowed, because it reads
as proof the code is not there.

`grep`'s `include` is matched against the file's name alone when it has no
separator in it, so `*.ts` is every TypeScript file and `chat.ts` is that file
wherever it sits. A model asks for `include: "chat.ts"` far more often than for
the full path, and against the whole path that pattern matches nothing and
reads as an answer. `grep`'s `path` takes one file as readily as a directory.

A pattern with a separator in it, and every `glob` pattern, is measured against
the path below whatever `path` named. That argument says where to look, so a
pattern under it is written from there: `glob` with `path: "src/tools"` and
`*.ts` answers with the files sitting in that directory. What comes back is
still workspace-relative, because `read` and `edit` take that path and not a
path relative to the search.

An answer narrowed by `path` says what its paths are counted from. The pattern
is written from the directory that was named and the answer from the root, and
a reader who takes one for the other finds a directory inside another of the
same name: `glob("*", path: "…/nanoharness")` answering `nanoharness/README.md`
reads as a second `nanoharness` inside the first. The line is on narrowed
searches only, since there is nothing to say when the walk started at the root
or when `path` named a single file.

The glob syntax: `**` crosses directories and also matches nothing, so
`**/*.ts` finds `index.ts` at the root; `*` and `?` stop at a path separator;
`{a,b}` is either; everything else is literal, so the dot in `*.ts` is a dot.

## What the session has already read

`src/core/read-index.ts` holds one map, absolute path to the file's
modification time and size plus the line spans this session has been shown. It
answers two questions.

The first is whether a read is worth serving. A session that has already been
shown lines 1 to 200 of an unchanged file, and asks for lines 40 to 80, gets a
sentence saying the lines are already in the conversation and which ones. The
bytes are in the transcript and the model is paying to keep them there. The
prompt asks for one wide read in place of overlapping slices for the same
reason, and the index is what enforces it. A span already served has to contain
the request; one that runs past it is served in full.

The second is whether a rewrite is a guess. An edit or a whole-file write is
written against a view of the file, so `edit` and `write` refuse a target this
conversation has not read, and refuse one that has changed on disk since it was
read. Creating a file is always allowed. A file the session wrote itself counts
as current without a re-read, since the session knows what it put there; its
spans are dropped, because the new content is on disk and in nobody's context.

A compaction drops every span and keeps the versions. The lines a file was read
at may have gone into a summary or been shortened, and a model told they are
already in the conversation would look for them there and not find them. The
version still says what was on disk when the file was read, so the freshness
rule for `edit` and `write` carries on unchanged (`context.md`).

Version is modification time and size together. Either alone changes too
rarely: a rewrite inside the same millisecond keeps the time, and a swap of two
characters keeps the size.

The index is per session and lives in memory. A session rebuilt from a stored
transcript starts in a resumed state, which drops the read-before-write rule
for files it has no record of: those reads are in the transcript the model can
see and nowhere this index can. The freshness rule still applies to everything
read after the rebuild, and `edit`'s exact-match requirement on `old_string` is
what catches a stale view in the meantime.

## write

Creates parent dirs. For a change to an existing file, `edit` is the cheap
path: a full rewrite pays for every unchanged line in output tokens.

Overwriting a file this conversation has not read, or one that has moved since
it was read, is refused.

## edit

Replaces literal text in an existing UTF-8 file. The target has to have been
read in this conversation and has to be unchanged since, unless the session
created or last wrote it; the read index above owns that rule. `old_string`
must appear exactly once unless `replace_all` is true; a missing or ambiguous
match comes back as an error that says which. Matching is done with CRLF folded
to LF and the file is written back with the line endings it came in with, so a
model that copies what `read` showed it still matches a CRLF file. Binary files
and files that do not decode as UTF-8 are refused, and so is an edit whose two
strings are the same.

## What a write hands back

Both writing tools answer with a line saying what they did and a fenced unified
diff of the change: `edited src/core/session.ts (1 replacement, +12 −3)`, then
the hunks. `src/core/diff.ts` builds it, in about two hundred lines of line-LCS
and hunk formatting.

The diff is read twice, by the window that draws it and by the model that is
billed for it, which is what the caps are for. Three lines of context either
side; at most 120 lines, after which the rest is one line saying how much was
cut; and a pair of files too large for the LCS table gets a line count in place
of a diff. A `write` over an existing file diffs against what was there, so an
overwrite says what it replaced and does not count the whole file as new.

Three cases are named and not drawn. A file that was not there counts every
line as added and nothing as removed, which is what `@@ -0,0 +1,n @@` says. Two
versions that differ only in whether the last line is terminated have the same
lines and no hunk to show, so the diff is one header saying the trailing
newline was added or removed; a header with an empty body under it would read
as a write that changed nothing. A file that exists but cannot be read as text,
whether from a permission error, a lock, a binary, or bytes that are not UTF-8,
gets no diff and a line saying so, because reporting it as a new file would
tell the model it had created the lines it actually destroyed.

Handing the model the diff is what stops the next round opening the file again
to check the edit landed. The window uses the same text: an edit card opens
into a diff pane (see `ui.md`).

## log_improvement

Appends a dated entry to the improvement ledger (plan §4 rule 5). In the
nanoharness repo itself that is `docs/harness/improvements.md`; in any other
workspace it is `.nanoharness/improvements.md`, so the installed package
directory is never written to. Entries land as `- [ ] title: detail` under a
`## YYYY-MM-DD` heading, appended to today's section if one already exists.

## Scope

Every path argument goes through an `AccessGate`: `read`, `grep`, `glob`,
`write` and `edit` call `access.check` on the path before they touch it, and a
search walks only from the directory that check returns. `bash` calls
`access.checkCommand` on the whole command, because a command is not a path and
nothing reads it as one. What the question costs depends on which gate the
session got: in the app it is a modal to the user, and everywhere else, in the
CLI, a test or a subagent host, it is a flat refusal, since there is no window
to ask in. `sessions.md` has the rule and what it takes to enforce it.
