---
name: Release checklist
description: Cut a release - version bump, changelog, tag, and what to verify before pushing
---

# Release checklist

Only the description above is loaded into the system prompt. You are reading
this file because a task matched that line, which is the whole point: ten
skills cost ten lines until one of them is needed.

## Before you start

Confirm the working tree is clean and the branch is the one you mean to
release from. Everything below assumes both.

## Steps

1. Decide the version from what changed since the last tag: a breaking change
   is a major, a new feature is a minor, everything else is a patch.
2. Set that version in `package.json`.
3. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new heading
   with the version and today's date. Leave `## [Unreleased]` in place, empty.
4. Run the checks that gate a merge, and read the output rather than the exit
   code.
5. Stop. Report the version, the changelog entry and the check results, and
   let the person decide whether to tag and push.

## What not to do

Do not tag, push or publish. Those are the steps that cannot be undone from
here, and they belong to whoever asked for the release.
