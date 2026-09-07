import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpHub } from './hub.js'
import { workspaceGate } from '../core/scope.js'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { McpServer } from './config.js'

/**
 * A remote server over Streamable HTTP, against a real HTTP server on a real
 * port. What is being tested is what goes on the wire — the session header, the
 * negotiated protocol version, the bearer token, and the fact that a server may
 * answer a POST with either JSON or an SSE stream and the client must read
 * both — none of which a stubbed `fetch` would keep honest.
 */

interface Seen {
  method: string
  headers: Record<string, string | undefined>
}

const SESSION = 'session-42'
const seen: Seen[] = []
let deleted = false

let server: Server
let url: string
let dir: string
let hub: McpHub

function json(res: ServerResponse, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** The same message, as the one-event SSE stream a slow server would send. */
function events(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
}

function handle(req: IncomingMessage, res: ServerResponse, message: Record<string, unknown>): void {
  seen.push({
    method: String(message.method),
    headers: {
      authorization: req.headers.authorization,
      'mcp-session-id': req.headers['mcp-session-id'] as string | undefined,
      'mcp-protocol-version': req.headers['mcp-protocol-version'] as string | undefined,
      accept: req.headers.accept,
    },
  })

  if (message.method === 'initialize') {
    json(
      res,
      {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'remote', version: '1' } },
      },
      { 'mcp-session-id': SESSION },
    )
    return
  }
  if (message.method === 'tools/list') {
    events(res, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'lookup',
            description: 'look something up',
            inputSchema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] },
          },
        ],
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    const params = message.params as { arguments?: { term?: string } }
    json(res, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `found ${params.arguments?.term}` }] } })
    return
  }
  // A notification: accepted, no body, which is what the spec asks for.
  res.writeHead(202)
  res.end()
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      deleted = true
      res.writeHead(204)
      res.end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => (body += chunk))
    req.on('end', () => handle(req, res, JSON.parse(body) as Record<string, unknown>))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`

  dir = await mkdtemp(join(tmpdir(), 'nh-http-'))
  process.env.NH_TEST_MCP_TOKEN = 'secret-token'
  const configured: McpServer = { name: 'remote', transport: 'http', url, tokenEnv: 'NH_TEST_MCP_TOKEN', enabled: true }
  hub = await McpHub.connect(dir, [configured])
})

afterAll(async () => {
  await hub.close()
  delete process.env.NH_TEST_MCP_TOKEN
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

describe('a server over Streamable HTTP', () => {
  it('connects and reads a catalog that came back as an SSE stream', () => {
    expect(hub.status).toEqual([{ name: 'remote', connected: true, toolCount: 1 }])
    expect(hub.tools().map(tool => tool.input.name)).toEqual(['mcp__remote__lookup'])
  })

  it('sends the token in the header, never the URL', () => {
    expect(url).not.toContain('secret')
    for (const request of seen) expect(request.headers.authorization).toBe('Bearer secret-token')
  })

  it('offers both content types and echoes the session the server issued', () => {
    const initialize = seen[0]
    expect(initialize?.method).toBe('initialize')
    expect(initialize?.headers.accept).toBe('application/json, text/event-stream')
    // Nothing to echo yet on the first request; every one after it carries it.
    expect(initialize?.headers['mcp-session-id']).toBeUndefined()
    for (const request of seen.slice(1)) expect(request.headers['mcp-session-id']).toBe(SESSION)
  })

  it('carries the negotiated protocol version on every request after the handshake', () => {
    expect(seen[0]?.headers['mcp-protocol-version']).toBeUndefined()
    // A server that gets no version header may assume an older protocol and
    // answer in a shape this client stopped expecting.
    for (const request of seen.slice(1)) expect(request.headers['mcp-protocol-version']).toBe('2025-06-18')
  })

  it('calls a tool', async () => {
    const lookup = hub.tools()[0]
    const result = await lookup?.run({ term: 'kettle' }, { cwd: dir, access: workspaceGate(dir) })
    expect(result?.ok).toBe(true)
    expect(result?.content).toBe('found kettle')
  })

  it('ends the session on the server when the hub closes', async () => {
    await hub.close()
    expect(deleted).toBe(true)
  })
})
