# What it cost

Every finished turn is written down, and this is the page about reading those
lines back: what was spent, by which folder, session, model and agent, and on
which day.

Files:
- src/core/usage-report.ts — the usage log grouped by day, folder, session, model, agent and phase
- src/renderer/cost.ts — the spend view: the day chart and the breakdown tables

The record itself is `src/core/usage-log.ts`, which `overview.md` explains, and
the terminal printing of this report is `src/cli/usage.ts`, in `cli.md`.

## One report, two drawings

`buildReport(records, options)` does all of the arithmetic. The main process
calls it for the window over the `usage:report` channel and `nh usage` calls it
for the terminal, so a figure on screen and a figure in a shell cannot
disagree. Nothing downstream adds up a token or a dollar of its own.

It lives in core rather than in the renderer because the renderer is a separate
bundle that may not import core at runtime (`ui.md`), and a second copy of the
grouping would be a second set of numbers to keep true.

## Prices are frozen when the money is spent

A turn's cost is worked out while it runs, from the prices the model carried at
the time, and stored on the record. Re-pricing an old turn against today's
price list would answer "what would last month cost now", which is a question
nobody asked; a bill does not change when a vendor updates a page.

A model with no prices set gives `costUsd: null`. That is a reading, not a
zero: the tokens are counted, the dollars are not, and every total carries
`unpriced`, how many of its turns are in that state. The window says so under
the headline and `nh usage` prints it beside the total, because a figure that
is short and does not say so is worse than no figure.

The one thing an unpriced turn still contributes is `harnessCostUsd`. The
approval model is priced at its own rates whatever the session's model is
(`approval.md`), so that dollar is known and is counted.

## Where it went

Three spenders live inside one turn, and the record keeps the two that are
shares of the total: `subagent` and `harness`. The conversation itself is the
total less those two, which is why a phase table always adds up to the report's
total rather than to something near it.

- **Conversation** — the session's own model, on the session's own thread.
- **Subagents** — what the agents this turn started spent (`agents.md`).
- **Approval checks** — the second model answering permission questions in auto
  mode.

A phase with nothing in it is left out rather than printed as a nought.

## Days, and the days nothing ran on

The window is whole local days: a day of spend is a day the person had, not a
UTC window that cuts their evening in half. `--days N` and the range picker
count back N days with today included; all time starts at the first turn the
log holds.

`byDay` has a row for every day in the window, including the empty ones. A gap
drawn as an empty day reads as a quiet Sunday; the same gap closed up reads as
a week of steady work.

## Names are not in the log

The log stores ids. Folders get renamed and sessions get deleted, and a name
copied into a line last month would be wrong by now, so names are resolved at
read time from the workspace store (`usageNames()` in
`src/main/workspace-store.ts`).

An id that names nothing any more still spent money, so its row stays, labelled
`3f1c9a2b · deleted session` and marked `gone`. Dropping it would make the
breakdown stop adding up to the total above it.

## The view

The spend view is drawn where the conversation is, opened from the Spend item
in the sidebar foot or from the session's own usage line in the topbar, and the
back button returns to whatever was open behind it. It belongs to the window
rather than to a session: the tables are every session the log has seen, which
is why it is not scoped to the one on screen.

The headline is the window and the money, then the turns, cache hit rate,
tokens each way and throughput as the same pills the topbar uses.

Under it is a bar per day with the cache hit rate drawn over it. The two share
a chart because they answer each other: a day the bars jump while the line
drops is a prompt prefix that stopped matching, which is the cheapest thing in
the harness to miss and the dearest to keep. The line breaks across days that
ran nothing, because joining them would invent a slope between two weeks that
never happened.

Then the breakdowns, dearest first, each row carrying its share of the dearest
row as a bar behind the text. Rows past the tenth are summed into a last line
instead of dropped, for the same reason a deleted session keeps its row.

The report is re-read every time the view is opened. The log is appended to by
every turn in the window, so a view held open would be answering a question
about ten minutes ago.

## Clearing it

**Clear** in the head of the view deletes the log. It asks first, and the
question names the whole log rather than the range on screen, because the whole
log is what goes: the range picker narrows the report and leaves the record
alone. Nothing keeps a copy and there is no undo.

Sessions and their transcripts survive it. The log sits beside them as a record
of spend, and someone clearing a month of test turns is not asking for their
conversations back.
