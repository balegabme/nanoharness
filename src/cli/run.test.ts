import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

/**
 * `nh run` from the command line to the files it leaves, against a scripted
 * endpoint on the chat-completions wire. The endpoint is described by the
 * environment alone, the way a container runs it, and the user-data directory
 * is a scratch one, so nothing here reads or writes the user's own settings.
 */

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    getSecret(): Promise<null> {
      return Promise.resolve(null)
    }
    setSecret(): Promise<void> {
      return Promise.reject(new Error('a test must not store keys'))
    }
    deleteCredential(): Promise<boolean> {
      return Promise.resolve(false)
    }
  },
}))

interface WireMessage {
  role: string
  content: string | null
  tool_calls?: { function: { name: string } }[]
}

/** `hang` takes the request and never answers it. */
type Reply = { text: string } | { call: { name: string; args: Record<string, unknown> } } | 'hang'

/** Serves `replies` in order, one per request, and keeps every request body. */
function scripted(replies: Reply[]): { server: Server; seen: WireMessage[][]; url: () => string } {
  const seen: WireMessage[][] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      seen.push((JSON.parse(body) as { messages: WireMessage[] }).messages)
      const reply = replies.shift() ?? { text: 'out of script' }
      if (reply === 'hang') return
      const delta =
        'text' in reply
          ? { content: reply.text }
          : { tool_calls: [{ index: 0, id: `call_${seen.length}`, function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  return { server, seen, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
}

const ENV = ['APPDATA', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE', 'NH_BASE_URL', 'NH_API_KEY', 'NH_MODEL', 'NH_API_KIND'] as const
const originals = Object.fromEntries(ENV.map(name => [name, process.env[name]]))
let home = ''
let work = ''
let server: Server | undefined
let stdout: string[] = []
let stderr: string[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nh-run-home-'))
  work = await mkdtemp(join(tmpdir(), 'nh-run-work-'))
  for (const name of ['APPDATA', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE'] as const) process.env[name] = home
  process.env.NH_API_KEY = 'test-key'
  process.env.NH_MODEL = 'scripted-model'
  delete process.env.NH_API_KIND
  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  server?.closeAllConnections()
  await new Promise<void>(done => (server === undefined ? done() : server.close(() => done())))
  server = undefined
  for (const [name, value] of Object.entries(originals)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(home, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

async function serve(replies: Reply[]): Promise<WireMessage[][]> {
  const mock = scripted(replies)
  server = mock.server
  await new Promise<void>(done => mock.server.listen(0, '127.0.0.1', done))
  process.env.NH_BASE_URL = mock.url()
  return mock.seen
}

async function nh(...argv: string[]): Promise<number> {
  const { runRun } = await import('./run.js')
  return runRun(argv)
}

function jsonLines(): { type: string; [key: string]: unknown }[] {
  return stdout
    .join('')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as { type: string })
}

describe('nh run', () => {
  it('runs a task to the end, leaves its files, and a second run carries the session on', async () => {
    const seen = await serve([{ call: { name: 'write', args: { path: 'hello.txt', content: 'hi there\n' } } }, { text: 'Wrote hello.txt.' }, { text: 'It says hi there.' }])

    expect(await nh('--dir', work, '--format', 'json', 'write hello.txt')).toBe(0)
    expect(await readFile(join(work, 'hello.txt'), 'utf8')).toBe('hi there\n')
    const events = jsonLines()
    expect(events.some(e => e.type === 'tool_call')).toBe(true)
    const result = events.at(-1)
    expect(result).toMatchObject({ type: 'result', status: 'done', turns: 1, text: 'Wrote hello.txt.', usage: { input: 200, output: 20 } })

    // The session is where the window keeps its own, named after the task.
    const { workspaceStatus } = await import('../main/workspace-store.js')
    const status = await workspaceStatus()
    expect(status.sessions.map(s => ({ id: s.id, title: s.title }))).toEqual([{ id: result?.sessionId, title: 'write hello.txt' }])

    stdout = []
    expect(await nh('--dir', work, '-c', 'what does it say?')).toBe(0)
    expect(stdout.join('')).toBe('It says hi there.\n')
    // The third request carries the whole first turn before the new question.
    const history = seen[2] ?? []
    expect(history.filter(m => m.role === 'user').map(m => m.content)).toEqual(['write hello.txt', 'what does it say?'])
    expect(history.some(m => m.tool_calls?.[0]?.function.name === 'write')).toBe(true)
  })

  it('refuses a shell command unless --approve all', async () => {
    const make = { call: { name: 'bash', args: { command: 'node -e "require(\'fs\').writeFileSync(\'made.txt\', \'x\')"' } } }
    const seen = await serve([make, { text: 'Could not run it.' }, make, { text: 'Ran it.' }])

    expect(await nh('--dir', work, 'make the file')).toBe(0)
    expect(stderr.join('')).toContain('refused: run')
    await expect(readFile(join(work, 'made.txt'), 'utf8')).rejects.toThrow()
    const refused = seen[1]?.at(-1)
    expect(refused?.role).toBe('tool')

    expect(await nh('--dir', work, '--approve', 'all', 'make the file')).toBe(0)
    expect(await readFile(join(work, 'made.txt'), 'utf8')).toBe('x')
  })

  it('stops a run that outlasts --timeout and says so in the status', async () => {
    await serve(['hang'])

    expect(await nh('--dir', work, '--format', 'json', '--timeout', '0.5', 'wait for it')).toBe(3)
    expect(jsonLines().at(-1)).toMatchObject({ type: 'result', status: 'timeout', turns: 1 })
  })

  it('answers a mistyped command with the help and status 2', async () => {
    expect(await nh('--approve', 'maybe', 'task')).toBe(2)
    expect(stderr.join('')).toContain('--approve takes none, judge or all')
    expect(stderr.join('')).toContain('nh run: run one task')
  })
})
