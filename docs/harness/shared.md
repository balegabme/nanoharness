# Shared helpers

The small pure functions that the main process, the `nh` CLI and the window
all need: pricing a turn, adding up usage, writing a number for a person to
read, and reading a diff back out of a tool result. Each is defined once, here.

Files:
- src/shared/facts.ts: the provider wires, the effort scale, what a model's facts come to after the user's corrections, and what a turn cost
- src/shared/usage.ts: adding, subtracting and dividing token counts
- src/shared/format.ts: token counts, rates, percentages and dollars as the harness writes them
- src/shared/json.ts: the two checks every reader of parsed JSON makes
- src/shared/diff.ts: the unified diff a write or an edit hands back, and reading it out of the result again
- src/shared/plan.ts: the plan `todo_write` carries, checked once for the tool and read back out of a call for the window
- src/shared/questions.ts: what `ask_user` asks and how an answer is shaped, checked the same way for the tool and the window

## Why a directory of its own

The window is served over `app://`, and the handler there only answers for
`out/renderer` and `out/shared` (`ui.md`). A module in `src/core` would 404 in
the window, so anything the window needs at runtime has to live in one of
those two places. Putting the helpers in `src/shared` lets the window, the main
process and the CLI load the same function, and a figure on screen cannot
disagree with the same figure printed by `nh usage`.

A renderer module sits at the root of the page, so its `../shared/format.js`
resolves to `/shared/format.js`. The handler maps that prefix onto
`out/shared` and still refuses a path that climbs out of it.

## What may go in

One eslint rule, with two patterns, keeps the directory loadable in both
places:

- A file in `src/shared` may import values only from `src/shared`. Types from
  anywhere are fine, since they are erased before the window sees the file.
- It may not import `node:*` or `electron`, which do not exist in the window.

A helper belongs here when it touches no DOM, no file and no network, and
more than one part of the tree calls it. A family stays together, so the usage
arithmetic lives here whole even where a given function has callers on only one
side. A helper that one module alone uses stays in that module.
