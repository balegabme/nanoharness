// doc: docs/harness/mcp.md
import {
  ConnectionClosedError,
  McpProtocolError,
  PROTOCOL_VERSION,
  RequestTimeoutError,
  SUPPORTED_VERSIONS,
  isJsonObject,
  isResponse,
} from './protocol.js'
import type { Transport } from './transport.js'
import type { JsonRpcMessage } from './protocol.js'

/** One tool as the server describes it. `inputSchema` is raw JSON Schema. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** A `CallToolResult`, flattened to what a harness tool result needs. */
export interface McpCallResult {
  text: string
  isError: boolean
}

export interface ClientOptions {
  /** Per-request deadline. On expiry the request is cancelled and rejected. */
  requestTimeout?: number
  /**
   * A shorter deadline for the handshake, because it is the one request a
   * person is waiting behind: the hub connects before the session exists, so a
   * server that spawns and then never answers holds up the user's first message
   * for the whole of it. A tool call may reasonably take a minute; a handshake
   * that has not landed in fifteen seconds is not going to.
   */
  connectTimeout?: number
  clientName?: string
  clientVersion?: string
}

const DEFAULT_TIMEOUT = 60_000
const DEFAULT_CONNECT_TIMEOUT = 15_000

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/**
 * A tools-only MCP client: the handshake, the catalog, and calls. Resources,
 * prompts and sampling are out of scope for v1 (plan §7): a coding harness
 * that already reads files does not need a second way to read files.
 */
export class McpClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private catalog: McpTool[] | null = null
  private closedReason: string | null = null
  private serverName = 'server'

  private readonly timeout: number
  private readonly connectTimeout: number

  constructor(
    private readonly transport: Transport,
    private readonly options: ClientOptions = {},
  ) {
    this.timeout = options.requestTimeout ?? DEFAULT_TIMEOUT
    this.connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
    transport.onMessage(message => this.receive(message))
    transport.onClose(reason => this.fail(reason))
  }

  /** What the server called itself, for the tool prefix and for error text. */
  get name(): string {
    return this.serverName
  }

  private receive(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      const entry = this.pending.get(message.id)
      // A response to a request we gave up on. A timed-out request is taken out
      // of `pending` before its cancellation goes out, so its late answer finds
      // nothing here and is dropped, which is exactly what the spec asks the
      // sender of a cancellation to do.
      if (entry === undefined) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) {
        entry.reject(new McpProtocolError(`${entry.method}: ${message.error.message}`, message.error.code))
        return
      }
      entry.resolve(message.result)
      return
    }

    if ('method' in message && message.method === 'notifications/tools/list_changed') {
      // Never cache the catalog past a server saying it changed.
      this.catalog = null
    }
    // Every other server-initiated message is a notification this client does
    // not act on. A tools-only client answers no server requests.
  }

  private fail(reason: string): void {
    this.closedReason = reason
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new ConnectionClosedError(`${entry.method}: ${reason}`))
      this.pending.delete(id)
    }
  }

  private async request(method: string, params?: unknown, deadline = this.timeout): Promise<unknown> {
    if (this.closedReason !== null) throw new ConnectionClosedError(this.closedReason)
    const id = this.nextId
    this.nextId += 1

    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // Advisory, and the spec says so: the server may finish anyway. The
        // point is that this side stops waiting.
        //
        // `initialize` is the exception the spec names outright, and may never
        // be cancelled by the client. A server that has not finished the
        // handshake has no session in which to read the notification anyway.
        if (method !== 'initialize') {
          void this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' }).catch(() => undefined)
        }
        reject(new RequestTimeoutError(method, deadline))
      }, deadline)
      this.pending.set(id, { method, resolve, reject, timer })
    })

    try {
      await this.transport.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    } catch (err) {
      const entry = this.pending.get(id)
      if (entry !== undefined) {
        clearTimeout(entry.timer)
        this.pending.delete(id)
      }
      throw err
    }
    return answer
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    await this.transport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  /**
   * `initialize` is the first message on the wire and is never batched with
   * anything else. The client offers the newest version it knows; the server
   * answers with the version it will actually speak, and one this client cannot
   * speak is a disconnect and never a hopeful guess.
   */
  async connect(): Promise<void> {
    await this.transport.start()
    // Past this point the transport owns something, a subprocess or a session
    // on a remote server, and every exit from here gives it back. A failed
    // handshake that leaves the child running is a process nobody will ever
    // close, because the only reference to it was this rejected promise.
    try {
      const result = await this.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          // No sampling and no roots: this client cannot serve either, and
          // claiming a capability it does not have earns requests it must refuse.
          capabilities: {},
          clientInfo: {
            name: this.options.clientName ?? 'nanoharness',
            version: this.options.clientVersion ?? '0.0.1',
          },
        },
        this.connectTimeout,
      )

      if (!isJsonObject(result)) throw new McpProtocolError('initialize did not answer with an object')
      const version = result.protocolVersion
      if (typeof version !== 'string' || !SUPPORTED_VERSIONS.includes(version)) {
        throw new McpProtocolError(`server speaks protocol ${String(version)}, which this client does not`)
      }
      const info = result.serverInfo
      if (isJsonObject(info) && typeof info.name === 'string') this.serverName = info.name

      // From here on every request has to carry the version that was agreed,
      // starting with the notification below, which is already a message after
      // initialization. The transport is what writes headers and has no way to
      // learn the version on its own.
      this.transport.setProtocolVersion?.(version)
      await this.notify('notifications/initialized')
    } catch (err) {
      await this.close().catch(() => undefined)
      throw err
    }
  }

  /**
   * The whole catalog, following `nextCursor` to the end. Cached until the
   * server says it changed: a re-list on every turn would be a request per
   * turn for a list that almost never moves.
   */
  async listTools(): Promise<McpTool[]> {
    if (this.catalog !== null) return this.catalog
    const tools: McpTool[] = []
    let cursor: string | undefined
    // A server that keeps handing back a cursor would page forever; the tool
    // list of a real server is tens of entries, so this is a bug stop.
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor })
      if (!isJsonObject(result)) throw new McpProtocolError('tools/list did not answer with an object')
      const listed = Array.isArray(result.tools) ? result.tools : []
      for (const raw of listed) {
        if (!isJsonObject(raw) || typeof raw.name !== 'string') continue
        tools.push({
          name: raw.name,
          description: typeof raw.description === 'string' ? raw.description : '',
          inputSchema: isJsonObject(raw.inputSchema) ? raw.inputSchema : { type: 'object' },
        })
      }
      const next = result.nextCursor
      if (typeof next !== 'string' || next === '') break
      cursor = next
    }
    this.catalog = tools
    return tools
  }

  /**
   * Call a tool. A server-reported failure comes back as a result with
   * `isError`, not as a thrown error: it is the model's to read and correct.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    if (!isJsonObject(result)) throw new McpProtocolError(`${name} did not answer with a result object`)
    return { text: flatten(result), isError: result.isError === true }
  }

  async close(): Promise<void> {
    this.fail('closed')
    await this.transport.close()
  }
}

/**
 * A `CallToolResult` as one string. Text blocks are the payload; an image or an
 * audio block becomes a note that one arrived, because a tool result reaches
 * the model as text and a base64 payload in the transcript is thousands of
 * tokens of nothing. `structuredContent` wins when there is no text at all.
 */
export function flatten(result: Record<string, unknown>): string {
  const blocks = Array.isArray(result.content) ? result.content : []
  const parts: string[] = []
  for (const block of blocks) {
    if (!isJsonObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted: this harness passes tool results as text]')
    else if (block.type === 'audio') parts.push('[audio omitted: this harness passes tool results as text]')
    else if (block.type === 'resource_link' && typeof block.uri === 'string') parts.push(`[resource ${block.uri}]`)
    else if (block.type === 'resource' && isJsonObject(block.resource)) {
      const text = block.resource.text
      parts.push(typeof text === 'string' ? text : `[resource ${String(block.resource.uri ?? 'embedded')}]`)
    }
  }
  const text = parts.join('\n').trim()
  if (text !== '') return text
  if (isJsonObject(result.structuredContent)) return JSON.stringify(result.structuredContent)
  return '(the tool returned nothing)'
}
