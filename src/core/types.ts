// doc: docs/harness/overview.md

export interface TurnUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface ToolCall {
  id: string
  name: string
  args: string
}

export interface JsonSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
  description?: string
  enum?: (string | number | boolean | null)[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolInput {
  name: string
  description: string
  inputSchema: JsonSchema & { type: 'object' }
}

export interface ToolResult {
  ok: boolean
  summary: string
  content?: string
  isError?: boolean
}

export function emptyUsage(): TurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/**
 * A block of the model's own reasoning. Anthropic signs each one and requires
 * the signed block back, unmodified and in order, on the next request of a turn
 * that used tools - a modified block is a 400. So the signature travels with
 * the text instead of being thrown away once it has been shown.
 */
export type ThinkingBlock =
  | { kind: 'thinking'; text: string; signature?: string }
  | { kind: 'redacted'; data: string }

export type AppEvent =
  | { type: 'session.started'; sessionId: string; cwd: string; at: number }
  | { type: 'text_delta'; sessionId: string; text: string; at: number }
  | { type: 'thinking_delta'; sessionId: string; text: string; at: number }
  | { type: 'tool_call'; sessionId: string; call: ToolCall; at: number }
  | { type: 'tool_result'; sessionId: string; callId: string; result: ToolResult; at: number }
  | { type: 'usage'; sessionId: string; turn: number; usage: TurnUsage; at: number }
  | { type: 'session.error'; sessionId: string; turn: number; message: string; at: number }
  | { type: 'session.finished'; sessionId: string; turn: number; at: number }
  | { type: 'session.stopped'; sessionId: string; turn: number; at: number }
  | { type: 'permission.request'; sessionId: string; id: string; intent: 'read' | 'write' | 'run'; paths: string[]; root: string; at: number }

export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; toolCalls?: ToolCall[]; thinking?: ThinkingBlock[] }
  | { role: 'tool'; content: string; toolCallId: string; failed?: boolean }

export type ChatChunk =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  // The finished, signed block - emitted once the model closes it, so the
  // conversation can hand it back on the next request.
  | { kind: 'thinking_block'; block: ThinkingBlock }
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'done'; usage: TurnUsage }
  | { kind: 'error'; message: string }