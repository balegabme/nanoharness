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
- As many providers as you want, of either kind: settings keeps a list of
  records rather than one endpoint, so a local server, an OpenAI-compatible
  service and an Anthropic account can sit side by side, each with its own key
  and its own model allowlist.
- Anthropic provider: `/v1/messages` streaming with named events, the system
  prompt lifted to its own field, tool results as `tool_result` blocks, and
  usage read from both halves of the stream.
- Thinking effort as a neutral setting (`none`, `low`, `medium`, `high`) that
  becomes `reasoning_effort` on the OpenAI wire and a thinking budget on the
  Anthropic one, with `max_tokens` raised to clear the budget.
- Model and effort pickers in the header, so switching either takes one click
  instead of a trip through settings.
- Workspaces and sessions: folders in a left sidebar, each holding its own
  conversations, with search, an add-folder picker and per-row delete. The
  session index and one transcript file per session live in the user-data dir,
  so re-opening a session — or restarting the app — replays what was said and
  done.
- Every session is held to its folder. Tools resolve their paths through an
  access gate that walks symlinks and expands `~` before deciding, so `..`,
  an absolute path and a home-relative path are all caught. Reaching outside
  raises a modal naming the path: allow once, allow for this session, or deny.
  Denial comes back to the model as a tool error, so the turn continues.
- A two-column app shell: sidebar of folders and sessions, a topbar naming the
  open session and its folder, the transcript in the middle, and model, effort,
  scope and running usage on the composer's control row.
- Settings is a sheet over the app with its own left nav, not a screen the app
  falls back to.
- A stop button. Send becomes Stop while a turn runs, and Esc in the composer
  does the same: the request in flight is aborted and the loop ends at the next
  boundary. Whatever arrived is kept, a tool call the stop landed on is told it
  never ran, and the session can be continued.
- The app announces the end of a turn: a short blip, and a desktop notification
  when the window is not the one in front. The `alerts` chip silences both.
- A system prompt built per session, naming the workspace root, the platform,
  the shell and the date — and saying outright that `bash` on Windows is Git
  Bash, not WSL, so there is no `/mnt/c` to go looking for.
- Thinking is stored and replayed where the provider signed it, so a re-opened
  Anthropic session shows the reasoning it actually sent back.

### Changed
- The window has no File/Edit/View menu bar any more.
- Thinking is read from every spelling the OpenAI-compatible world uses
  (`reasoning_content` and `reasoning`), so servers that stream it now fill the
  thinking block instead of leaving it empty.
- Nothing about a provider is compiled in any more. There is no default base
  URL, no default model and no fallback key; a missing value opens setup instead
  of silently reaching for a vendor.
- A provider is configured in the setup screen and nowhere else. The
  `OPENAI_*` environment variables are gone and nothing replaced them: since
  the app cannot run until a provider is set, one place to set it beats a
  screen plus a set of variables that silently outrank it.
- A session runs in its folder rather than in whatever directory Electron was
  launched from.
- The small mark (`favicon.svg`) is used wherever the logo renders under about
  48px. The three window dots turn to mush at that size, so only the empty
  state and the window icon get the full mark.
- A refused tool call is stored as refused, so a re-opened session shows it in
  red instead of dressing it up as a successful call.
- One tool call now costs one permission prompt. Every path a call reaches for
  is resolved together and asked about in a single modal, device nodes
  (`/dev/null`, `NUL`) are not treated as paths at all, and a denial is
  remembered, so a command with four paths and a redirect no longer produces
  five prompts and a repeat of each.
- The base URL is joined to an endpoint by rule rather than by assumption: the
  `/v1` is added only when the base does not already end in a version segment,
  so `https://api.z.ai/api/paas/v4` and `https://api.z.ai/api/anthropic` both
  reach the right path. The settings field says which part of the address to
  paste, with examples per API kind, and the kinds are labelled by wire format
  (`/chat/completions`, `/messages`) rather than by vendor name.
- The Anthropic wire sends the assistant's signed thinking blocks back on
  tool-using turns. They were being dropped, which that API rejects.
- The API key goes out as both `x-api-key` and `Authorization: Bearer`, because
  Anthropic-compatible gateways differ on which they read.
- The full mark on the empty state is 112px and the sidebar mark 24px; the
  design tokens grew a hover surface, a second border weight and a soft accent
  wash, and the composer, sheets and thinking blocks were restyled on them.
- `suggestedBaseURL()` is gone. It answered `https://api.anthropic.com` for the
  Anthropic kind, which is a vendor address in a harness that talks to
  Anthropic-*compatible* endpoints; nothing called it.
- An eslint rule stops the renderer importing runtime code from `src/core`,
  `src/ipc` or `src/main`. The `app://` handler refuses anything outside
  `out/renderer`, so such an import 404s at load time and the window opens blank
  with nothing on screen saying why. Type imports stay allowed.
