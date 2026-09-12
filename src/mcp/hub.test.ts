import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpHub, mcpBlock } from './hub.js'
import { workspaceGate } from '../core/scope.js'
import type { McpServer } from './config.js'

/**
 * A real MCP server, over a real stdio transport, in a real subprocess.
 *
 * Nothing here is stubbed: the test spawns a Node process that speaks
 * newline-delimited JSON-RPC, and the code under test is the whole path a tool
 * call takes: handshake, version negotiation, paginated catalog, schema
 * narrowing, the call, and the two failure kinds. A fake transport would have
 * proved that the client talks to a fake transport.
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

// Logging on a healthy start, on the channel a client must never read as an
// error. Also enough of it to matter if nobody drains the pipe.
process.stderr.write('server: starting\\n'.repeat(200))

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'probe', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    // Two pages, to exercise the cursor.
    if (message.params && message.params.cursor === 'page2') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{ name: 'explode', description: 'always fails', inputSchema: { type: 'object', properties: {} } }],
          nextCursor: null,
        },
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'echo a phrase back',
            inputSchema: {
              $schema: 'https://json-schema.org/draft/2020-12/schema',
              type: 'object',
              properties: {
                phrase: { type: ['string', 'null'], description: 'what to say', format: 'text' },
                times: { type: 'integer' },
              },
              required: ['phrase'],
              additionalProperties: false,
            },
          },
        ],
        nextCursor: 'page2',
      },
    })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params.name
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'you said ' + message.params.arguments.phrase }] },
      })
      return
    }
    if (name === 'explode') {
      // A tool-domain failure: a valid result the model is meant to read.
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'nothing matched' }], isError: true } })
      return
    }
    // A protocol error: this client asked for something that is not there.
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool ' + name } })
  }
}
`

let dir: string
let hub: McpHub

function server(script: string): McpServer {
  return { name: 'probe', transport: 'stdio', command: process.execPath, args: [script], envPassthrough: [], enabled: true }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nh-mcp-'))
  const script = join(dir, 'server.mjs')
  await writeFile(script, SERVER, 'utf8')
  hub = await McpHub.connect(dir, [server(script)])
})

afterAll(async () => {
  await hub.close()
  await rm(dir, { recursive: true, force: true })
})

describe('an MCP server over stdio', () => {
  it('connects, pages the catalog, and exposes both tools under the server prefix', () => {
    expect(hub.status).toEqual([{ name: 'probe', connected: true, toolCount: 2 }])
    expect(hub.tools().map(tool => tool.input.name)).toEqual(['mcp__probe__echo', 'mcp__probe__explode'])
  })

  it('narrows the published schema to what a provider will take', () => {
    const echo = hub.tools()[0]
    expect(echo?.input.inputSchema).toEqual({
      type: 'object',
      properties: {
        // The union keeps its non-null member; `format` and `$schema` are gone.
        phrase: { type: 'string', description: 'what to say' },
        // JSON Schema's integer is a number to every provider.
        times: { type: 'number' },
      },
      required: ['phrase'],
      additionalProperties: false,
    })
  })

  it('calls a tool and returns its text', async () => {
    const echo = hub.tools()[0]
    const result = await echo?.run({ phrase: 'hello' }, { cwd: dir, access: workspaceGate(dir) })
    expect(result?.ok).toBe(true)
    expect(result?.content).toBe('you said hello')
  })

  it('hands a tool-domain failure back for the model to read', async () => {
    const explode = hub.tools()[1]
    const result = await explode?.run({}, { cwd: dir, access: workspaceGate(dir) })
    expect(result?.ok).toBe(false)
    expect(result?.isError).toBe(true)
    // Verbatim: it is the model's to act on, not the harness's to reword.
    expect(result?.content).toBe('nothing matched')
  })
})

describe('a server that will not start', () => {
  it('is reported rather than thrown, and the session gets no tools from it', async () => {
    const broken = await McpHub.connect(dir, [server(join(dir, 'missing.mjs'))])
    expect(broken.tools()).toEqual([])
    expect(broken.status[0]?.connected).toBe(false)
    expect(broken.status[0]?.error).toBeTruthy()
    await broken.close()
  })
})

/**
 * Who is told what. The failure this pins down is one that happened: a builder
 * was handed both the rule that harness config goes to a harness-editor and the
 * command that does it, weighed the two against each other in its own thinking,
 * and did the work itself. A prompt that argues with itself is answered by
 * whichever half the model reads last.
 */
describe('what a session is told about MCP', () => {
  const status = [{ name: 'probe', connected: true, toolCount: 2 }]
  const paths = { global: '/home/me/.nanoharness/mcp.json', project: '/work/app/.nanoharness/mcp.json' }
  const cli = 'node "/opt/nanoharness/out/cli/index.js"'

  it('tells an agent that can spawn to hand the work over, and gives it no command to run', () => {
    const text = mcpBlock(status, paths, { canWrite: true, canSpawn: true, root: '/work/app', cli }).join('\n')

    expect(text).toContain('spawn a harness-editor')
    expect(text).not.toContain('mcp add')
    // It still knows what it has and where the files are: that is what the
    // question "what tools do you have" needs, and it is not a licence to edit.
    expect(text).toContain('probe (2 tools)')
    expect(text).toContain(paths.global)
    // And it is told no entry shape, because the only thing it can do with one
    // is put it in the task it hands over, where a guess arrives as a
    // requirement the subagent has to satisfy or disprove.
    expect(text).not.toContain('tokenEnv')
    expect(text).not.toContain('envPassthrough')
  })

  it('gives the subagent the exact commands, with the workspace named', () => {
    const text = mcpBlock(status, paths, { canWrite: true, canSpawn: false, root: '/work/app', cli }).join('\n')

    expect(text).toContain(`${cli} mcp add <name> --url <url>`)
    expect(text).toContain(`${cli} mcp check <name> --dir /work/app`)
    // The one that writes the file is the one that gets the fields.
    expect(text).toContain('tokenEnv')
    // Its own folder is the harness, not the workspace the user meant, so the
    // flag that says which workspace is in the command rather than in a note.
    expect(text).toContain('--dir /work/app')
    expect(text).toContain('mcp --help')
  })

  it('tells an agent that cannot write neither one', () => {
    const text = mcpBlock(status, paths, { canWrite: false, canSpawn: false, root: '/work/app', cli }).join('\n')

    expect(text).not.toContain('mcp add')
    expect(text).not.toContain('harness-editor')
  })
})
