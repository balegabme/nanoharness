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

## `skills/`

Copy a folder to `.nanoharness/skills/`. A skill is a folder with a `SKILL.md`
whose frontmatter carries `name` and `description`. Only those two lines reach
the system prompt; the agent reads the file itself when a task matches.

`skills/release-checklist/` is a worked example. `docs/harness/skills.md` has
the format.
