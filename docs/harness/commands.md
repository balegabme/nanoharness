# Commands and snippets

The composer has a menu of its own. A `/` typed at the start of the draft or
after a space opens it, and so does the `/` button among the controls. It lists
the commands the open session can run now, then the prompt snippets. Plan §9
covers the snippets.

Files:
- src/renderer/commands.ts: the menu, what opens and narrows it, and its keys
- src/renderer/snippets.ts: the snippets added to a draft, above and below it, edited and dragged into order
- src/core/snippets.ts: the snippet file format and the three folders it is read from
- src/core/tldr.ts: the `/tldr` instructions, and the choice between sending the whole conversation and the answer alone

## The menu

The letters typed after the slash narrow the list to the entries whose name
contains them. A snippet also matches on its file name, so `/session-k` finds
"Session kickoff". Each snippet row says which end of the message it goes to,
and says "yours" or "project" when the file came from the user's folder or the
project's and not from the app. Up and Down move through the list, Enter or Tab picks, and
Esc closes it. The menu takes those keys before anything else on the composer
sees them, so while it is open Enter picks an entry instead of sending, Up
moves in the list instead of recalling a sent message, and Esc closes the menu
without stopping a turn. Picking an entry takes the typed `/word` back out of
the draft. A click on the menu keeps the caret in the draft.

A command is listed only when it can run: a session is open, no turn,
compaction or rewind is running, and the flow on screen is the session's own
and not a subagent's. A rewind the user left held is kept by `/tldr` and
`/compact` before they ask anything, as the next message would keep it
(`checkpoints.md`).

Enter picks whatever is highlighted, so a draft that ends in `/re` runs
`/reload`. With nothing to pick, Enter sends the draft as it is, so a message
that starts with a path such as `/usr` still goes out, and Esc closes the menu
so the next Enter sends. Typing anything that is not a `/word` closes the menu,
the one the button opened included. While the snippets are still being read,
an Enter with nothing to pick waits for them.

| Command | What it does |
| --- | --- |
| `/tldr` | Shortens the last answer |
| `/compact` | Summarises the older part of the conversation now, as "Compact now" in the context panel does (`context.md`) |
| `/reload` | Builds the session again, so it reads its skills, hooks and MCP servers afresh |

## /tldr

`Session.tldr()` shortens the last assistant message that has text in it. The
result is drawn in the flow as a TL;DR card and saved with the transcript as a
note of kind `tldr`, so it comes back when the session is reopened. It never
goes into the conversation the model sees, which already holds the answer.

It can ask in two ways. The whole conversation, with the instruction added as a
last user message, reads the prefix the provider has cached, and the model
knows what the answer was for, which makes a better TL;DR. The tools are still
offered in that request, because leaving them out would change the cached
prefix, and the instruction tells the model not to call them. The answer alone
goes with a small system prompt of its own and no tools.

`tldrRoute` picks one by what the prompt would cost. The whole conversation is
priced with its cached part at the cache-read rate and the rest at the
cache-write rate, falling back to the input rate where the model has no write
rate. It is chosen unless it costs more than twice the answer alone, since the
context is worth paying something for. Where the prices are unknown it is
chosen when the cache is warm, and otherwise only when it is at most twice the
size of the answer alone.

The cache is taken as warm for five minutes after a request carrying the
session's prefix last came back (`CACHE_WARM_MS`). Endpoints that cache keep a
prefix at least that long after it was last read, and some keep it longer, but
none of them says so in its answer, so the shortest is assumed. A cold cache is
priced as if the whole prefix were written again.

If the whole conversation comes back empty, or with a tool call, the answer is
sent alone. Stop ends a TL;DR the same way it ends a compaction. The requests
are the harness's own spend: they are added to the session's harness figures
and written to the usage log as a between-turns line, like a compaction started
by hand.

## /reload

Skills, hooks and MCP servers are read when a session is built, because they
feed the system prompt and the tool list, and those are the cached prefix. A
change to them mid-session would throw the prefix away on the next request.
`/reload` is how the user asks for that anyway: `session:reload` drops the
live session, closes its MCP servers, and builds it again at once. Building it
reads the skills, the hooks and both `mcp.json` files, asks about a project's
hooks and servers again if they are not trusted yet, and runs the SessionStart
hooks. A note in the flow says how many skills were found and how many MCP
servers connected, and that the next message pays for the whole prompt once.

It is refused while a turn runs, and while a background job of the session is
still running, because a subagent reaches MCP servers through the session's hub
and the rebuild closes it. The permission answers the user gave in this
session outlive the rebuild, the same as they do when a setting changes.

## Snippets

A snippet is a Markdown file with frontmatter:

```markdown
---
name: Session kickoff
description: Get oriented, report back before starting work
placement: prepend
order: 10
---
Familiarize yourself with this project before we start. ...
```

`placement` is `prepend` or `append`, and anything else counts as `prepend`.
`order` sorts the menu, lowest first, and a snippet without one comes after
every snippet that has one. The name falls back to the file name. A file with
nothing after its frontmatter is skipped, and so is a `README.md`.

Three folders are read, each overriding the one before by file name:

1. the snippets shipped with the app, from the repository's `snippets/`,
   copied to `out/snippets/` by the build;
2. the user's own, in `snippets/` under the data directory (the folder that
   holds `usage.jsonl`);
3. a project's, in `.nanoharness/snippets/`.

They are read from disk each time the menu opens, so a file added to a folder
shows up the next time without a rebuild. From the hero, before a session is
open, the project folder is not known and only the first two are read.

### In the composer

Picking a snippet adds it to the draft as a block of its own: `prepend` ones
above the text the user is writing and `append` ones below it. Each block has a
chip with the snippet's name, an estimate of the tokens it adds and a remove
button, and under the chip a box that edits the text for this message only. The
estimate is `textTokens`, four characters to a token, the same heuristic the
context meter uses.

A block is dragged by its chip. Dropped in the same stack it changes place
there. Dropped in the other stack it changes placement as well, so a `prepend`
snippet can be sent at the end. While one is being dragged both stacks show as
drop targets, the empty one included.

The message is assembled on send: the blocks above, the draft, the blocks
below, in the order they are on screen, with a blank line between each. The
blocks are cleared once it is sent. Until then they belong to the draft, and
stay with it when another session is opened, as the draft does. Plan §9 asks for a live preview of the
assembled message. The stacks are that preview, since they sit in the order
the message is sent and hold the exact text, and a second copy of the message
under the first would add nothing.

The draft and the snippet texts travel to the main process apart, and each is
checked for secrets on its own. `compose` in `src/shared/compose.ts` joins them
there, and the window draws its copy of the message with the same function.
The stored message keeps `said`, the span of the draft inside it. The approval
judge reads those words first (`approval.md`). The session's title and the
turn index name the message by them alone, so a turn is not listed under the
first line of a snippet, and a message of snippets alone is named by the
snippets. Up in the composer and a rewind of the conversation put back only
those words. The snippets are not put back as blocks, and are picked again
from the menu if they are wanted, since text put back into the draft would be
sent as the user's own words.

Snippets go into the user's message and never into the system prompt, so
adding one changes nothing the provider has cached.
