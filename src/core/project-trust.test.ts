import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrust } from './project-trust.js'
import { hookPaths, readHookFile } from '../hooks/config.js'
import { loadServers, mcpPaths } from '../mcp/config.js'
import { McpHub } from '../mcp/hub.js'
import type { ProjectFile } from './project-trust.js'

/**
 * A cloned project's `mcp.json`, opened the way a session opens it: the
 * servers are loaded through the trust store, the hub spawns whatever that
 * lets through, and each server is a real subprocess that writes its name to a
 * log the moment it starts. The log is the proof. A server that was refused
 * and still started would show up there whatever the hub's status claimed.
 *
 * The one part standing in for the app is `ask`, which answers the question
 * the window would put to the user and records what it was shown.
 */

const SERVER = `
import { appendFileSync } from 'node:fs'
const [log, name] = process.argv.slice(2)
appendFileSync(log, name + '\\n')
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let cut = buffer.indexOf('\\n')
  while (cut >= 0) {
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line !== '') handle(JSON.parse(line))
    cut = buffer.indexOf('\\n')
  }
})
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } } })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'ping', description: 'answers', inputSchema: { type: 'object', properties: {} } }] } })
  }
}
`

let dir: string
let home: string
let root: string
let script: string
let log: string
const hubs: McpHub[] = []

function entry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [script, log, name], ...extra }
}

async function config(path: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8')
}

/** The servers that have started so far, in the order they started. */
async function started(): Promise<string[]> {
  const text = await readFile(log, 'utf8').catch(() => '')
  return text.split('\n').filter(line => line !== '')
}

/**
 * A user at the window, who answers `allow` and remembers every file they were
 * shown. `ask` is called once for each session that reaches the question, and
 * the answer waits until `sessions` of them have, so a second session that
 * asked on its own instead of sharing the first one's question is caught.
 */
function user(allow: boolean, sessions = 1): { shown: ProjectFile[]; ask: (file: ProjectFile) => () => Promise<boolean> } {
  const shown: ProjectFile[] = []
  let reached = 0
  let release = (): void => undefined
  const everyone = new Promise<void>(resolve => (release = resolve))
  return {
    shown,
    ask: file => {
      reached += 1
      if (reached >= sessions) release()
      return async () => {
        shown.push(file)
        await everyone
        return allow
      }
    },
  }
}

/** Build a session's MCP servers in `root`, as the main process does. */
async function open(trust: ProjectTrust, person: ReturnType<typeof user>): Promise<McpHub> {
  const loaded = await loadServers(root, { env: { NANOHARNESS_HOME: home }, trust: file => trust.check(file, person.ask(file)) })
  const hub = await McpHub.connect(root, loaded.servers, loaded.problems)
  hubs.push(hub)
  return hub
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nh-trust-'))
  home = join(dir, 'home')
  root = join(dir, 'project')
  script = join(dir, 'server.mjs')
  log = join(dir, 'started.log')
  await writeFile(script, SERVER, 'utf8')
})

afterAll(async () => {
  await Promise.all(hubs.map(hub => hub.close()))
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

describe("a project's MCP servers", () => {
  it('start only once the user has approved the file as it reads now', async () => {
    const env = { NANOHARNESS_HOME: home }
    const paths = mcpPaths(root, env)
    const store = join(dir, 'project-trust.json')
    await config(paths.global, { mine: entry('mine') })
    await config(paths.project, { theirs: entry('theirs') })

    // A refusal: the global server is the user's own and starts without a
    // question, the project's does not start, and the session is told why.
    const trust = new ProjectTrust(store)
    const no = user(false)
    const refused = await open(trust, no)
    expect(no.shown.map(file => file.path)).toEqual([paths.project])
    expect(no.shown[0]?.text).toBe(await readFile(paths.project, 'utf8'))
    expect(await started()).toEqual(['mine'])
    expect(refused.tools().map(tool => tool.input.name)).toEqual(['mcp__mine__ping'])
    expect(refused.status.find(server => server.name === 'mcp.json')?.error).toContain('is not approved as it reads now')

    // The refusal holds for the rest of the run: the next session asks nothing.
    await open(trust, no)
    expect(no.shown).toHaveLength(1)
    expect(await started()).toEqual(['mine', 'mine'])

    // An edit is a new file, and asks again. Two sessions opening at once
    // share the one question, and both get the server once it is approved.
    await config(paths.project, { theirs: entry('theirs', { envPassthrough: ['HOME'] }) })
    const yes = user(true, 2)
    const both = await Promise.all([open(trust, yes), open(trust, yes)])
    expect(yes.shown).toHaveLength(1)
    for (const hub of both) expect(hub.status.every(server => server.connected)).toBe(true)
    expect((await started()).filter(name => name === 'theirs')).toHaveLength(2)

    // The approval is on disk, so the next launch starts the server unasked.
    const relaunched = user(false)
    const later = await open(new ProjectTrust(store), relaunched)
    expect(relaunched.shown).toEqual([])
    expect(later.tools().map(tool => tool.input.name)).toEqual(['mcp__mine__ping', 'mcp__theirs__ping'])

    // Approving the folder's servers approved nothing else in it: its hooks
    // file is a question of its own.
    const hooksPath = hookPaths(root, env).project
    await writeFile(hooksPath, JSON.stringify({ Stop: [{ command: 'true' }] }), 'utf8')
    const hooks = await readHookFile(hooksPath)
    const asked = user(true)
    expect(await new ProjectTrust(store).check(hooks, asked.ask(hooks))).toBe(true)
    expect(asked.shown.map(file => file.path)).toEqual([hooksPath])
  })

  it('need no approval when the project file only switches a global server off', async () => {
    const paths = mcpPaths(root, { NANOHARNESS_HOME: home })
    await config(paths.global, { mine: entry('mine') })
    await config(paths.project, { mine: entry('mine', { enabled: false }) })
    const before = await started()

    const nobody = user(false)
    const hub = await open(new ProjectTrust(join(dir, 'fresh-trust.json')), nobody)
    expect(nobody.shown).toEqual([])
    expect(hub.status).toEqual([])
    expect(await started()).toEqual(before)
  })
})

describe('an approval the store cannot keep', () => {
  it('still holds for the rest of the run', async () => {
    const paths = mcpPaths(root, { NANOHARNESS_HOME: home })
    await config(paths.project, { theirs: entry('theirs', { args: [script, log, 'theirs', 'unkept'] }) })
    // A store whose folder is a file: every write fails.
    const trust = new ProjectTrust(join(script, 'project-trust.json'))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const yes = user(true)
    await open(trust, yes)
    const again = user(false)
    const second = await open(trust, again)

    expect(yes.shown).toHaveLength(1)
    expect(again.shown).toEqual([])
    expect(second.tools().map(tool => tool.input.name)).toContain('mcp__theirs__ping')
    vi.restoreAllMocks()
  })
})
