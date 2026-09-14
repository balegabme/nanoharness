# Changelog

All notable changes to this project are documented in this file.
Format based on Keep a Changelog; versioning follows SemVer.

Nothing has been released yet, so this file says what 0.0.1 will contain rather
than how it got there. An entry says what changed and, where a reader would
otherwise be surprised, what it was doing wrong before. The reasoning behind a
design is in `docs/`, the full account of a defect is in
`docs/harness/improvements.md`, and the step-by-step development history is in
the git log; none of the three is repeated here.

## [Unreleased]

### Added

**Core**
- Session loop with an event bus, typed IPC, and the `bash`, `read`, `write` and
  `edit` tools.
- Independent tool calls in one assistant message run together where the tool
  declares itself read-only, and in the model's order either way.
- OpenAI-compatible and Anthropic-compatible streaming providers, as wire
  formats rather than vendors. As many configured providers as you want, of
  either kind, side by side.
- Thinking effort as one neutral setting (`none`, `low`, `medium`, `high`),
  mapped to `reasoning_effort` or to a thinking budget.
- Thinking is stored and replayed where the provider signed it.
- A system prompt built per session, naming the workspace root, the platform,
  the shell and the date.
- No round budget on the tool loop. A model going in circles is caught instead:
  a repeated call is refused and the turn ends with a note; a run of failures
  appends a nudge to the result and carries on.
- `src/core/roots.ts` separates the workspace root from the harness root.

**Agents**
- Three roles — builder, planner and harness editor — chosen per session. A role
  decides the tools, the shell and what the prompt names. The planner cannot
  write, and its shell says so in the role's own words.
- `spawn` hands one piece of work to another agent, `clone` (this conversation's
  prompt, tools and history) or `distinct` (its own prompt, no history). Nothing
  nests, and a subagent is held to its parent's folder.
- Background jobs: `spawn` with `background: true` returns a job id and the turn
  carries on. Progress goes through `job_update`, and a strip under the session
  tree shows what is running.
- Anything about the harness goes to a harness-editor subagent. It is the only
  role whose prompt names the harness at all.

**Workspaces and scope**
- Folders in a sidebar, each holding its own sessions. The session index and one
  transcript per session live in the user-data dir, so re-opening a session or
  restarting the app replays what was said and done.
- A session file stores the notes beside the messages, so a re-opened session
  shows what the window showed: an error, a stop, a turn with no answer, a
  refused repeat, a background job.
- Every session is held to its folder. Tools resolve paths through an access
  gate that walks symlinks and expands `~`, and accepts both the Windows and the
  Git Bash spelling of a path. Reaching outside raises one modal naming the
  resolved path: allow once, allow for the session, or deny. A denial reaches
  the model as a tool error, so the turn continues. The gate is on the file
  tools (`read`, `write`, `edit`); a shell command has no path to resolve, so it
  is approved whole: the modal shows the command, and its session answer allows
  every later command.
- The NanoHarness checkout is readable without a prompt when the app runs from
  source. Writing to it still asks.
- A stop button, and Esc in the composer. The request in flight is aborted and
  the loop ends at the next boundary; whatever arrived is kept.

**MCP**
- MCP client: stdio and Streamable HTTP transports, handshake and version
  negotiation, a tool catalog read to the end of its cursor, per-request
  deadlines with advisory cancellation, and JSON Schema narrowed to what a
  provider accepts. Server tools join the session as `mcp__<server>__<tool>`.
- Two config files, `~/.nanoharness/mcp.json` and `.nanoharness/mcp.json`, where
  a project entry replaces a global one by name and `"enabled": false` switches
  it off. Both name a token's environment variable rather than holding the
  token. No server is configured by default.
- `nh mcp list | add | remove | check`. `check` proves a server works by
  connecting to it through the same client a session uses.
- The system prompt tells the agent which servers answered and where the config
  files are.

**Skills**
- `.nanoharness/skills/*/SKILL.md` are listed in the system prompt one line
  each, and the agent reads the one it needs. The documents never enter the
  prompt.
- `examples/mcp.json` and `examples/skills/release-checklist/`.

**Tooling**
- Doc map with `nh doc-check` in CI, the improvement ledger and its
  `log_improvement` tool, and `nh usage` over a per-turn usage log.
- Repository scaffold: tooling, CI, OSS files.

**Desktop app**
- A two-column shell: sidebar of folders and sessions, a topbar naming the open
  session, the transcript in the middle, and the controls on the composer. The
  sidebar collapses to a rail.
- Settings as a sheet with its own nav: providers, their keys and their model
  allowlists, plus a connection test that doubles as the model picker.
- First run asks for a provider. The key is encrypted by the OS and the settings
  file has no field to put one in.
- Model and effort pickers in the header.
- Running usage in the topbar, stored with the session: in, out, cached, cache
  hit rate and tokens per second, plus reasoning and cache-written where the
  provider reports any. The rate counts the time the model spent generating, so
  a tool call in the middle of a turn does not drag it down.
- End-of-turn blip and a desktop notification when the window is not in front,
  both silenced by the `alerts` bell.
- Nothing is drawn by the browser: the app has its own confirm and prompt
  sheets, and styles the native select popups through `appearance: base-select`.
- Three layers of design tokens — a raw ramp, aliases naming what a colour is
  for, and components that read only aliases — with one easing curve, three
  durations, and a single spacing and radius vocabulary. Dark only.
- The brand mark is the window icon, the app icon, and the empty state.
- A renderer that fails to load writes a banner into the page instead of leaving
  a blank window.

### Changed
- A provider is configured in the setup screen and nowhere else. Nothing about a
  vendor is compiled in: no default base URL, no default model, no fallback key,
  and no `OPENAI_*` environment variables.
- The base URL is joined to an endpoint by rule, so a base that already ends in
  a version segment is not given a second one.
- The API key goes out as both `x-api-key` and `Authorization: Bearer`, because
  Anthropic-compatible gateways differ on which they read.
- Thinking is read from every spelling the OpenAI-compatible world uses.
- A session runs in its folder rather than in whatever directory Electron was
  launched from.
- Every agent thinks at the session's own effort; roles no longer carry one.
- A spawn asking to clone into another role runs that role distinct instead.
- The system prompt says there is no screen, no browser and no image here, that
  a limit the user states is part of the task, and that an interruption gets an
  answer in words before another tool call. An agent told in the first line that
  browser tools were pointless probed for Chrome, Edge, puppeteer and playwright
  anyway, twice after being asked to stop.
- An eslint rule stops the renderer importing runtime code from `src/core`,
  `src/ipc` or `src/main`, which would 404 at load and open a blank window.

### Fixed
- The Anthropic wire sends the assistant's signed thinking blocks back on
  tool-using turns. They were being dropped, which that API rejects.
- A clone no longer inherits the parent's unanswered `spawn` call, which made
  every clone die on a `tool_calls` message nothing had replied to.
- Git Bash paths resolve on Windows. `/c/project/file` used to reach
  `<drive>:\c\project\file` and come back as a missing file or a refusal naming
  a path nobody meant. `/usr/bin` is left alone.
- A denial is remembered, and a path already refused this session is answered
  from that refusal instead of asking again.
- A refused tool call is stored as refused, so a re-opened session shows it in
  red rather than as a successful call.
- A turn that ends with no answer says so.
- An assistant message with no text, no tool call and no thinking is not stored:
  it drew a blank block, and some providers refuse to be sent one back.
- `nh mcp --help` and its variants print the help, and a wrong flag prints the
  message and the help.
- A shell command longer than 8 KiB runs whole. Git Bash cuts a `-c` string at
  that size and runs the front of it, so a 12 KB patch script was executed half
  written; the command now goes to bash as a script file.
- Paths are no longer read out of shell commands. The screen that did it turned
  `</script>` into `C:\script`, `2>/dev/null` into `C:\dev\null`, a browser
  probe's Program Files paths into three separate prompts, and a README URL into
  `e://`; every false prompt stopped a command that had nothing to do with the
  place named. The shell is approved whole instead, never parsed: the modal
  shows the command and offers allow once, allow all shell commands for the
  session, or deny. A gate with nobody to ask refuses the command rather than
  run it unscreened.
- A refusal no longer says "you denied access to it". A closed window produces
  the same refusal, and the old wording sent agents hunting for another route to
  the same place, one modal per attempt.
- A background job still running when the app closes is written into the
  conversation that started it, instead of disappearing with the process while
  the last message promises its report.
