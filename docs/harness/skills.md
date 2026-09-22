# Skills

A skill is a folder with a `SKILL.md`: instructions for one kind of task,
written once and reused. Plan §8.

Files:
- src/core/skills.ts: the loader, the frontmatter parser, and the injected list

## The format

`.nanoharness/skills/<folder>/SKILL.md`, with frontmatter naming it:

```markdown
---
name: Release checklist
description: Cut a release, covering version bump, changelog, tag, and what
---

Steps...
```

`name` and `description` are all that is read. A folder without a readable
`SKILL.md`, or without a description in it, is skipped. Without a `name`, the
folder's own name is used.

The frontmatter parser is `key: value` lines between two `---` fences and
nothing more. These files are written by hand.

## Why the prompt carries the list and not the documents

A skill is a document, often a long one, and the system prompt is the one block
of text re-sent in full for the life of a session. Putting the documents there
means paying for every skill on every request of every turn, whatever the task
is about.

So the prompt carries one line per skill: name, description, path. The agent
reads the one it needs with the `read` tool it already has, once, when a task
matches. Ten skills cost ten lines.

The list is sorted by name. The same skills in a different order are different
bytes, and different bytes invalidate the prompt cache between turns. A
workspace with no skills injects nothing at all.

Skills are read once, when the session is built, so adding one to the folder
means the next session sees it. That is the cache again: the block sits inside
the cached prefix, and changing it mid-session throws the prefix away.
