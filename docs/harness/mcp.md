# MCP client

Tools that are not the harness's own. A session connects to the servers its
workspace configures, and their tools sit in the same list as `read` and `bash`.
The model cannot tell which is which, and does not need to. Plan §7.

Files:
- src/mcp/protocol.ts — JSON-RPC envelopes, protocol versions, the error kinds
- src/mcp/transport.ts — stdio and Streamable HTTP
- src/mcp/client.ts — the handshake, the catalog, and calls
- src/mcp/schema.ts — MCP JSON Schema narrowed to what a provider takes
- src/mcp/config.ts — the two `mcp.json` files, and what an entry may hold
- src/mcp/hub.ts — every server a session talks to, as harness tools

## What is implemented

Tools, and nothing else. `resources/*` and `prompts/*` are v2: a harness that
already reads files does not need a second way to read files, and every method
implemented is bytes in a tool list somebody pays for.

The lifecycle is the spec's. `initialize` is the first message on the wire and
is never batched with anything else; the client offers the newest version it
knows and takes the server's answer, or disconnects if that answer is a version
it cannot speak. Then `notifications/initialized`, and the session is open.

`tools/list` is followed to the end of its cursor once, when the hub connects,
and the result is what the session's tool definitions are built from. It is not
re-listed mid-session, and that is a decision rather than an omission: the
definitions sit in the cached prefix of every request, so a catalog that grew a
tool halfway through a conversation would move bytes the provider has already
cached and cost the whole prefix, to add a tool the model was not going to be
told about anyway. A `notifications/tools/list_changed` drops the client's
cached copy, so the next thing to ask for the catalog gets the new one; in
practice that is the next session, built the next time the hub is.

## Two kinds of failure, and why they are never merged

This is the whole reason the layer exists.

A protocol error, meaning a `-32700` through `-32603`, a malformed envelope or
an unknown method, is a bug in this client or that server. The model never sees
one, because there is nothing it could do with it. It comes back as a harness
failure that says so in as many words, and it is not retried: the same request
would fail the same way.

A tool-domain failure is a perfectly valid result with `isError: true`: the
search found nothing, the path does not exist, the API key was refused. That is
the model's to read and correct, so it goes back verbatim.

Merging the two gives you either a model apologising for a JSON-RPC framing bug
or a harness swallowing the one message that would have let the model fix its
own call.

## Timeouts and cancellation

Every request carries a client-side deadline: 60s for a call, 15s for the
handshake. The handshake gets the shorter one because it is the request a person
is waiting behind. The hub connects before the session exists, so a server that
spawns and never answers holds up the user's first message for the whole of it.

On expiry the client drops the request from its pending table, sends
`notifications/cancelled` for that id, and rejects locally with a timeout error
distinct from a dropped connection. A late answer then arrives to find nothing
waiting for it and is discarded, which is what the spec asks of whoever sent the
cancellation. `initialize` is the one request that is never cancelled: the spec
forbids it, and a server that has not finished the handshake has no session in
which to read the notification.

Cancellation is advisory in MCP, and the server may finish the work anyway. The
point is that this side stops waiting, not that the work stops.

A handshake that fails for any reason closes its transport before the error is
rethrown. The only reference to a spawned server is the client that failed to
open it, so a rejection that skipped this would leave a subprocess running with
nothing left in the app that could stop it.

## Transports

stdio spawns the server and speaks newline-delimited JSON on its pipes.
`stderr` is drained and ignored: these servers log there on a healthy start, and
reading it as an error signal is the standard way to declare a working server
broken. The drain matters too, because an unread pipe fills and blocks the
child.

On Windows, `npx` is `npx.cmd`, a batch script, and `spawn()` does not go
through a shell, so spawning it by name fails with `ENOENT` on the one platform
where it looks like it should work. Script-shaped launchers are wrapped in
`cmd /c`; `uvx` and absolute paths are not, because they do not need it. Every
child gets `windowsHide` so nothing flashes a console window.

A spawn error arrives a tick late, so a command that does not exist looks alive
for a moment. The transport waits that moment out before reporting success,
which turns "connected, then every call times out" into the error it is.

A `close` waits for the child to exit rather than sending a signal and moving
on, so "the hub is closed" means the process has ended. On Windows it also has
to take the whole tree: `cmd /c npx …` makes the launcher the child this owns
and the server its grandchild, so killing the child alone would leave the server
running with its parent gone. `taskkill /T` is what handles that.

Streamable HTTP posts to one endpoint with
`Accept: application/json, text/event-stream` and reads whichever the server
answered with. A tools-only client never needs the standalone GET stream: every
message it cares about is the answer to something it asked. `Mcp-Session-Id` is
echoed back on every later request, along with the `MCP-Protocol-Version` the
handshake settled on, because a server that receives no version header is
entitled to assume an older protocol and answer in a shape this client stopped
expecting.

A 404 on a session the server has forgotten closes the transport rather than
being retried into the void. It is deliberately not re-initialized underneath a
running conversation: the tool definitions are already in the cached prefix, so
a silent reconnect that came back with a different catalog would be worse than
the error.

The bearer token goes in the `Authorization` header. Never the query string,
because URLs end up in logs, proxies and error reports.

## Schema narrowing

An MCP server publishes whole JSON Schema. The harness passes providers a
subset. `$ref`, `oneOf`, `format`, `const` and a dozen other keywords are legal
in an `inputSchema`, mean nothing in a tool definition, and some are rejected
outright by OpenAI's strict mode. So a schema is narrowed rather than forwarded:
shape, names, types, descriptions and enums survive, because they are what a
model needs to fill the arguments in. A union type becomes its first non-null
member, since an argument that may also be null is still, to the model typing
it, a string, and `integer` becomes `number`, which is the only thing the
provider layer knows.

A node with no usable `type` becomes a string rather than disappearing. `anyOf`,
`oneOf` and `$ref` are ordinary in a published `inputSchema` and none of them
carry a type, so dropping such a node would take a *required* argument out of
the tool definition: the model could never supply it and every call would come
back `-32602` with nothing to say why. A string the server rejects is a failure
the model can read and correct; a missing argument is not.

## Naming

`mcp__<server>__<tool>`. The prefix keeps a server's `search` from colliding
with a built-in tool and keeps two servers' `search` apart. It is derived from
the configured server name rather than generated, so the tool definitions, which
sit in front of every message, are the same bytes on every request and the
provider's cache keeps answering them.

Both providers refuse a name longer than 64 characters, and that refusal is not
one bad tool: the name sits in the definitions block, so every request of the
session would be a 400. A long server name plus a long tool name is therefore
trimmed and given a short digest of the full name: inside the cap, still unique,
and derived rather than counted, so it is the same bytes every time.

## Configuration

Two files, both in the shape every MCP client uses:

- `~/.nanoharness/mcp.json`: every workspace on this machine.
- `.nanoharness/mcp.json`: this workspace only.

```json
{
  "mcpServers": {
    "search": { "command": "npx", "args": ["-y", "tavily-mcp@latest"], "envPassthrough": ["TAVILY_API_KEY"] },
    "internal": { "url": "https://mcp.example.com/mcp", "tokenEnv": "EXAMPLE_TOKEN" }
  }
}
```

Both layers exist because both answers are right. A search server with one API
key is the same server in every project, and configuring it once is what a home
directory is for; a server that reaches this project's issue tracker belongs to
this project and nowhere else.

A name in the project file replaces the global entry outright rather than
merging field by field, since a half-overridden command line is a server nobody
configured, and `"enabled": false` is how a project switches a global server off
without editing the file every other workspace reads.

Secret-free by schema (plan §16) as far as the schema reaches: a *bearer* token
is named, never written. There is no field one could land in. stdio servers get
named variables passed through from the harness's environment; HTTP servers get
a bearer token read from the variable `tokenEnv` names.

`url` is the exception, and it is not a small one. A server that authenticates
through its own query string, and Tavily is one, has nowhere else to put the
key, so the URL is stored as given and the file holds a live credential. A
`{{secret:name}}` written into that URL is substituted by the harness as the
command runs, which means `nh mcp add` with a placeholder still writes the real
value to disk: the placeholder keeps the key out of the transcript, not out of
the file. A `cat` of that file inside a session prints the placeholder back,
because tool output is redacted on the way in, which reads exactly like a file
that stored the placeholder, and is not. A config with a `url` is therefore not
automatically safe to paste into an issue.

Nothing is configured by default. Not even a search server: a harness that
arrives with servers the user did not ask for is spawning subprocesses on their
machine on its own authority, and the tool definitions it adds are paid for on
every request of every turn. `examples/mcp.json` is a working file to copy.

Neither file has to be hand-written. `nh mcp add`, `list`, `remove` and `check`
write and read them through the same `parseServer` and the same client a session
uses, so an entry the harness would ignore is refused at the command rather than
sitting in the file looking configured, and `check` proves a server connects by
connecting to it. `cli.md` has the flags.

## What the agent is told

The system prompt carries the servers this session actually connected to and
the two file paths. Everyone gets that much: it is what "what tools do you
have" needs, and it is not a licence to edit anything.

The shape of an entry goes only to the harness-editor. An agent that
delegates does the only thing it can with the fields, which is to write `url`,
`tokenEnv` and "a token is never written in the file" into the task as a
requirement. The server in question authenticates through its own URL, so none
of it applied, and one subagent spent fifteen rounds settling a contradiction
its parent had handed it out of its own prompt. Schema an agent cannot check
against the actual server is schema it will relay.

The sentence about tokens is scoped for the same reason. A bearer token is named
and not written, which is what `tokenEnv` is for; a URL that carries its own key
is stored as given, key and all, and the prompt says so rather than promising
otherwise.

What comes after it depends on who is reading. An agent that can spawn is given
no command at all; the handoff rule is added to its session prompt, and this
block says only what a change touches. The harness-editor, which cannot spawn,
is given the commands, with `--dir <the workspace>` already in them, because its
own folder may not be the workspace the user meant. A prompt that holds both a
command and a rule to delegate is settled by whichever half the model reads
last, and a builder given both ran the command itself, so only one half is sent.

The commands are written out with their flags rather than named, because a
command an agent is never told about might as well not exist. `cli.md` has the
turn that made that concrete.

That block is there because of two failures, both observed. A model asked what
tools it has answers from its training set when the prompt says nothing. And one
asked to add an MCP server invented a policy forbidding it, reading the prompt's
"do not install anything" as covering a JSON file in the workspace. A server is
configuration, not an install, and the MCP block says so in as many words to the
one role that does the configuring.

The block also says what the agent cannot do: a server added during a turn is
connected the next time the session is built, not inside that turn. The tool
definitions sit in the cached prefix, so a tool list that grew mid-conversation
would cost the whole prefix. See the lifetime section below.

## Lifetime

One hub per session, connected before the first request, because the tool
definitions have to be in front of the first turn and a tool discovered later
would move bytes the provider has already cached. Servers are connected one
after another rather than all at once: an `npx -y` on a cold cache downloads a
package, and four of those at once on a laptop is worse than four in a row.

A server that will not start is not an error. It contributes no tools, its
reason is kept in the hub's status and logged, and the session runs without it:
a broken search server must not be the reason a coding session cannot open. An
`mcp.json` that will not parse is reported the same way, under the file's own
name, because starting silently with no MCP tools after a stray comma looks
exactly like a harness that never supported them.

A server that fails *after* it started, with a catalog that errors or a
handshake that times out, is closed on the way out of that failure, because a
client that never reached the hub's list is a client nothing else will ever
close.

Retiring a session closes its hub, and so does quitting. A hub owns
subprocesses and sockets, so a settings save that dropped sessions without
closing hubs would be a process pile-up nobody sees until the machine slows
down.

A distinct subagent reaches the same servers as the session that spawned it,
the session's own connections, so nothing is spawned twice and nothing has to be
torn down when the subagent finishes.
