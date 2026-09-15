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

/**
 * How much tool work an agent did. A subagent hands back one paragraph, and
 * these three numbers are what that paragraph was built out of: how many calls
 * it took to write, and how many of them came back an error.
 */
export interface ToolStats {
  calls: number
  ok: number
  failed: number
}

export function emptyToolStats(): ToolStats {
  return { calls: 0, ok: 0, failed: 0 }
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
 * The plan's §15 headline metric: cached input over all the input that went
 * into the prompt. Cache writes count in the denominator because they are
 * prompt tokens the provider read in full and charged a premium for: a turn
 * that read 20k cached and wrote 5k new is four fifths cache, not 99.9%.
 *
 * It lives beside `TurnUsage` so the CLI and the window divide the same
 * numbers; a copy per surface is a copy that drifts.
 *
 * The answer only means one thing across providers because `input` is
 * normalized at the provider boundary to exclude whatever was served from
 * cache. `null` is "no prompt yet", which is not the same as a 0% hit.
 */
export function cacheHitRate(usage: TurnUsage): number | null {
  const prompt = usage.cacheRead + usage.input + usage.cacheWrite
  return prompt === 0 ? null : usage.cacheRead / prompt
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
  // `streamMs` is how long the model spent generating the round this event
  // closes: first chunk to last, with no tool time in it. It is absent on a
  // subagent's usage, because that total arrives from a stream nobody timed
  // here and folding it into a rate would divide one agent's tokens by another
  // agent's clock.
  // `subagent` is the part of `usage` that subagents of this session spent.
  // A turn that hands its work to three agents pays for all of them, and
  // without the split the counter reads as one number nobody can account for.
  | { type: 'usage'; sessionId: string; turn: number; usage: TurnUsage; subagent?: TurnUsage; streamMs?: number; at: number }
  | { type: 'session.error'; sessionId: string; turn: number; message: string; at: number }
  // A round is about to be asked for. The window uses it as the boundary it
  // rolls back to when the round has to be asked for again.
  | { type: 'round.started'; sessionId: string; turn: number; at: number }
  // The request failed and is being made again. Whatever this round had already
  // streamed is gone: the window drops it, because the answer that arrives next
  // starts from the top rather than carrying on.
  | { type: 'round.retry'; sessionId: string; turn: number; attempt: number; of: number; text: string; at: number }
  | { type: 'session.finished'; sessionId: string; turn: number; at: number }
  | { type: 'session.stopped'; sessionId: string; turn: number; at: number }
  // Something about the run rather than about the conversation: a loop the
  // harness broke, a turn that ended without an answer, a background job that
  // reported back. A turn never ends without one of these or an answer.
  | { type: 'session.note'; sessionId: string; turn: number; text: string; at: number }
  | { type: 'permission.request'; sessionId: string; id: string; intent: 'read' | 'write' | 'run'; paths: string[]; command?: string; root: string; at: number }
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
  // `usageProblem` is set when the provider sent a usage report that could not
  // be read: the answer stands, this turn's cost is unknown, and the session
  // says so. See `noteUsageProblem` in `session.ts`.
  // What this request has cost so far, as a running total rather than a delta.
  // A wire that knows the prompt's cost before it has finished answering sends
  // it, so a request that breaks halfway can still say what it charged for.
  | { kind: 'usage'; usage: TurnUsage }
  | { kind: 'done'; usage: TurnUsage; usageProblem?: string }
  // `status` is the HTTP status the failure would have carried had it arrived
  // as one. A stream that breaks halfway is reported inside the stream, with
  // 200 already on the response, so without this the session cannot tell an
  // overloaded provider from a malformed request. See `isRetryable`.
  | { kind: 'error'; message: string; status?: number }