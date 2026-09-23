# Examples

Configuration you can copy into a workspace's `.nanoharness/` folder. Nothing
here holds a secret, and nothing here can: the formats name environment
variables and never carry values.

## `mcp.json`

Copy to `~/.nanoharness/mcp.json` for every workspace, or to a project's
`.nanoharness/mcp.json` for that one alone. A name in the project file replaces
the global entry, and `"enabled": false` switches one off. Two servers here, one
of each kind:

- `tavily`: web search and fetch, spawned over stdio. It reads
  `TAVILY_API_KEY` from the environment, and it is the stdio server and not
  Tavily's hosted URL because that URL carries the key in the query string.
- `internal-docs`: a remote server over Streamable HTTP, with its bearer
  token read from `EXAMPLE_MCP_TOKEN`. Shipped `"enabled": false`, because a
  server that cannot authenticate costs a handshake to end up refusing.

No server is configured by default, so this file is the whole of what a session
connects to. The agent can write it for you: ask for a server by name and it
knows the shape and the paths.

`docs/harness/mcp.md` has the rest of the format.

## `hooks.json`

Copy to `~/.nanoharness/hooks.json` for every workspace, or to a project's
`.nanoharness/hooks.json` for that one alone. Both files run, the global one
first. A project's file runs only after you have read and approved it in the
window, and an edit to it asks again. The Run hooks switch in Settings, under
General, turns every hook off.

Each hook is a bash command, run from the workspace root with the event as JSON
on stdin. Exit 2 from a `PreToolUse` hook refuses the call, and from a `Stop`
hook refuses the answer, with stderr as the reason. Anything a hook prints on a
clean exit reaches the agent. Four hooks here, one per event:

- `SessionStart` runs `nh doc-check` and says nothing unless the doc map is
  broken, in which case the problems go into the system prompt.
- `PreToolUse` refuses any shell command that commits or pushes. `match` is a
  pattern on the tool name, matched whole.
- `PostToolUse` runs the type checker after every write or edit and hands the
  agent the first errors.
- `Stop` runs the tests when the agent says it is done, and sends it back to
  work with the failures while they fail. Once it has sent the agent back
  three times in one turn, the next refusal lets the turn end, with a note.

`timeout` is in seconds and defaults to 60. `docs/harness/hooks.md` has the
rest of the format, including the JSON a hook can print in place of plain text.

## `skills/`

Copy a folder to `.nanoharness/skills/`. A skill is a folder with a `SKILL.md`
whose frontmatter carries `name` and `description`. Only those two lines reach
the system prompt; the agent reads the file itself when a task matches.

`skills/release-checklist/` is a worked example. `docs/harness/skills.md` has
the format.
