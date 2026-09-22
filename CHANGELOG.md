# Changelog

All notable changes to this project are documented in this file.
Format based on Keep a Changelog; versioning follows SemVer.

Nothing has been released yet, so this file says what 0.0.1 will contain, and
not how it got there. An entry says what changed and, where a reader would
otherwise be surprised, what it was doing wrong before. The reasoning behind a
design is in `docs/`, the full account of a defect is in the improvement
ledger (`docs/harness/improvements.md` while it is open,
`docs/improvements-archive.md` once it is fixed), and the step-by-step
development history is in the git log; none of the three is repeated here.

## [Unreleased]

### Added

**Core**
- Session loop with an event bus, typed IPC, and the `bash`, `read`, `grep`,
  `glob`, `write` and `edit` tools.
- Independent tool calls in one assistant message run together where the tool
  declares itself read-only, and in the model's order either way.
- OpenAI-compatible and Anthropic-compatible streaming providers, as wire
  formats and not as vendors. As many configured providers as you want, of
  either kind, side by side.
- Thinking effort as one neutral setting (`none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`), mapped to `reasoning_effort` or to a thinking budget.
  The picker offers the levels the selected model takes, read from the endpoint;
  switching to a model with a narrower set clamps to the nearest level it has.
- Each fetched model carries the effort levels it takes, its price per million
  tokens, the most output it will produce, and whether it takes images,
  wherever the endpoint's `/models` answer says so. Images have three states:
  an endpoint that published nothing has not said no, and the setting offers
  the same three, so a model nobody has described stays undescribed. Every
  spelling of those fields anyone has been seen to use is read, and nothing
  outside the configured endpoint is consulted. A model it
  describes with none of them is marked with a warning in settings and can be
  described by hand there. A typed answer outranks the endpoint, field by field,
  and survives the next fetch. Fetching the models of a provider already saved
  stores what came back on the spot, so there is no second click to keep it.
- What a turn cost, from the model's prices and the tokens it used. Input,
  output and both halves of the cache are charged at their own rate; reasoning
  tokens are not charged again, because the output count already holds them. The
  figure ends the turn's summary line, and the running total in the topbar
  carries what the session has spent.
- An Anthropic request is built inside the model's own output ceiling, so the
  two highest effort levels no longer ask a smaller model for more tokens than
  it will produce and lose the round to a 400.
- Thinking is stored and replayed where the provider signed it.
- A system prompt built per session, naming the workspace root, the platform,
  the shell and the date.
- No round budget on the tool loop. A model going in circles is caught instead:
  a repeated call is refused and the turn ends with a note; a run of failures
  appends a nudge to the result and carries on.
- `src/core/roots.ts` separates the workspace root from the harness root.
- `grep` and `glob` search the workspace without a shell. Searching used to
  mean a `bash` command, which costs a process, runs alone, and on Windows
  takes most of a second before it has looked at anything. These run in the
  harness, and several of them in one message run at the same time. Both skip
  `.git`, `node_modules` and whatever a `.gitignore` excludes, never follow a
  symlink, and name every cap and skip they applied, so an empty answer says
  whether it looked. A pattern that will not compile is an error, and never no
  matches. A pattern is rooted at whatever directory precedes
  its first wildcard and the walk starts there; files are read 64 at a time;
  and searches running at once share a walk while it is running. Measured over
  a checkout of 19,859 files, one search went from 6,989 ms to 86 ms.
  `grep`'s `include` matches the file name when it has no separator in it, so
  `*.ts` and `chat.ts` both find what they name, and its `path` takes one file
  as readily as a directory. A walk that stops at the 20,000-file cap says so
  and reports what it found on the way, where it used to answer no matches
  having read nothing.
- The walk honours every `.gitignore` it meets, not only the one at the root,
  and reads the pattern syntax and not the plain names in it: wildcards,
  anchors, directory-only rules, and `!` lines that re-include what an earlier
  line excluded. Of the 74 rule lines in this project's own `.gitignore`, 73
  are applied, and `.env.*` no longer hides the committed
  `.env.example`. This is what a workspace opened at a parent directory rests
  on: over the directory this project sits in, a walk now reads 4,667 files in
  0.8s and finishes, where it used to reach the 20,000-file cap and be cut off.
  Both tools take `ignored: true` to search the excluded files anyway, for when
  the build output or a `.env` is what is wanted, and an answer that left
  something out says how much.
- A pattern is measured against the directory `path` named, where it used to be
  measured against the workspace root however the search had been narrowed.
  `glob("*", path: "project")` from a workspace one directory above that
  project answered with nothing, since every file there is `project/...` and a
  single star stops at a separator; `grep`'s `include` lost a pattern with a
  separator in it the same way. Paths still come back workspace-relative, which
  is what `read` and `edit` take, and an answer narrowed by `path` now says so:
  a search of `nanoharness` answering `nanoharness/README.md` had been read as
  one directory holding another of the same name.
- A half-sentence between two tool cards is drawn without the whitespace the
  model wrote around it, and sits with the call it introduces. A block body is
  `pre-wrap`, so commentary ending in a blank line drew a blank line, and the
  gap between two cards came out wider than the sentence in it; text that was
  only whitespace drew a labelled empty block.
- `read` numbers every line it shows, and says the numbers are not part of the
  file. An offset past the last line is an error saying how long the file is,
  where it used to come back as no lines at all.
- The session tracks what it has read. Asking again for lines of a file that
  has not changed returns a pointer to the lines already in the conversation
  instead of a second copy of them; the transcript was being paid for twice,
  once per overlapping slice. A wider read already in hand covers a narrower
  one; a read that runs past what was served is served.
- `edit` and `write` refuse a file this conversation has not read, and one that
  has changed on disk since it was read. Both are a rewrite of content nobody
  in the conversation has seen. Creating a file is unaffected, a session may
  keep editing what it wrote itself, and a session resumed from a stored
  transcript is not held to the rule for files it read before the resume.

**Permissions**
- Auto-approve mode, for the run nobody is watching: a task that goes for an
  hour while you are out. A session answers permission questions either by
  asking the person (the default, and what it always did) or by handing them to
  a second model. Work inside the session folder never asks in either mode; what
  the model sees is a path outside the folder or a whole shell command.
- The approval model answers **allow or deny, and nothing else**. It never hands
  a question back, because a verdict meaning "ask the person" would park an
  unattended run on a dialog two minutes after they left. Where it is unsure it
  denies, and the run carries on; the prompt tells it in as many words not to
  deny the ordinary, or the mode finishes nothing.
- The approval model is any provider and model already configured, given as an
  ordered ladder: the first rung that answers is pinned for the session, a rung
  that fails is retried on a short backoff and then unpinned so the next
  question climbs again, and when every rung fails that is an error carrying
  every reason. Nothing falls back to allowing.
- The person is asked in exactly one case: the approval model could not be
  reached at all, after retries. That is the absence of a verdict, and not
  one, and it is never read as a yes or a no.
- The mode cannot be turned on when nothing is configured to ask. The picker
  says why instead of switching and then prompting for everything.
- Rules in four buckets: never allow, allow only if the user asked for this
  specific thing, allow, and facts about the machine. A user's own rules are
  added to the built-in set and can never replace it. The soft tier is what
  separates a `git reset --hard` you asked for from one the model decided on.
- The judge reads the rules, the action, and the user's own messages. Never the
  assistant's and never tool results: tool output is the part of a conversation
  an attacker can write into, and a judge that reads it can be argued into
  approving what it is judging. Leaving it out is cheaper and safer at once.
- A judge that could not be reached is never turned into a verdict. The
  permission dialog goes up in its place with the reason printed on it.
- Every decision, verdict or failure, appends a line to
  `sessions/<id>.approvals.jsonl` beside the transcript: the action, the
  verdict, the rule, the model, the latency, the tokens and the cost. Nothing
  draws it; it is there so a decision nobody saw can still be read afterwards.
- What the harness spends on its own behalf is counted apart from what the
  conversation spends. The tokens are in the session total, because they are
  billed, under a `harness` split of their own, and their cost is summed at the
  approval model's own prices and not the session model's.
- The permission mode is per session and the preference behind it is app-wide:
  switching one session decides what the next new session starts in, and leaves
  the open ones alone. The chip says so on hover.

**Agents**
- Three roles, builder, planner and harness editor, chosen per session. A role
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
  it off. Both name a token's environment variable and never hold the
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
- `nh usage [--days N]` prints what was spent per day, folder, session, model,
  agent and phase, with the throughput each of them ran at. It is the same
  report the window draws, built once in core, so the terminal and the window
  cannot disagree about a figure.
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
- A finished tool call is marked with a check or a cross where it used to say
  `done` or `failed`. A running one still says so.
- Every turn ends on a summary line under the answer: the tool calls it took and
  how many failed, the files `edit` and `write` left different, and how long it
  ran. The line is stored with the transcript, so a re-opened session still
  shows what each turn cost.
- Nothing is drawn by the browser: the app has its own confirm and prompt
  sheets, and styles the native select popups through `appearance: base-select`.
- Three layers of design tokens, a raw ramp, aliases naming what a colour is
  for, and components that read only aliases, with one easing curve, three
  durations, and a single spacing and radius vocabulary. Dark only.
- The brand mark is the window icon, the app icon, and the empty state.
- The card a `spawn` leaves in the flow says what the subagent did without
  being opened: the role and mode it ran as, how many tool calls it took, how
  many worked, how long it ran and what it cost. It is the line a turn ends on,
  written once and read back by the window, and it is drawn under the card in
  that same line, and not as a second row inside the card's head.
- A spend view, opened from the sidebar foot or from the session's own usage
  line: what was spent over the window, a bar per day with the cache hit rate
  drawn over it, and the same money broken down by folder, session, model,
  agent and by which part of the harness spent it. The chart puts cost and hit
  rate together because a day the bars jump while the line drops is a prompt
  prefix that stopped matching. **Clear** deletes the log after asking, and
  takes all of it, and not the range on screen.
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
- A session runs in its folder, and not in whatever directory Electron was
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
  red, and never as a successful call.
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
  session, or deny. A gate with nobody to ask refuses the command instead of
  running it unscreened.
- A refusal no longer says "you denied access to it". A closed window produces
  the same refusal, and the old wording sent agents hunting for another route to
  the same place, one modal per attempt.
- A background job still running when the app closes is written into the
  conversation that started it, instead of disappearing with the process while
  the last message promises its report.
- Which failures are worth retrying is decided by rule and not by a list of
  status codes. Every 5xx is retried, along with the three 4xx that mean "not
  now": 408, 425 and 429. The list it replaces named nine numbers and stopped
  at 529, so a gateway answering in numbers of its own, such as Cloudflare's 520
  to 527, was read as a malformed request and the turn gave up on the first
  attempt.
  409 is no longer retried: a conflict with the server's state is not resolved
  by sending the same request again.
- A broken stream is recognised by its type and not by its message text. A
  body that never arrived used to be thrown carrying the 2xx status of the
  response whose headers were fine, and was only retried because a string
  comparison caught it first, so rewording that sentence would have turned the
  retry off with nothing to show for it. A connection that never delivered a response is now read
  from the error code in its `cause` chain instead of from the words "fetch
  failed", so an expired certificate fails once instead of five times.
- The approval model's ladder pins the endpoint that answered, not the model
  name. The same model id offered by two providers matched both rungs, which
  left the ladder in its configured order and sent every question back through
  the endpoint that had already failed.
- One backoff for the whole app. The judge's retries were a second, simpler
  copy that ignored `Retry-After` and had no jitter, so a rate-limited approval
  waited 400ms where the session would have waited as long as the provider
  asked.
- A shell command takes about 0.45s instead of about 3.5s. The shell was started
  with `-l` every time, on the stated grounds that this was what put `grep`,
  `sed` and `curl` on PATH, which was never true; Git Bash prepends those
  either way. What `-l` genuinely adds is the profile's own PATH, so that is
  read once per run and handed to every command after, and nothing is lost.
  Seven eighths of the time an agent spent in the shell was one profile being
  sourced several hundred times. The read is started when the app starts and
  nothing ever waits on it: a command that arrives first runs the old way, and
  so does every command if the read fails outright.
- Closing an MCP server waits for the process to be gone on both attempts, not
  just the first. The escalation path sent the second kill and returned
  immediately, so a `close` that had to escalate reported a stopped server while
  it was still running, the one thing that function's own documentation
  promised could not happen, and the directory it was started in could not be
  deleted afterwards. Delivering the kill and waiting for the child are also
  counted apart now. On Windows the kill is a `taskkill` walking the process
  tree, three seconds on an idle machine, and charging that to the child's
  grace period declared a process that was already dying too stubborn to kill.
- `pnpm test` passes on a clean Windows checkout. Tests that spawn real
  subprocesses were failing on Vitest's 5s default, and one of them measured the
  handshake deadline with a 5s wall-clock threshold that the spawn and the
  teardown could exceed on their own. A process launch on Windows is a few
  hundred milliseconds before anything runs, which the old threshold did not
  allow for.
