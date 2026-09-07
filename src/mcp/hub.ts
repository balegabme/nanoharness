// doc: docs/harness/mcp.md
import { McpClient } from './client.js'
import { HttpTransport, StdioTransport } from './transport.js'
import { loadServers } from './config.js'
import { narrowInputSchema, toolName } from './schema.js'
import { McpProtocolError } from './protocol.js'
import type { McpServer } from './config.js'
import type { Tool } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

/**
 * Every MCP server a session talks to, and the tools they add to it.
 *
 * The hub is built once per session and connects every configured server up
 * front, because the tool definitions have to be in the first request of the
 * first turn — a tool discovered later would change the bytes in front of the
 * conversation and cost the whole prompt cache.
 *
 * A server that will not start is not an error. It contributes no tools, its
 * reason is recorded in `status` and logged, and the session runs without it: a
 * broken search server must not be the reason a coding session cannot open.
 */

export interface ServerStatus {
  name: string
  connected: boolean
  toolCount: number
  /** Why it is not connected, in the words the user needs to fix it. */
  error?: string
}

export class McpHub {
  private constructor(
    private readonly clients: McpClient[],
    private readonly built: Tool[],
    readonly status: ServerStatus[],
  ) {}

  static async connect(cwd: string, servers?: readonly McpServer[]): Promise<McpHub> {
    const loaded = servers === undefined ? await loadServers(cwd) : { servers, problems: [] }
    const list = loaded.servers
    const clients: McpClient[] = []
    const tools: Tool[] = []
    const status: ServerStatus[] = []
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
        status.push({ name: server.name, connected: true, toolCount: listed.length })
      } catch (err) {
        await client?.close().catch(() => undefined)
        status.push({ name: server.name, connected: false, toolCount: 0, error: reason(err) })
      }
    }

    return new McpHub(clients, tools, status)
  }

  tools(): Tool[] {
    return [...this.built]
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map(client => client.close().catch(() => undefined)))
  }
}

/**
 * What the agent is told about MCP, in the system prompt.
 *
 * It is there for two reasons. A model asked what tools it has will otherwise
 * answer from its training set — inventing a rule that forbids what it was
 * never told about is the failure this block exists to stop — and a model asked
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
  options: { canWrite: boolean; canSpawn: boolean; root: string; cli?: string },
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
    'Both use the shape every MCP client uses: {"mcpServers": {"<name>": {...}}}. A stdio entry has command, args and envPassthrough (variable names, passed through from the environment); an HTTP entry has url and tokenEnv (the variable holding the bearer token). A token is never written in the file.',
  )
  // Who is being told this decides what they are told. An agent that can spawn
  // is not the one who edits the config — that is the harness-editor's job, and
  // handing this agent the command alongside a rule telling it to delegate is
  // how one ended up doing the work itself and arguing with its own prompt on
  // the way. It gets the handoff. The editor gets the commands.
  if (options.canSpawn) {
    lines.push(
      'Adding, removing or switching off a server edits one of those files, which is harness work: spawn a harness-editor (mode distinct) and say which server, which file, and what the user gave you. It has the commands; you do not run them. It is configuration, not an install.',
    )
    return lines
  }

  if (!options.canWrite) return lines

  if (options.cli === undefined) {
    lines.push('Adding a server is writing one of those files, which you can do when asked.')
    return lines
  }

  lines.push(
    'Adding a server is one command, not a hand-written file. It is configuration, not an install:',
    `  ${options.cli} mcp add <name> --url <url> [--token-env VAR] --global      an HTTP server, for every workspace`,
    `  ${options.cli} mcp add <name> --command <cmd> [--arg A] [--env VAR] --dir ${options.root}      a stdio server, for this workspace only`,
    `  ${options.cli} mcp list --dir ${options.root}      what is configured, in both files`,
    `  ${options.cli} mcp check <name> --dir ${options.root}      connect for real and report what happened`,
    `  ${options.cli} mcp remove <name> [--global] --dir ${options.root}      take one entry out; the file stays`,
    `Without \`--global\` the target is the workspace file, and \`--dir\` says which workspace — pass it, because your own folder may not be the one the user meant. \`${options.cli} mcp --help\` prints this list.`,
    "The command parses and writes the entry with the harness's own code, so a hand-written JSON file and a hand-written script to check it are both work you do not have to do. An entry it refuses is one a session would have ignored.",
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
