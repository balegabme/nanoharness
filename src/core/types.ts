// doc: docs/harness/overview.md
import type { JobView } from './jobs.js'


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

/**
 * One MCP server as the window shows it. It lives here rather than in the MCP
 * layer because an event carries it, and `AppEvent` is the one shape both the
 * main process and the renderer agree on.
 */
export interface McpServerStatus {
  name: string
  connected: boolean
  toolCount: number
  /** Why it is not connected, in the words the user needs to fix it. */
  error?: string
  /**
   * Read from the config rather than from a live connection: the session has
   * not been built yet, so nothing has been dialled.
   */
  pending?: boolean
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
  // Something about the run rather than about the conversation: a loop the
  // harness broke, a turn that ended without an answer, a background job that
  // reported back. A turn never ends without one of these or an answer.
  | { type: 'session.note'; sessionId: string; turn: number; text: string; at: number }
  | { type: 'permission.request'; sessionId: string; id: string; intent: 'read' | 'write' | 'run'; paths: string[]; root: string; at: number }
  // Which MCP servers this session ended up with, once its hub has finished
  // dialling. The window asks for the same thing when a session is opened; this
  // is the push for the case where the answer arrives after the question.
  | { type: 'mcp.status'; sessionId: string; servers: McpServerStatus[]; live: boolean; at: number }
  // A subagent, background or foreground. Its own stream events are the ones
  // above, emitted under `sessionId` = the job's id, so the window can show a
  // subagent working with the same blocks it draws the main agent with.
  | { type: 'job.started'; job: JobView; at: number }
  | { type: 'job.update'; jobId: string; note: string; at: number }
  | { type: 'job.finished'; job: JobView; at: number }

/**
 * A line the window showed that is not a message: an error, a stop, a note the
 * harness wrote about the run. Stored with the transcript, because a re-opened
 * session that shows only the messages is not what the user saw: a turn the
 * harness cut short would come back looking like a turn that simply ended.
 *
 * `after` is how many messages had been written when it happened, which is what
 * puts it back in the right place on replay.
 */
export interface SessionNote {
  kind: 'error' | 'stopped' | 'note'
  text: string
  turn: number
  after: number
  at: number
}

export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; toolCalls?: ToolCall[]; thinking?: ThinkingBlock[] }
  | { role: 'tool'; content: string; toolCallId: string; failed?: boolean }

export type ChatChunk =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  // The finished block, emitted once the model closes it. Anthropic signs it,
  // and a signed one is handed back on the next request; an OpenAI-wire one
  // carries no signature and is kept for the window and the transcript only.
  | { kind: 'thinking_block'; block: ThinkingBlock }
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'done'; usage: TurnUsage }
  | { kind: 'error'; message: string }