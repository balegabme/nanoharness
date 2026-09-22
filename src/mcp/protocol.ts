// doc: docs/harness/mcp.md

/**
 * JSON-RPC 2.0 as MCP uses it, and the two failure kinds that must never be
 * confused (plan §7).
 *
 * A protocol error is a bug in this client or that server: a bad envelope, an
 * unknown method, a malformed parameter. The model never sees one; there is
 * nothing it could do about it. A tool-domain failure is the server saying "the
 * search found nothing" or "that path does not exist", and it arrives inside a
 * perfectly valid result with `isError: true`. That one goes straight to the
 * model, which is the only party who can act on it.
 */

/** The version this client asks for. A server may answer with an older one. */
export const PROTOCOL_VERSION = '2025-06-18'

/** Versions this client can actually speak if a server downgrades us. */
export const SUPPORTED_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** A malformed envelope, an unknown method, a `-326xx`: this client's problem. */
export class McpProtocolError extends Error {
  readonly code: number

  constructor(message: string, code = -32603) {
    super(message)
    this.name = 'McpProtocolError'
    this.code = code
  }
}

/** A request that outlived its deadline. Distinct from a dropped transport. */
export class RequestTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`${method} did not answer within ${ms}ms`)
    this.name = 'RequestTimeoutError'
  }
}

/** The transport went away with requests still outstanding. */
export class ConnectionClosedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ConnectionClosedError'
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one line or one SSE `data:` payload as a JSON-RPC message. Anything that
 * is not a JSON-RPC envelope is dropped and never thrown: a server is allowed
 * to be chatty on the same channel, and one stray line must not kill a session.
 */
export function parseMessage(raw: string): JsonRpcMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isJsonObject(parsed) || parsed.jsonrpc !== '2.0') return null
  if (typeof parsed.id === 'number') {
    if (typeof parsed.method === 'string') return parsed as unknown as JsonRpcRequest
    return parsed as unknown as JsonRpcResponse
  }
  if (typeof parsed.method === 'string') return parsed as unknown as JsonRpcNotification
  return null
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && typeof (message as JsonRpcResponse).id === 'number' && !('method' in message)
}
