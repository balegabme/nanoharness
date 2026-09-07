# Skills

A skill is a folder with a `SKILL.md`: instructions for one kind of task,
written once and reused. Plan §8.

Files:
- src/core/skills.ts — the loader, the frontmatter parser, and the injected list

## The format

`.nanoharness/skills/<folder>/SKILL.md`, with frontmatter naming it:

```markdown
---
name: Release checklist
description: Cut a release — version bump, changelog, tag, and what to verify
---

Steps...
```

`name` and `description` are all that is read. A folder without a readable
`SKILL.md`, or without a description in it, is skipped rather than guessed at: a
skill the agent cannot tell apart from another one is worse than one it never
hears about. Without a `name`, the folder's own name is used.

The frontmatter parser is `key: value` lines between two `---` fences and
nothing more. These files are written by hand; a parser that also accepted
anchors and block scalars would be more code than the feature.

## What gets injected, and why it is only the list

This is the whole design. A skill is a document, often a long one. Putting the
documents in the system prompt would mean paying for every skill on every
request of every turn, whether or not the task has anything to do with them —
and a system prompt is the one block of text that is re-sent in full for the
life of a session.

So the prompt carries one line per skill: name, description, path. The agent
reads the one it needs with the `read` tool it already has, once, when a task
matches. Progressive disclosure is not presentation here, it is the token
budget: ten skills cost ten lines instead of ten documents.

The list is sorted by name, because the same skills in a different order are
different bytes and would invalidate the prompt cache between turns for no
reason at all. A workspace with no skills injects nothing at all — not even a
heading saying it has none.

Skills are read once, when the session is built. Adding one to the folder means
the next session sees it, for the same cache reason as the sorting: the block
sits inside the cached prefix, and changing it mid-session throws that prefix
away.
