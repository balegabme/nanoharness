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
  /**
   * Calls the permission system stopped, whoever stopped them: the approval
   * model in auto mode, or the person at the dialog. Counted apart from
   * `failed`, which is the work going wrong rather than the harness doing its
   * job.
   */
  prevented: number
}

export function emptyToolStats(): ToolStats {
  return { calls: 0, ok: 0, failed: 0, prevented: 0 }
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
  /**
   * The call never ran because the permission system refused it. Set only by
   * the gate's own refusals. A tool that failed on its own, on a missing file
   * or a non-zero exit, is not counted as something the harness stopped.
   */
  prevented?: boolean
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
 * Cached input over all the input that went into the prompt. Cache writes count
 * in the denominator because the provider read them in full and charged a
 * premium: a turn that read 20k cached and wrote 5k new is four fifths cache,
 * not 99.9%. `null` is "no prompt yet", which is not the same as a 0% hit.
 */
export function cacheHitRate(usage: TurnUsage): number | null {
  const prompt = usage.cacheRead + usage.input + usage.cacheWrite
  return prompt === 0 ? null : usage.cacheRead / prompt
}

/**
 * A block of the model's own reasoning. Anthropic signs each one and requires
 * it back unmodified and in order, so the signature travels with the text
 * instead of being thrown away once it has been shown.
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
  // `streamMs` is first chunk to last, with no tool time in it. Absent on a
  // subagent's usage: that total came off a stream nobody timed here.
  // `subagent` and `harness` are the parts of `usage` spent by subagents and by
  // the harness's own side-calls. Both are inside the total, because the user
  // pays for them, and named so the counter is accountable. `harnessCostUsd`
  // comes with the latter: those calls run at their own models' prices, which
  // the window cannot get from the session's model facts.
  | { type: 'usage'; sessionId: string; turn: number; usage: TurnUsage; subagent?: TurnUsage; harness?: TurnUsage; harnessCostUsd?: number; streamMs?: number; at: number }
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
  // What the turn that just ended came to: its tool calls, the files it left
  // different, and how long it ran. The window draws it under the answer,
  // where a note is drawn in the flow.
  | { type: 'session.summary'; sessionId: string; turn: number; text: string; prevented?: PreventedCall[]; at: number }
  // `problem` is set when auto mode was on and the approval model could not
  // answer. The prompt is the fallback and says so on its face.
  | { type: 'permission.request'; sessionId: string; id: string; intent: 'read' | 'write' | 'run'; paths: string[]; command?: string; root: string; problem?: string; at: number }
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
 * harness wrote about the run. Stored with the transcript. `after` is the
 * message count when it happened, which replays it in place.
 */
/**
 * One call the permission system stopped, as the summary line lists it. The
 * reason is the refusal the agent was given, verbatim.
 */
export interface PreventedCall {
  tool: string
  /** The path or command it was about, redacted. Empty when the tool named none. */
  target: string
  reason: string
  at: number
}

export interface SessionNote {
  kind: 'error' | 'stopped' | 'note' | 'summary'
  text: string
  turn: number
  after: number
  at: number
  /** On a summary: what the turn was stopped from doing. Absent when nothing was. */
  prevented?: PreventedCall[]
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
  // be read: the answer stands and this turn's cost is unknown.
  // `usage` is a running total rather than a delta, so a request that breaks
  // halfway can still say what it charged for.
  | { kind: 'usage'; usage: TurnUsage }
  | { kind: 'done'; usage: TurnUsage; usageProblem?: string }
  // `status` is the HTTP status the failure would have carried had it arrived
  // as one. A stream that breaks halfway is reported inside the stream, with
  // 200 already on the response, so without this the session cannot tell an
  // overloaded provider from a malformed request. See `isRetryable`.
  | { kind: 'error'; message: string; status?: number }