import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpClient } from './client.js'
import { StdioTransport, stdioCommand } from './transport.js'
import { RequestTimeoutError } from './protocol.js'

/**
 * The failure half of the client: a server that answers the handshake and then
 * stops, and a server that never answers at all. Both are real subprocesses,
 * because both bugs these tests exist for are about a process that is still
 * running after this side has given up on it, which a fake transport cannot
 * have and cannot leak.
 *
 * Each server appends every message it receives to a log, and keeps a heartbeat
 * going, so the test can see what the client actually sent and whether the
 * child is still alive afterwards.
 */

const SERVER = (answerInitialize: boolean): string => `
import { appendFileSync } from 'node:fs'
const log = process.argv[2]
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
// Proof of life: if this stops appearing, the process is gone.
setInterval(() => appendFileSync(log, JSON.stringify({ beat: true }) + '\\n'), 50)

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let cut = buffer.indexOf('\\n')
  while (cut >= 0) {
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (line !== '') {
      appendFileSync(log, line + '\\n')
      handle(JSON.parse(line))
    }
    cut = buffer.indexOf('\\n')
  }
})

function handle(message) {
  if (message.method === 'initialize') {
    if (!${String(answerInitialize)}) return
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stall', version: '1' } },
    })
    return
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{ name: 'wait', description: 'never answers', inputSchema: { type: 'object' } }] },
    })
    return
  }
  // tools/call is deliberately never answered.
}
`

let dir: string

async function write(name: string, answerInitialize: boolean): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, SERVER(answerInitialize), 'utf8')
  return path
}

function connect(script: string, log: string, options: { requestTimeout?: number; connectTimeout?: number }): McpClient {
  const transport = new StdioTransport({ command: process.execPath, args: [script, log], cwd: dir })
  return new McpClient(transport, options)
}

/** Every message the server wrote down, heartbeats dropped. */
async function received(log: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(log, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .filter(message => message.beat !== true)
}

/**
 * The same log, read until it holds what the test is waiting for. The cancel
 * notification is sent without being awaited, on purpose: the request rejects
 * on its deadline and not on the server's acknowledgement, so the reject
 * and the notification race. Reading the log once can land before the
 * notification is written.
 */
async function awaitMessage(log: string, method: string): Promise<Record<string, unknown> | undefined> {
  const giveUp = Date.now() + 2000
  for (;;) {
    const messages = await received(log)
    const found = messages.find(message => message.method === method)
    if (found !== undefined || Date.now() > giveUp) return found
    await sleep(20)
  }
}

/** Whether the child is still writing, which is the only honest liveness check. */
async function stillRunning(log: string): Promise<boolean> {
  const before = (await stat(log)).size
  await sleep(300)
  return (await stat(log)).size !== before
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nh-client-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('a call the server never answers', () => {
  it('gives up on its own deadline and tells the server it has', async () => {
    const log = join(dir, 'stall.log')
    const client = connect(await write('stall.mjs', true), log, { requestTimeout: 400 })
    await client.connect()
    await client.listTools()

    await expect(client.callTool('wait', {})).rejects.toBeInstanceOf(RequestTimeoutError)

    const cancelled = await awaitMessage(log, 'notifications/cancelled')
    const call = (await received(log)).find(message => message.method === 'tools/call')
    expect(call).toBeDefined()
    // Advisory, and addressed to the request that expired.
    expect(cancelled).toBeDefined()
    expect((cancelled?.params as { requestId?: number } | undefined)?.requestId).toBe(call?.id)

    await client.close()
  })
})

describe('a server that never finishes the handshake', () => {
  it('fails on the shorter deadline, sends no cancellation, and leaves nothing running', async () => {
    const log = join(dir, 'deaf.log')
    const client = connect(await write('deaf.mjs', false), log, { connectTimeout: 400 })

    const started = Date.now()
    await expect(client.connect()).rejects.toBeInstanceOf(RequestTimeoutError)
    // The handshake deadline, not the 60s one a tool call gets. The threshold
    // is loose because the window holds more than the deadline: spawning node
    // and then waiting for it to be gone again, both of which are seconds on a
    // loaded Windows machine. Its job is to tell 400ms apart from 60s, and
    // anything in between does that.
    expect(Date.now() - started).toBeLessThan(20_000)

    const messages = await received(log)
    expect(messages.some(message => message.method === 'initialize')).toBe(true)
    // The spec forbids cancelling `initialize`, and a server mid-handshake has
    // no session in which to read the notification anyway.
    expect(messages.some(message => message.method === 'notifications/cancelled')).toBe(false)

    // The rejected promise was the only reference to that subprocess. If the
    // failed handshake did not close its transport, this is a server nothing
    // left in the app could ever stop.
    expect(await stillRunning(log)).toBe(false)
  })
})

describe('spawning a server on this platform', () => {
  it('wraps script launchers on Windows and leaves everything else alone', () => {
    const npx = stdioCommand('npx', ['-y', 'tavily-mcp@latest'])
    const direct = stdioCommand(process.execPath, ['server.mjs'])
    if (process.platform === 'win32') {
      // `npx` is `npx.cmd`, a batch script, and `spawn` does not use a shell.
      expect(npx).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', 'tavily-mcp@latest'] })
    } else {
      expect(npx).toEqual({ command: 'npx', args: ['-y', 'tavily-mcp@latest'] })
    }
    // An executable is spawnable as it is on every platform; a shell would only
    // slow it down and add a process between the harness and the server.
    expect(direct).toEqual({ command: process.execPath, args: ['server.mjs'] })
  })
})
