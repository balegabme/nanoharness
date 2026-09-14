// doc: docs/harness/mcp.md
import { McpClient } from './client.js'
import { HttpTransport, StdioTransport } from './transport.js'
import { loadServers } from './config.js'
import { narrowInputSchema, toolName } from './schema.js'
import { McpProtocolError } from './protocol.js'
import type { McpCallResult } from './client.js'
import type { McpServer } from './config.js'
import type { Tool } from '../core/session.js'
import type { McpServerStatus, ToolResult } from '../core/types.js'

/**
 * Every MCP server a session talks to, and the tools they add to it.
 *
 * The hub is built once per session and connects every configured server up
 * front, because the tool definitions have to be in the first request of the
 * first turn: a tool discovered later would change the bytes in front of the
 * conversation and cost the whole prompt cache.
 *
 * A server that will not start is not an error. It contributes no tools, its
 * reason is recorded in `status` and logged, and the session runs without it: a
 * broken search server must not be the reason a coding session cannot open.
 */

/**
 * One server's state. The shape lives in `core/types.ts` because an event
 * carries it to the window; this is the name the MCP layer knows it by.
 */
export type ServerStatus = McpServerStatus

export class McpHub {
  private constructor(
    private readonly clients: McpClient[],
    private readonly built: Tool[],
    readonly status: ServerStatus[],
    private readonly byServer: Map<string, McpClient>,
  ) {}

  static async connect(cwd: string, servers?: readonly McpServer[]): Promise<McpHub> {
    const loaded = servers === undefined ? await loadServers(cwd) : { servers, problems: [] }
    const list = loaded.servers
    const clients: McpClient[] = []
    const tools: Tool[] = []
    const status: ServerStatus[] = []
    const byServer = new Map<string, McpClient>()
    // An unreadable config is reported the same way an unreachable server is,
    // so whatever shows status has one list to show and nothing to special-case.
    for (const problem of loaded.problems) status.push({ name: 'mcp.json', connected: false, toolCount: 0, error: problem })

    // Sequential on purpose: an `npx -y` on a cold cache downloads a package,
    // and four of those at once on a laptop is worse than four in a row.
    for (const server of list) {
      // Held outside the `try` so a failure *after* the server started still has
      // something to close. Without it, a server that connects and then fails
      // its catalog leaves a subprocess running for the life of the app: the
      // client never reaches `clients`, so `close()` never sees it.
      let client: McpClient | null = null
      try {
        client = await open(server, cwd)
        const listed = await client.listTools()
        for (const tool of listed) tools.push(wrap(server.name, tool.name, tool.description, tool.inputSchema, client))
        clients.push(client)
        byServer.set(server.name, client)
        status.push({ name: server.name, connected: true, toolCount: listed.length })
      } catch (err) {
        await client?.close().catch(() => undefined)
        status.push({ name: server.name, connected: false, toolCount: 0, error: reason(err) })
      }
    }

    return new McpHub(clients, tools, status, byServer)
  }

  tools(): Tool[] {
    return [...this.built]
  }

  /**
   * One real call to one server, for `nh mcp check`. A handshake is not proof
   * of a credential: a server that takes its key in the URL answers
   * `initialize` and `tools/list` to anyone and only refuses at the call, so
   * "connected" alone would report a broken key as working. The catalog comes
   * back with it, because the caller has to name a tool it actually has.
   */
  async probe(server: string, tool: string, args: Record<string, unknown>): Promise<{ result?: McpCallResult; tools: string[] }> {
    const client = this.byServer.get(server)
    if (client === undefined) return { tools: [] }
    const listed = (await client.listTools()).map(entry => entry.name)
    if (!listed.includes(tool)) return { tools: listed }
    return { result: await client.callTool(tool, args), tools: listed }
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map(client => client.close().catch(() => undefined)))
  }
}

/**
 * What the agent is told about MCP, in the system prompt.
 *
 * It is there for two reasons. A model asked what tools it has will otherwise
 * answer from its training set, and inventing a rule that forbids what it was
 * never told about is the failure this block exists to stop. A model asked
 * to *add* a server can only do it if it knows the file, its shape and where it
 * lives. Both are a handful of lines, and they are the difference between "I
 * cannot install MCP servers" and a written config.
 *
 * The connected servers are listed by name rather than by tool: the tools are
 * already in the tool definitions, and repeating them here would be paying
 * twice for the same list.
 */
export function mcpBlock(
  status: readonly ServerStatus[],
  paths: { global: string; project: string },
  options: { canSpawn: boolean; canConfigure: boolean; root: string; cli?: string },
): string[] {
  const connected = status.filter(server => server.connected)
  const broken = status.filter(server => !server.connected)
  const lines = ['']
  lines.push(
    connected.length === 0
      ? 'MCP servers connected to this session: none. Nothing is configured by default.'
      : `MCP servers connected to this session: ${connected.map(server => `${server.name} (${server.toolCount} tools)`).join(', ')}.`,
  )
  for (const server of broken) lines.push(`${server.name} is configured but not connected: ${server.error ?? 'unknown reason'}.`)
  lines.push(
    `They are configured in two files: ${paths.global} for every workspace and ${paths.project} for this one, where a name in the project file wins.`,
  )
  // Who is being told this decides what they are told. A spawn-capable agent
  // gets no commands: the handoff rule in its session prompt routes harness work
  // to a harness-editor, and a command here would argue with it. The entry shape
  // and the commands go only to the configurer, which is the editor. A
  // spawn-capable agent given the fields does the only thing it can with them,
  // which is to write url, tokenEnv and "a token is never written in the file"
  // into the task as a requirement, for an endpoint whose key goes in the query
  // string, where none of it was true. Schema it cannot check against the server
  // is schema it will relay. A child that is not the configurer gets the facts
  // and nothing to relay.
  if (options.canSpawn) {
    lines.push(
      'Adding, removing or switching off a server edits one of those files. It is configuration, not an install.',
    )
    return lines
  }

  if (!options.canConfigure) return lines

  lines.push(
    'Both files use the shape every MCP client uses: {"mcpServers": {"<name>": {...}}}. A stdio entry has command, args and envPassthrough (variable names, passed through from the environment); an HTTP entry has url and, where the server takes a bearer token, tokenEnv, the name of the variable holding it, so that token is named rather than written. A server that authenticates through its own URL instead is a different case: the placeholder is substituted before the writer runs, so that URL is stored with the real credential in it.',
  )

  if (options.cli === undefined) {
    lines.push('Adding a server is writing one of those files, which you can do when asked.')
    return lines
  }

  lines.push(
    'Adding a server is one command. It is configuration, not an install:',
    `  ${options.cli} mcp add <name> --url <url> [--token-env VAR] --global      an HTTP server, for every workspace`,
    `  ${options.cli} mcp add <name> --command <cmd> [--arg A] [--env VAR] --dir ${options.root}      a stdio server, for this workspace only`,
    `  ${options.cli} mcp list --dir ${options.root}      what is configured, in both files`,
    `  ${options.cli} mcp check <name> --dir ${options.root}      connect for real and report what happened`,
    `  ${options.cli} mcp remove <name> [--global] --dir ${options.root}      take one entry out; the file stays`,
    `Without \`--global\` the target is the workspace file, and \`--dir\` says which workspace. Pass it, because your own folder may not be the one the user meant. \`${options.cli} mcp --help\` prints this list.`,
    'An entry the command refuses is one a session would have ignored.',
    'The new server is connected the next time a session is built, not inside this turn, and the user needs to be told that.',
  )
  return lines
}

async function open(server: McpServer, cwd: string): Promise<McpClient> {
  if (server.transport === 'http') {
    const token = server.tokenEnv === undefined ? undefined : process.env[server.tokenEnv]
    if (server.tokenEnv !== undefined && token === undefined) {
      throw new Error(`${server.tokenEnv} is not set, and ${server.name} needs it`)
    }
    const client = new McpClient(new HttpTransport({ url: server.url, token }))
    await client.connect()
    return client
  }

  const env: Record<string, string> = {}
  for (const name of server.envPassthrough) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const client = new McpClient(new StdioTransport({ command: server.command, args: server.args, cwd, env }))
  await client.connect()
  return client
}

/**
 * One MCP tool as a harness tool. The two error kinds stay apart here, which is
 * the whole point of the layer: a `-32602` is this client sending the server
 * something malformed and the model can do nothing with it, so it is reported
 * as a harness failure; an `isError` result is the server telling the model
 * that the search found nothing, and it goes back verbatim for the model to act
 * on.
 */
function wrap(server: string, tool: string, description: string, schema: Record<string, unknown>, client: McpClient): Tool {
  const name = toolName(server, tool)
  return {
    input: { name, description, inputSchema: narrowInputSchema(schema) },
    async run(args): Promise<ToolResult> {
      try {
        const result = await client.callTool(tool, args)
        const text = result.text
        return {
          ok: !result.isError,
          summary: text.length > 200 ? `${text.slice(0, 199)}…` : text,
          content: text,
          ...(result.isError ? { isError: true } : {}),
        }
      } catch (err) {
        const note =
          err instanceof McpProtocolError
            ? `${name} could not be called: ${err.message} (this is a harness or server bug, not something to retry)`
            : `${name} failed: ${reason(err)}`
        return { ok: false, summary: note, content: note, isError: true }
      }
    },
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
