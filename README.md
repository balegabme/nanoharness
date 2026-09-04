<p align="center">
  <img src="docs/assets/brand/logo.svg" alt="NanoHarness logo" width="220">
</p>

<h1 align="center">NanoHarness</h1>

<p align="center">
  <strong>The AI coding harness that improves and fixes itself.</strong>
</p>

<p align="center">
  <a href="https://github.com/balegabme/nanoharness/actions/workflows/ci.yml"><img src="https://github.com/balegabme/nanoharness/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node >=20">
  <img src="https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white" alt="pnpm 11">
  <a href="https://www.conventionalcommits.org"><img src="https://img.shields.io/badge/commits-conventional-FE5196.svg" alt="Conventional Commits"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
</p>

NanoHarness is a small, token-efficient, self-documenting coding harness, and the agent can edit it. When something breaks or could work better, the harness changes its own source. Every self-edit goes through user review, tests, and safe mode, so nothing changes unless you approve it.

## What makes it different

- The agent edits its own source to fix bugs and improve how the harness works. You review and test each change before it applies.
- Every source file starts with a `// doc: docs/harness/<area>.md` header, and every doc lists its files. The codebase explains itself.
- Works with OpenAI-compatible APIs and Anthropic from day one.

## Status

Early, active development. The specification and build order are in
[plan.md](plan.md) (section 18). Research notes live in
[docs/research/](docs/research).

## Development

Requires Node 20+ and pnpm 11.

    pnpm install
    pnpm typecheck
    pnpm lint
    pnpm test

## Community

- [Contribute](CONTRIBUTING.md). PRs welcome; commits follow Conventional Commits.
- [Discussions](https://github.com/balegabme/nanoharness/discussions) for questions and design ideas.
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md): report vulnerabilities privately.

## License

[Apache-2.0](LICENSE)
