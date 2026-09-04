# Changelog

All notable changes to this project are documented in this file.
Format based on Keep a Changelog; versioning follows SemVer.

## [Unreleased]

### Added
- Initial repository scaffold: tooling, CI, OSS files (plan section 18, step 0).
- Session loop, event bus, typed IPC, OpenAI-compatible streaming provider, and
  the bash, read, and write tools (step 1).
- Doc map with `nh doc-check` in CI, the improvement ledger and its
  `log_improvement` tool, and `nh usage` over a per-turn usage log (step 2).
- Desktop window: a chat stream that renders the session event feed, a context
  bridge with no Node access, and one session per window (step 5, first slice).
- First-run setup screen: base URL, model and API key, with the key encrypted by
  the OS and the rest saved to a secret-free settings file.
- Provider setup tests the endpoint and fetches its model list, and the models
  ticked there are the only ones a session can run.
- A settings chip in the header reopens provider settings at any time.
- The brand mark is the window icon and sits in the app header.
- `src/core/roots.ts` separates the workspace from the harness root, so a
  harness-editor job runs against the nanoharness checkout rather than the
  project the harness was invoked in.

### Changed
- The window has no File/Edit/View menu bar any more.
- Nothing about a provider is compiled in any more. There is no default base
  URL, no default model and no fallback key; a missing value opens setup instead
  of silently reaching for a vendor.
- A provider is configured in the setup screen and nowhere else. The
  `OPENAI_*` environment variables are gone and nothing replaced them: since
  the app cannot run until a provider is set, one place to set it beats a
  screen plus a set of variables that silently outrank it.
