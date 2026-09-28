# Checkpoints and rewind

Every turn begins with a checkpoint. Going back to one puts the conversation,
the files, or both where they stood when that turn began. The files go back at
once and the rewind is held there, so the user can move it to another turn or
undo it, and the next message keeps it. `ui.md` describes the card that asks
before a rewind and the turn index that finds the turn.

Files:
- src/core/checkpoints.ts: the store, its snapshots, holding a rewind, restoring files and keeping or undoing the rewind

## What a checkpoint holds

A checkpoint is taken in `Session.run`, after anything a background job left
between turns has been folded in and before the user's message goes into the
history. It records:

- the turn number, as the usage log numbers it;
- the first line of the user's message, which is what the turn index shows;
- the conversation marker, which is how many transcript messages came before
  the turn's own message;
- the compaction marks on those messages, and how many compactions the context
  panel listed;
- the files changed while it was the latest checkpoint.

The marker is all a conversation rewind needs to cut the history, and it is
what forking a session at a turn will reuse. The marks are there because a
compaction marks earlier messages in place and appends its summary. A cut
removes the summary along with the turns after the checkpoint, and the marks
have to go back to what they were, or the messages the summary stood for would
stay hidden with nothing standing for them.

The file snapshots come from `edit` and `write`. Each asks the session's
`FileGuard` before it writes. The first time a file is about to change while a
checkpoint is the latest, the store copies it as it is. Later changes to the
same file in the same checkpoint copy nothing. So each checkpoint holds every
file it saw change, as that file stood when its turn began. A file that did not
exist is recorded as absent, and a rewind deletes it again. A file over 16 MB,
or one that could not be read, is recorded as lost with the reason, and a
rewind reports it and leaves it alone.

When the index cannot be written, the copy is still listed in memory, and the
change goes ahead with the failure reported as a fault. Refusing the change
would stop every edit for as long as the data directory cannot be written. The
same holds for a checkpoint whose index write fails at the start of a turn: it
is written with the next change that saves. A rewind needs a copy of what it
would overwrite, so while the blobs cannot be written it leaves such a file
alone and says so.

Only `edit` and `write` are tracked. What the agent does through `bash`, what
an MCP tool writes and what anyone changes outside the app are not, and the
card that asks before a rewind says so. Diffing the whole folder at every turn would
catch them, at the price of reading the folder on every turn. The ledger
`log_improvement` appends to is left out on purpose: an idea recorded in a
turn that was rewound is still worth keeping.

## Where they live

`sessions/<id>/checkpoints/` in the app's data directory, beside the session's
subagents and pictures, so deleting the session deletes them. `index.json`
lists the checkpoints and the rewind being held, if there is one. `blobs/`
holds each copied file once, under the SHA-256 of its bytes, however many
checkpoints refer to it. A blob is deleted once nothing refers to it, which
happens only when a rewind is kept or undone. So a long session that rewrites
large files holds a copy of each version it started a turn with. The index is
written after every change, so a turn that dies halfway still leaves the copies
it made. A blob goes in under a temporary name and is renamed into place, so a
half-written one never carries a hash.

Everything runs in order on one queue. A background subagent can write while
its parent is between turns, and its snapshot must not interleave with a
rewind.

## Holding a rewind

A rewind has two steps. `stage` puts the files back and records the rewind as
held. The conversation is not touched yet. `commit` keeps the rewind, and
`Session` calls it at the start of the next turn, of a compaction the user asks
for and of a TL;DR, so the session only ever builds on history that has been
cut.
`unstage` undoes the held rewind instead. Going back therefore costs nothing
the user cannot take back until they send something, and moving the held
rewind to another turn is cheap.

Before `stage` first puts a file back, it copies the file as it is now into the
held rewind's redo set. Moving the held rewind to another turn keeps that set
and adds to it, so every file any step touched can still go back to how the
first step found it. Each file then goes to its snapshot from the new target,
or back to its redo copy when the new target does not cover it. Undoing puts
every file in the redo set back.

A file the store cannot copy first, because it is over 16 MB or cannot be read,
is left as it is and reported, since nothing could undo the change.

Each step writes over whatever the file holds at that moment. A file changed
outside the app while a rewind is held is overwritten by the next move or by
undoing, like any file a rewind puts back.

A file that already holds what it should is not written, so going back and
forth leaves its modification time alone. The check compares sizes first,
against the blob's size, and reads and hashes the file only when they match.

The held rewind is saved in the index, so it survives closing the app. The
conversation on disk is still whole, and the rewind is kept or undone in the
same way once the session is open again.

## The three rewinds

Code puts back every file changed since the checkpoint began. A file changed
in several later checkpoints takes its copy from the earliest of them, the one
taken closest to the checkpoint. The conversation stays whole. When the rewind
is kept, the model is told in a message which files went back, and the redo
copies go into the latest checkpoint for each file it holds no copy of yet, as
any other first change would. A later code rewind to that checkpoint can then
bring those files back. Where the latest checkpoint already held a
file, its copy from earlier in the turn wins, and the content from just before
the rewind is gone once the rewind is kept. A file the model wrote before the
rewind has moved on disk since it last read it, so the read index refuses an
edit to it until it has been read again (`tools.md`).

Conversation leaves the files as they are. When it is kept, the history is cut
back to the marker and the compaction marks are put back. The notes and
compaction records from that turn on are dropped, the turn number goes back,
and that checkpoint and every one after it are dropped. The message the turn
began with goes into the composer when the rewind is made, to be sent again or
changed first. Of a message sent with snippets, only the words the user typed
go back (`commands.md`). The read index cannot tell which of its reads were in the turns
that were cut, so it forgets them all. Every file it knew of, and every file
changed from that turn on, has to be read again before it is rewritten
(`tools.md`). An answer a background job delivered after the checkpoint began
goes with the cut, like anything else the conversation took in from then on.

Dropping checkpoints would lose the only copy of a file first changed in a
dropped turn. So the checkpoint before the cut takes over the copy of each such
file it does not already hold. That file was unchanged through the earlier
turn, so its content when the dropped turn began is also its content when the
earlier one began, and a later code rewind past the cut still puts it back.
The argument holds for changes the store sees. A file `bash` changed during the
earlier turn, and that `edit` first touched in the dropped one, comes back as it
stood after the `bash` change.

Both puts the files back and, when kept, cuts the conversation as above.

A kept rewind leaves a note in the conversation naming the files it restored
and any it could not. Tokens already spent stay spent, in the session's total
and in the usage log.

The files have changed on disk by the time the index is written. When that
write fails, the rewind holds in memory for the rest of the run, the failure is
reported as a fault, and the index catches up with the next save.

A rewind is refused while a turn or a compaction runs, and the main process
also refuses it while a background job in the session is still running. A job
could write a file straight after it was put back, or finish into a
conversation that no longer asked for it. The rewind itself holds the session
the way a turn does, so no turn starts while the files are half put back.

## Subagents

A subagent writes through the same store as its parent, passed down as the
`guard` in `SpawnDeps`. The main process opens one store per session for the
whole launch. A background job outlives a session that is rebuilt after a
settings change, and keeps writing through the store it was given, so the
rebuilt session has to use that store too. It never begins a checkpoint of its own, so what it
writes goes into whichever of the parent's checkpoints is latest at the time.
For a subagent that runs inside a turn, that is the turn that asked for it. A
background job can outlast its turn, and what it writes after the next turn
began goes back with that later turn.

## The window

`session:checkpoints` lists the checkpoints oldest first, and the held rewind
as its checkpoint and mode. Each checkpoint carries its marker, the number of
files first changed in its own turn, and the files a code rewind to it would
put back, relative to the session's folder. The list is read from disk when
the session is not built, so drawing the turns does not start a provider or
any MCP servers.

`session:rewind` builds the session if it has to and holds a rewind to the
checkpoint it names, or undoes the held one when the id is null. It returns
what was restored and, when the conversation went back, the message to put in
the composer. It saves nothing else, because the conversation has not changed
yet. When a turn, a compaction or a TL;DR keeps the rewind, the session stores
the cut transcript and its state straight away, before the turn goes on, so a
turn that fails leaves the conversation on disk agreeing with the checkpoints.

A turn that begins live sends `session.checkpoint` with its id, number, marker
and first line, so the window can add it to the turns on screen without asking
for the list again.
