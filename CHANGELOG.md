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

- Three agent roles — builder, planner and harness editor — as a chip on the
  composer. A role decides the tools, the shell and the default effort, and the
  harness editor is handed the doc index and the improvement ledger, so a
  request lands in the right file. The planner cannot write: its shell refuses
  redirects, the file verbs, in-place edits, mutating git subcommands and
  package installs, and says so in the words of the role.
- A `spawn` tool that hands one self-contained piece of work to another agent.
  `clone` reuses this conversation's prompt, tools and history byte for byte,
  so the provider's cache pays for most of it; `distinct` starts the agent from
  its own prompt with no history, for work that must not see the conversation.
  Nothing nests — a subagent has no spawn host and says so if it tries — and a
  subagent is held to exactly its parent's folder.
- Background jobs: `spawn` with `background: true` returns a job id at once and
  the turn carries on. The job posts progress with `job_update` and its answer
  when it ends, and a strip under the session tree shows which agent is
  running, what it was asked, and its last line.

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
- The window was redesigned around three layers of design tokens — a raw ramp,
  aliases naming what a colour is for, and components that read only aliases.
  One easing curve and three durations replace per-rule timings, and the
  surfaces, radii and spacing are a single vocabulary.
- The app is dark and only dark, as plan section 3 always said. The light
  aliases, the `prefers-color-scheme` block and the sidebar's theme toggle are
  gone: a second theme is a second design to keep honest, and nobody was asking
  for this one.
- The composer is one element in two seats: centred in the hero before a session
  exists, in a card floating over the flow once one is open. Moving the node
  rather than mounting a second copy keeps a half-written message and the caret
  across the move, and the flow's tail spacer is written from the card's
  measured height instead of a guessed one.
- The sidebar collapses to a rail of icons, and the mark in the rail is the
  button that brings it back.
- The app icon is drawn full bleed. The old artwork carried its own margin, so
  Windows scaled the whole square into the taskbar slot and the mark landed
  visibly smaller than every icon beside it. `scripts/brand-icons.cjs`
  rasterises the sizes Windows asks for, up to 256.
- The composer's controls could be painted under the dock's fade gradient: the
  gradient is positioned and the card was not, so it won on paint order. Every
  child of the dock now has a stacking position of its own.
- A renderer that fails to load says so in the window. A failed load, a preload
  error or a console error now writes a banner into the page instead of leaving
  a blank window and a message on a stdout that Windows discards.
- A running turn is shown in the flow, at the end of it: three dots and the
  elapsed time, and nothing at all when no turn is running. The `idle`/`working`
  chip in the top corner is gone; the chip is kept only for `offline`.
- The running total moved off the control row into the topbar, beside the title
  and the folder. On the row it was the first thing squeezed out as the chips
  grew, and on a line under them it landed on the card's rounded bottom corner
  next to the send button. It is also stored with the session now: re-opening
  one shows what it has already cost instead of starting the count at zero.
- The composer chips draw their own labels with the native select laid over
  them. A select sizes itself to its widest option, so one long model id used to
  shove the row along; now the model chip is the one that gives way when the
  window narrows.
- `New session` and `Settings` were drawn in the chat flow's label style —
  uppercase, 10px, nudged off centre — because they shared its class name. They
  read as buttons again, on the search field's height and radius with their
  glyphs in the same column as its magnifier.
- The running total is a row of pills rather than a run-on line, and it counts
  tokens per second alongside in, out, cached, hit rate and reasoning. The rate
  is measured in the window — the provider reports a running total, so a round's
  rate is the output that arrived over the time it took — and a round too short
  to measure does not claim one.
- The `alerts` toggle is a bell, struck through when it is off.
- A session with nothing in it yet shows the mark behind the flow, faint and
  large, instead of a blank rectangle. It goes as soon as anything is appended.
- The running-turn dots share the message column instead of sitting against the
  left edge of the window.
- Nothing the app opens is drawn by the browser any more. `confirm()` is
  replaced by a sheet in the app's own vocabulary, and the `<select>` popups are
  styled through `appearance: base-select` — the app's surfaces and shadow, the
  accent on the ticked row, a checkmark in a column of its own, and a chevron
  drawn in CSS. Browsers without the property keep the platform popup.
- A provider is removed by the `x` on its own card, after a confirmation naming
  it. The old **Remove provider** button sat in the form, where it acted on
  whichever provider happened to be loaded.
- The **Active model** control is gone from settings; the model chip on the
  composer is the one place to change it. A save keeps the running model if it
  is still ticked and falls back to the first ticked one if it is not, so a
  provider is never left without a model to run.
- The about pane is the mark, "Built with a heart by balega", and a link to
  @BalegaNorbert on X. The window itself cannot navigate, so the link goes out
  through a `shell:open-external` channel that refuses any scheme but `http:`
  and `https:`.
- `New session` and `Settings` put their glyph and their label on one line and
  in one column, and the settings glyph is a set of sliders: a 24-grid cogwheel
  turns to mush at 16px. The sheet's close control is an `x` and nothing else.
- The composer's control row is measured against the card instead of the
  window, since the same card is narrow with the rail open and wide with it
  collapsed. When it tightens, `alerts` drops out first and the scope badge
  second — both repeat what the settings pane says — so the three selects keep
  their full labels instead of the model id collapsing to two characters.
