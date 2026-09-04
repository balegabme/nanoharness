# Contributing

## Development setup

    pnpm install
    pnpm typecheck
    pnpm lint
    pnpm test

## Conventions

- Keep the codebase small. Token efficiency is a core goal; see plan.md.
- Doc map: every source file starts with `// doc: docs/harness/<area>.md`,
  and every doc lists its files under a `Files:` heading.
- Keep prose plain: simple verbs, no em dashes, no bold labels in lists,
  no sales language.
- Commits follow Conventional Commits (https://www.conventionalcommits.org/).
