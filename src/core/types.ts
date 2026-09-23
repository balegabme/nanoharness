// doc: docs/harness/overview.md
import type { JobView } from './jobs.js'


export interface TurnUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/**
 * What the model generated in a turn's own rounds and how long it spent
 * generating it, tools excluded. Output over time is the rate the topbar shows.
 */
export interface TurnRate {
  output: number
  streamMs: number
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
   * `failed`: that one is the work going wrong, this one is the harness doing
   * its job.
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
 * One MCP server as the window shows it. It lives here and not in the MCP
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
   * Read from the config, since the session has not been built yet and
   * nothing has been dialled.
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
 * Where the next request's tokens go, part by part. Estimated per part and
 * scaled so the parts add up to `ContextLedger.tokens`.
 */
export interface ContextParts {
  system: number
  tools: number
  user: number
  /** The model's own words and the arguments of its tool calls. */
  assistant: number
  /** Thinking that goes back on the wire. Thinking a wire drops is not counted. */
  thinking: number
  toolResults: number
  summary: number
}

/** Why a compaction ran. */
export type CompactionReason = 'auto' | 'manual' | 'overflow'

/** One compaction, as the context panel lists it. */
export interface CompactionRecord {
  at: number
  reason: CompactionReason
  /** The context in tokens before and after, as the ledger had them. */
  before: number
  after: number
}

/**
 * How big the next request is and how close it is to the model's window. See
 * `docs/harness/context.md` for how each figure is arrived at.
 */
export interface ContextLedger {
  /** The size of the next request as sent, in tokens. */
  tokens: number
  /**
   * What the provider reported for the last request's prompt, when that request
   * still describes what goes out. Null before the first response, and after a
   * compaction until the next one.
   */
  measured: number | null
  /** The estimated part of `tokens`: everything since the measured request, or all of it. */
  estimated: number
  /** The model's window. Null where nobody has said. */
  window: number | null
  /** The most the user lets a context grow to, from settings. Null for no limit. */
  limit: number | null
  /** The window compaction works against: the smaller of the two. Null when neither is known. */
  room: number | null
  /** Tokens kept free for the answer. */
  reserve: number
  /** Room minus reserve. Null with no room, or when the reserve fills it. */
  usable: number | null
  /** The size at which automatic compaction runs. Null with no usable space. */
  threshold: number | null
  /**
   * Provider tokens per estimated token when the ledger was taken, so a
   * session rebuilt from it estimates with the correction it had measured.
   */
  calibration: number
  /** The model `calibration` was measured on. Another model has another tokenizer. */
  model: string
  parts: ContextParts
  /** Whether automatic compaction is on. */
  auto: boolean
  compactions: CompactionRecord[]
  at: number
}

/**
 * A block of the model's own reasoning. Anthropic signs each one and requires
 * it back unmodified and in order, so the signature travels with the text.
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
  // streamed is gone: the window drops it, since the answer that arrives next
  // starts from the top.
  | { type: 'round.retry'; sessionId: string; turn: number; attempt: number; of: number; text: string; at: number }
  | { type: 'session.finished'; sessionId: string; turn: number; at: number }
  | { type: 'session.stopped'; sessionId: string; turn: number; at: number }
  // Something about the run itself, not the conversation: a loop the
  // harness broke, a turn that ended without an answer, a background job that
  // reported back. A turn never ends without one of these or an answer.
  | { type: 'session.note'; sessionId: string; turn: number; text: string; at: number }
  // What the turn that just ended came to: its tool calls, the files it left
  // different, and how long it ran. The window draws it under the answer.
  | { type: 'session.summary'; sessionId: string; turn: number; text: string; prevented?: PreventedCall[]; at: number }
  // `problem` is set when auto mode was on and the approval model could not
  // answer. The prompt is the fallback and says so on its face.
  | { type: 'permission.request'; sessionId: string; id: string; intent: 'read' | 'write' | 'run'; paths: string[]; command?: string; root: string; problem?: string; at: number }
  // Which MCP servers this session ended up with, once its hub has finished
  // dialling. The window asks for the same thing when a session is opened; this
  // is the push for the case where the answer arrives after the question.
  | { type: 'mcp.status'; sessionId: string; servers: McpServerStatus[]; live: boolean; at: number }
  // The context ledger changed: a response measured it, a message grew it, a
  // compaction shrank it, or the model's window was edited.
  | { type: 'context'; sessionId: string; ledger: ContextLedger; at: number }
  // A compaction is under way. The summary is a request of its own and can take
  // as long as a round does, so the window says what the wait is for.
  | { type: 'context.compacting'; sessionId: string; reason: CompactionReason; at: number }
  // A compaction finished. `compacted` is how many messages went into the
  // summary, and `pruned` names the tool calls whose results now go out
  // shortened, so the window can mark their cards. `summary` is the checkpoint
  // the model wrote, absent when only tool results were pruned.
  | {
      type: 'context.compacted'
      sessionId: string
      reason: CompactionReason
      before: number
      after: number
      compacted: number
      pruned: string[]
      summary?: string
      at: number
    }
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

/**
 * What compaction did to a message. `compacted` is folded into a summary and
 * no longer sent; `pruned` is a tool result sent in a shortened form. The
 * message itself is kept whole, so the window can still show it.
 */
export type CompactionMark = 'compacted' | 'pruned'

export type ChatMessage =
  | {
      role: 'system' | 'user' | 'assistant'
      content: string
      toolCalls?: ToolCall[]
      thinking?: ThinkingBlock[]
      compacted?: CompactionMark
      /** A compaction summary, written by the model and sent in place of what it summarises. */
      summary?: true
    }
  | { role: 'tool'; content: string; toolCallId: string; failed?: boolean; compacted?: CompactionMark }

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
  // `usage` is a running total and not a delta, so a request that breaks
  // halfway can still say what it charged for.
  | { kind: 'usage'; usage: TurnUsage }
  | { kind: 'done'; usage: TurnUsage; usageProblem?: string }
  // `status` is the HTTP status the failure would have carried had it arrived
  // as one. A stream that breaks halfway is reported inside the stream, with
  // 200 already on the response, so without this the session cannot tell an
  // overloaded provider from a malformed request. See `isRetryable`.
  | { kind: 'error'; message: string; status?: number }