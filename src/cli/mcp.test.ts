import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMcp } from './mcp.js'

/**
 * `nh mcp`, run the way an agent runs it. The point of the command is that
 * adding a server is one call that writes the file with the harness's own
 * parser and can then connect for real, so the test writes with the command,
 * reads the file off disk, and makes `check` talk to an actual server over
 * stdio. Nothing here asserts on a mock.
 */

const SERVER = `
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
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] } })
    return
  }
  // A remote server with a key in its URL behaves exactly like this: it greets
  // anyone and only looks at the credential when a tool is called.
  if (message.method === 'tools/call') {
    const key = (message.params && message.params.arguments || {}).key
    send(key === 'right'
      ? { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } }
      : { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Invalid key: it does not start with right-' }] } })
  }
}
`

let home: string
let project: string
let script: string
const home_key = 'NANOHARNESS_HOME'

/** Everything the command printed, so a test reads what the agent would read. */
function captured(): { out: () => string; err: () => string } {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    out += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    err += String(chunk)
    return true
  })
  return { out: () => out, err: () => err }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'nh-cli-home-'))
  project = await mkdtemp(join(tmpdir(), 'nh-cli-project-'))
  script = join(project, 'server.mjs')
  await writeFile(script, SERVER, 'utf8')
  process.env[home_key] = home
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  delete process.env[home_key]
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

async function entries(path: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { mcpServers?: Record<string, unknown> }
  return parsed.mcpServers ?? {}
}

describe('nh mcp add', () => {
  it('writes an entry a session can read, and says where it went', async () => {
    const printed = captured()
    const code = await runMcp(['add', 'probe', '--dir', project, '--command', process.execPath, '--arg', script])

    expect(code).toBe(0)
    const written = await entries(join(project, '.nanoharness', 'mcp.json'))
    expect(written.probe).toEqual({ command: process.execPath, args: [script], envPassthrough: [] })
    // A restart is what makes it live, and the command says so. Otherwise the
    // agent reports a server the running session has not got.
    expect(printed.out()).toContain('restart the app')
  })

  it('names a token and writes none', async () => {
    captured()
    await runMcp(['add', 'tickets', '--global', '--url', 'https://mcp.example.com/mcp', '--token-env', 'TICKETS_TOKEN'])

    const written = await entries(join(home, '.nanoharness', 'mcp.json'))
    expect(written.tickets).toEqual({ url: 'https://mcp.example.com/mcp', tokenEnv: 'TICKETS_TOKEN' })
  })

  it('refuses an entry the harness would ignore, and writes nothing', async () => {
    const printed = captured()
    expect(await runMcp(['add', 'nonsense', '--dir', project])).toBe(2)
    expect(printed.err()).toContain('--command')
    expect(Object.keys(await entries(join(project, '.nanoharness', 'mcp.json')))).not.toContain('nonsense')
  })
})

describe('asking the command what it takes', () => {
  it('answers `--help` wherever it appears, as the command or after it', async () => {
    for (const argv of [['--help'], ['add', '--help'], ['check', '-h'], ['remove', 'tavily', '--help']]) {
      const printed = captured()
      expect(await runMcp(argv)).toBe(0)
      expect(printed.out()).toContain('nh mcp add <name> --url <url>')
      vi.restoreAllMocks()
    }
  })

  it('answers a wrong command line with the right one', async () => {
    const printed = captured()
    const code = await runMcp(['add', 'thing', '--transport', 'http'])

    expect(code).toBe(2)
    // The message says what was wrong, and the help says what to write instead:
    // an agent that has to guess twice more has cost more than the command saved.
    expect(printed.err()).toContain('unknown flag --transport')
    expect(printed.err()).toContain('nh mcp add <name> --command <cmd>')
  })
})

describe('nh mcp list', () => {
  it('shows both files and what this workspace actually connects to', async () => {
    const printed = captured()
    const code = await runMcp(['list', '--dir', project])

    expect(code).toBe(0)
    const out = printed.out()
    expect(out).toContain(join(home, '.nanoharness', 'mcp.json'))
    expect(out).toContain(join(project, '.nanoharness', 'mcp.json'))
    expect(out).toContain('this workspace connects to:')
    expect(out).toContain('probe  stdio')
    expect(out).toContain('tickets  http')
  })
})

describe('nh mcp check', () => {
  it('connects for real and reports the catalog it found', async () => {
    const printed = captured()
    const code = await runMcp(['check', 'probe', '--dir', project])

    expect(code).toBe(0)
    expect(printed.out()).toContain('ok    probe  1 tool')
  })

  it('does not let a handshake stand in for a working credential', async () => {
    const printed = captured()
    const code = await runMcp(['check', 'probe', '--dir', project])

    // The catalog came back, which on its own says only "ok". A server whose
    // key is dead answers exactly this far.
    expect(code).toBe(0)
    expect(printed.out()).toContain('--call')
  })

  it('reports a call the server refused, where the handshake passed', async () => {
    const printed = captured()
    const code = await runMcp(['check', 'probe', '--dir', project, '--call', 'echo', '--args', '{"key":"wrong"}'])

    expect(code).toBe(1)
    expect(printed.out()).toContain('call  fail')
    // The server's own sentence, so the reader can see it is the key and not
    // the connection.
    expect(printed.out()).toContain('Invalid key')
  })

  it('passes when the call itself comes back', async () => {
    const printed = captured()
    const code = await runMcp(['check', 'probe', '--dir', project, '--call', 'echo', '--args', '{"key":"right"}'])

    expect(code).toBe(0)
    expect(printed.out()).toContain('call  ok')
    expect(printed.out()).toContain('pong')
  })

  it('names the tools it has when asked for one it has not', async () => {
    const printed = captured()
    const code = await runMcp(['check', 'probe', '--dir', project, '--call', 'nope'])

    expect(code).toBe(1)
    expect(printed.out()).toContain('it has: echo')
  })

  it('fails loudly on a server that will not start', async () => {
    captured()
    await runMcp(['add', 'broken', '--dir', project, '--command', join(project, 'no-such-binary')])
    const printed = captured()
    const code = await runMcp(['check', 'broken', '--dir', project])

    expect(code).toBe(1)
    expect(printed.out()).toContain('fail  broken')
  })
})

describe('nh mcp remove', () => {
  it('takes the entry out and leaves the file and the others alone', async () => {
    captured()
    const path = join(project, '.nanoharness', 'mcp.json')
    expect(await runMcp(['remove', 'broken', '--dir', project])).toBe(0)

    const left = await entries(path)
    expect(Object.keys(left)).toEqual(['probe'])
    // Removing one server is not a licence to delete the config file.
    expect(await readFile(path, 'utf8')).toContain('probe')
  })

  it('says so when there is nothing under that name', async () => {
    const printed = captured()
    expect(await runMcp(['remove', 'ghost', '--dir', project])).toBe(1)
    expect(printed.out()).toContain('is not in')
  })
})
