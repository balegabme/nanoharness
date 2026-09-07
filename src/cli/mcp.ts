// doc: docs/harness/cli.md
import { loadServers, mcpPaths, parseServer, readEntries, removeEntry, writeEntry } from '../mcp/config.js'
import { McpHub } from '../mcp/hub.js'
import type { McpServer } from '../mcp/config.js'

/** `nh mcp` — manage MCP servers. */

export const MCP_HELP = `nh mcp — the MCP servers this harness will connect to

  nh mcp list [--json]              what is configured, in both files
  nh mcp add <name> --command <cmd> [--arg A]... [--env VAR]... [-- args...]
  nh mcp add <name> --url <url> [--token-env VAR]
  nh mcp remove <name>              take one entry out (the file stays)
  nh mcp check [name]               actually connect, and say what happened

  --global   the file every workspace reads (~/.nanoharness/mcp.json)
             default is this folder's own .nanoharness/mcp.json
  --disabled write the entry switched off
  --dir DIR  treat DIR as the workspace instead of the current folder

A token is never written to the file: --env and --token-env name an
environment variable, and the harness reads it at connect time.
`

/**
 * A command typed wrong, as opposed to a command that ran and failed. It is its
 * own kind because the answer to it is the help text: an agent that guessed
 * `mcp add --help` and got `unknown flag --help` went on guessing for two more
 * calls, which is the round trip this CLI exists to save.
 */
class UsageError extends Error {}

interface Flags {
  global: boolean
  disabled: boolean
  json: boolean
  dir: string
  command?: string
  url?: string
  tokenEnv?: string
  args: string[]
  env: string[]
  rest: string[]
}

/** Long flags only, because a config command is typed once and read later. */
export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { global: false, disabled: false, json: false, dir: process.cwd(), args: [], env: [], rest: [] }
  const wants = (name: string, value: string | undefined): string => {
    if (value === undefined) throw new UsageError(`${name} needs a value`)
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    // Everything after a bare `--` is the server's own argument list, which is
    // the only way to pass one that starts with a dash.
    if (token === '--') {
      flags.rest.push(...argv.slice(i + 1))
      break
    }
    switch (token) {
      case '--global':
        flags.global = true
        break
      case '--project':
        flags.global = false
        break
      case '--disabled':
        flags.disabled = true
        break
      case '--json':
        flags.json = true
        break
      case '--dir':
        flags.dir = wants(token, argv[++i])
        break
      case '--command':
        flags.command = wants(token, argv[++i])
        break
      case '--url':
        flags.url = wants(token, argv[++i])
        break
      case '--token-env':
        flags.tokenEnv = wants(token, argv[++i])
        break
      case '--arg':
        flags.args.push(wants(token, argv[++i]))
        break
      case '--env':
        flags.env.push(wants(token, argv[++i]))
        break
      default:
        if (token.startsWith('--')) throw new UsageError(`unknown flag ${token}`)
        flags.rest.push(token)
    }
  }
  return flags
}

export async function runMcp(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  // `--help` means help wherever it appears, whichever subcommand it is sitting
  // behind. The alternative is a flag error on the one call whose whole purpose
  // was to ask what the flags are — which is two more calls of guessing.
  if (command === undefined || argv.some(token => token === '--help' || token === '-h')) {
    process.stdout.write(MCP_HELP)
    return 0
  }

  try {
    const flags = parseFlags(rest)
    const paths = mcpPaths(flags.dir)
    const path = flags.global ? paths.global : paths.project

    switch (command) {
      case 'list':
        return await list(flags, paths)
      case 'add':
        return await add(flags, path)
      case 'remove':
        return await remove(flags, path)
      case 'check':
        return await check(flags)
      default:
        process.stderr.write(`nh mcp: unknown command "${command}"\n${MCP_HELP}`)
        return 2
    }
  } catch (err) {
    // A wrong command line is answered with the right one. Anything else — an
    // unreadable file, a server that threw — is a real failure and is left to
    // the caller rather than dressed up as a typo.
    if (!(err instanceof UsageError)) throw err
    process.stderr.write(`nh mcp: ${err.message}\n${MCP_HELP}`)
    return 2
  }
}

function describe(server: McpServer): string {
  const off = server.enabled ? '' : ' (disabled)'
  if (server.transport === 'http') {
    return `${server.name}  http  ${server.url}${server.tokenEnv === undefined ? '' : `  token: $${server.tokenEnv}`}${off}`
  }
  const env = server.envPassthrough.length === 0 ? '' : `  env: ${server.envPassthrough.map(name => `$${name}`).join(' ')}`
  return `${server.name}  stdio  ${[server.command, ...server.args].join(' ')}${env}${off}`
}

async function list(flags: Flags, paths: { global: string; project: string }): Promise<number> {
  const loaded = await loadServers(flags.dir)
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ paths, ...loaded }, null, 2)}\n`)
    return loaded.problems.length === 0 ? 0 : 1
  }

  for (const [label, path] of [
    ['global ', paths.global],
    ['project', paths.project],
  ] as const) {
    const entries = await readEntries(path).catch(() => null)
    process.stdout.write(`${label}  ${path}${entries === null ? '  (unreadable)' : ''}\n`)
    for (const [name, value] of Object.entries(entries ?? {})) {
      const parsed = parseOne(name, value)
      process.stdout.write(`  ${parsed}\n`)
    }
  }

  // What a session would actually connect to, which is not the two lists added
  // up: a project entry replaces the global one under the same name.
  process.stdout.write(loaded.servers.length === 0 ? '\nthis workspace connects to nothing\n' : '\nthis workspace connects to:\n')
  for (const server of loaded.servers) process.stdout.write(`  ${describe(server)}\n`)
  for (const problem of loaded.problems) process.stderr.write(`nh mcp: ${problem}\n`)
  return loaded.problems.length === 0 ? 0 : 1
}

/**
 * One entry as configured, or the reason the harness will ignore it — read with
 * the same `parseServer` a session uses, so the listing cannot flatter a file
 * the harness would throw away.
 */
function parseOne(name: string, value: unknown): string {
  const server = parseServer(name, value)
  return server === null ? `${name}  ignored: no command and no url` : describe(server)
}

async function add(flags: Flags, path: string): Promise<number> {
  const name = flags.rest[0]
  if (name === undefined) throw new UsageError('add needs a name: nh mcp add <name> --command … | --url …')
  if (flags.command === undefined && flags.url === undefined) throw new UsageError('add needs --command (stdio) or --url (http)')

  const entry: Record<string, unknown> =
    flags.url === undefined
      ? { command: flags.command, args: [...flags.args, ...flags.rest.slice(1)], envPassthrough: flags.env }
      : { url: flags.url, ...(flags.tokenEnv === undefined ? {} : { tokenEnv: flags.tokenEnv }) }
  if (flags.disabled) entry.enabled = false

  const server = await writeEntry(path, name, entry)
  process.stdout.write(`wrote ${path}\n  ${describe(server)}\n`)
  process.stdout.write('a session connects to it the next time it is built: restart the app, or open a new session.\n')
  return 0
}

async function remove(flags: Flags, path: string): Promise<number> {
  const name = flags.rest[0]
  if (name === undefined) throw new UsageError('remove needs a name')
  // The entry goes; the file and the folder stay. Removing the container a
  // thing lived in is not what "remove this server" asked for.
  const gone = await removeEntry(path, name)
  process.stdout.write(gone ? `removed ${name} from ${path}\n` : `${name} is not in ${path}\n`)
  return gone ? 0 : 1
}

/**
 * Connect for real. This is the check that is worth having: it spawns the
 * server, does the handshake, and reads the catalog through the client a
 * session uses, so a pass means the session will work.
 */
async function check(flags: Flags): Promise<number> {
  const wanted = flags.rest[0]
  const loaded = await loadServers(flags.dir)
  for (const problem of loaded.problems) process.stderr.write(`nh mcp: ${problem}\n`)

  const servers = wanted === undefined ? loaded.servers : loaded.servers.filter(server => server.name === wanted)
  if (servers.length === 0) {
    process.stdout.write(wanted === undefined ? 'nothing configured for this workspace\n' : `no server called ${wanted}\n`)
    return loaded.problems.length === 0 ? 0 : 1
  }

  const hub = await McpHub.connect(flags.dir, servers)
  try {
    for (const status of hub.status) {
      process.stdout.write(
        status.connected
          ? `ok    ${status.name}  ${status.toolCount} tool${status.toolCount === 1 ? '' : 's'}\n`
          : `fail  ${status.name}  ${status.error ?? 'unknown reason'}\n`,
      )
    }
    const failed = hub.status.some(status => !status.connected)
    return failed || loaded.problems.length > 0 ? 1 : 0
  } finally {
    // The servers were spawned to answer one question; leaving them running
    // after the command has printed its answer is a process leak with a prompt
    // in front of it.
    await hub.close()
  }
}
