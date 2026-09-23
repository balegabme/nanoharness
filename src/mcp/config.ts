// doc: docs/harness/mcp.md
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isJsonObject } from './protocol.js'
import { hashText } from '../core/project-trust.js'
import type { ProjectFile } from '../core/project-trust.js'

/**
 * Which servers a session talks to, from two files: `~/.nanoharness/mcp.json`
 * for every workspace and `.nanoharness/mcp.json` for this one.
 *
 * Two layers because both answers are right. A search server with one API key
 * is the same server in every project, and configuring it once is the whole
 * point of a home directory; a server that reaches this project's own issue
 * tracker belongs to this project and nowhere else. The project file wins on a
 * name, which is what makes a global server disablable, or replaceable, where
 * it does not belong, without editing the file every other workspace reads.
 *
 * Nothing is configured by default. A server is added by writing one of those
 * files, and the agent has `write`, so "add a search server" is work it can do
 * and not a setting only the user can reach.
 *
 * Secret-free by schema (plan §16): a token is named, never written. The file
 * is meant to be readable, diffable and pasteable into an issue, which it only
 * stays if there is no field a key could land in.
 */

export interface StdioServer {
  name: string
  transport: 'stdio'
  command: string
  args: string[]
  /** Variables to pass through from the harness's environment, by name. */
  envPassthrough: string[]
  enabled: boolean
}

export interface HttpServer {
  name: string
  transport: 'http'
  url: string
  /** The environment variable holding the bearer token. Not the token. */
  tokenEnv?: string
  enabled: boolean
}

export type McpServer = StdioServer | HttpServer

/** Where the two config files live. Named so the agent can be told the paths. */
export function mcpPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): { global: string; project: string } {
  // `NANOHARNESS_HOME` exists so a test can have a home directory of its own.
  // Nothing else sets it, and a session on a real machine reads `~`.
  const home = env.NANOHARNESS_HOME ?? homedir()
  return { global: join(home, '.nanoharness', 'mcp.json'), project: join(cwd, '.nanoharness', 'mcp.json') }
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function parseServer(name: string, value: unknown): McpServer | null {
  if (!isJsonObject(value)) return null
  const enabled = value.enabled !== false
  const url = text(value.url)
  if (url !== undefined) {
    const server: HttpServer = { name, transport: 'http', url, enabled }
    const tokenEnv = text(value.tokenEnv)
    if (tokenEnv !== undefined) server.tokenEnv = tokenEnv
    return server
  }
  const command = text(value.command)
  if (command === undefined) return null
  return {
    name,
    transport: 'stdio',
    command,
    args: strings(value.args),
    envPassthrough: strings(value.envPassthrough),
    enabled,
  }
}

/**
 * Read the workspace's server list. The file's shape is the one every MCP
 * client uses, a `mcpServers` object keyed by name, so a config written for
 * another harness works here unchanged, minus the fields that would hold a key.
 */
export function parseMcpConfig(parsed: unknown): McpServer[] {
  if (!isJsonObject(parsed)) return []
  const servers = isJsonObject(parsed.mcpServers) ? parsed.mcpServers : parsed
  const out: McpServer[] = []
  for (const [name, value] of Object.entries(servers)) {
    if (name === 'mcpServers') continue
    const server = parseServer(name, value)
    if (server !== null) out.push(server)
  }
  return out
}

/** What `loadServers` found, and what it could not read. */
export interface ServerList {
  servers: McpServer[]
  /**
   * Why a config file was left out, if one was: it would not parse, or it was
   * not approved. Neither is a reason to lose the session, but both are
   * reasons to say so. Starting with no MCP tools after a stray comma looks
   * exactly like a harness that never supported them, and the user has no way
   * to tell the two apart.
   */
  problems: string[]
}

/** One `mcp.json`, read. A missing file is an empty one, with empty text. */
interface ConfigFile extends ProjectFile {
  servers: McpServer[]
  problem?: string
}

async function readConfig(path: string): Promise<ConfigFile> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return { path, text: '', hash: '', servers: [] }
  const file = { path, text, hash: hashText(text) }
  try {
    return { ...file, servers: parseMcpConfig(JSON.parse(text)) }
  } catch (err) {
    return { ...file, servers: [], problem: `${path} could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Everything one config file holds, as written, keyed by server name. */
export async function readEntries(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (raw === null) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!isJsonObject(parsed)) throw new Error(`${path} is not a JSON object`)
  const servers = isJsonObject(parsed.mcpServers) ? parsed.mcpServers : parsed
  return { ...servers }
}

/**
 * Write one entry into one config file, creating the file and the
 * `.nanoharness` folder around it. The entry is validated by the same
 * `parseServer` a session uses, so "the harness accepted it" is what the
 * command checked, and not a second opinion; a validator written beside a
 * hand-written entry would only be checking its own homework.
 */
export async function writeEntry(path: string, name: string, entry: Record<string, unknown>): Promise<McpServer> {
  const server = parseServer(name, entry)
  if (server === null) throw new Error('a server needs either a command (stdio) or a url (http)')
  const entries = await readEntries(path)
  entries[name] = entry
  await save(path, entries)
  return server
}

/** Take one entry out. False when there was nothing under that name. */
export async function removeEntry(path: string, name: string): Promise<boolean> {
  const entries = await readEntries(path)
  if (!(name in entries)) return false
  delete entries[name]
  await save(path, entries)
  return true
}

async function save(path: string, entries: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ mcpServers: entries }, null, 2)}\n`, 'utf8')
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv
  /**
   * Asked before the project file's servers are used, with the file as it
   * reads now. The project file starts commands and hands out environment
   * variables on behalf of whoever wrote the project. A session passes the
   * user's answer here and `nh mcp check` passes the stored approval. Without
   * it the file is read as written, which suits a caller that only lists the
   * servers and starts none of them.
   */
  trust?: (file: ProjectFile) => Promise<boolean>
}

/**
 * The servers a session in `cwd` should connect to: the global file, then the
 * project's own on top of it. A project entry with the same name replaces the
 * global one outright and never merges field by field, since a half-overridden
 * command line is a server nobody configured. `"enabled": false` is how a
 * project turns a global server off without touching the global file.
 *
 * `trust` is asked only when the project file would start or reach a server of
 * its own. A file that only switches global servers off starts nothing, and a
 * refused file is left out whole.
 */
export async function loadServers(cwd: string, options: LoadOptions = {}): Promise<ServerList> {
  const paths = mcpPaths(cwd, options.env)
  const global = await readConfig(paths.global)
  // A workspace opened at the home folder finds one file in both places, and
  // it is the global one.
  let project = paths.project === paths.global ? undefined : await readConfig(paths.project)
  const problems = global.problem === undefined ? [] : [global.problem]
  if (project?.problem !== undefined) problems.push(project.problem)

  if (options.trust !== undefined && project?.servers.some(server => server.enabled) === true && !(await options.trust(project))) {
    // No closing period: whatever shows a problem ends the sentence itself.
    problems.push(
      `The servers in ${project.path} are off because the file is not approved as it reads now. A session in the app asks about it once per run, and again whenever the file changes`,
    )
    project = undefined
  }

  const byName = new Map<string, McpServer>()
  for (const server of [...global.servers, ...(project?.servers ?? [])]) byName.set(server.name, server)
  return { servers: [...byName.values()].filter(server => server.enabled), problems }
}
