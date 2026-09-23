// doc: docs/harness/providers.md
import { BAD_SSE, NO_BODY, ProviderError, StreamBrokenError, retryAfterMs } from '../core/provider.js'
import type { ChatProvider, ChatInput } from '../core/provider.js'
import type { ChatChunk, ChatMessage, JsonSchema, ToolCall, ToolInput, TurnUsage } from '../core/types.js'
import { dataUrl, emptyUsage } from '../core/types.js'
import { endpointURL } from '../core/config.js'
import { wireHeaders } from './headers.js'

/**
 * The Responses wire.
 *
 * A third format beside `/chat/completions` and `/messages`, and far enough
 * from the first that it could not be a branch inside `openai.ts`: the request
 * carries `input` where the other carries `messages`, a tool definition is
 * flat and not nested under `function`, and the stream is a sequence of named
 * events in place of deltas hanging off a choice. The reader below keys off
 * the `type` field inside each `data:` payload, so the `event:` lines beside
 * them are read past and never parsed a second time.
 *
 * Token counting is the same arithmetic the other wire does, and
 * `providers.md` has the whole of it.
 */

interface ResponsesOptions {
  apiKey: string
  baseURL: string
  /** Where this endpoint wants the conversation id. See `wireHeaders`. */
  sessionHeader?: string
}

/** One piece of a message: text, or a picture the user sent. */
type WirePart = { type: 'input_text' | 'output_text'; text: string } | { type: 'input_image'; image_url: string }

/** A turn going out: a role with what it said, or one half of a tool round. */
type WireItem =
  | { role: 'system' | 'user' | 'assistant'; content: WirePart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

interface WireToolDef {
  type: 'function'
  name: string
  description: string
  parameters: JsonSchema & { type: 'object' }
}

interface WireRequest {
  model: string
  input: WireItem[]
  tools: WireToolDef[]
  stream: true
  /**
   * The conversation stays here. Left on, the endpoint keeps the turn and hands
   * back an id to carry on from, which would make it the owner of a transcript
   * the harness already has on disk.
   */
  store: false
  reasoning?: { effort: string }
}

/** An item the model has finished. Only the tool calls are read off it. */
interface WireDoneItem {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
}

interface WireEvent {
  type?: string
  /** The text of a delta, on the events that carry one. */
  delta?: string
  item?: WireDoneItem
  /** The whole response, on the events that report the end of one. */
  response?: { usage?: unknown; error?: unknown }
  /** Set on a bare `error` event, which reports the request and not a turn. */
  message?: string
  code?: string
}

// After `parseUsage` has read it: the totals are there and the optional fields
// are resolved to numbers, so nothing downstream needs a fallback.
interface WireUsage {
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  reasoning_tokens: number
}

export function createResponsesProvider(opts: ResponsesOptions): ChatProvider {
  return {
    async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
      const body: WireRequest = {
        model: input.model,
        input: toWireInput(input.messages),
        tools: input.tools.map(toWireTool),
        stream: true,
        store: false,
      }
      // As on the other wire, "none" leaves the field out and asserts no level
      // the model may not have. Left out is what this wire reads as the
      // model's own default.
      if (input.effort !== undefined && input.effort !== 'none') body.reasoning = { effort: input.effort }
      const res = await fetch(endpointURL(opts.baseURL, 'v1', 'responses'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
          ...wireHeaders(opts.sessionHeader, input.conversationId),
        },
        body: JSON.stringify(body),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new ProviderError(`provider ${res.status}: ${text.slice(0, 200)}`, res.status, retryAfterMs(res.headers.get('retry-after')))
      }
      if (!res.body) throw new StreamBrokenError(NO_BODY)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let usage: TurnUsage = emptyUsage()
      /** Why a usage report could not be read, if one could not. */
      let usageProblem: string | undefined
      const calls: ToolCall[] = []
      /**
       * The round's reasoning, kept so the transcript has it. What arrives here
       * is the summary the model wrote of its own thinking and not the
       * thinking itself, and it carries no signature, so as on the other wire
       * the block is for the window and the stored transcript alone.
       */
      let reasoning = ''

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const event = parseWire(line)
            if (event === null) continue
            switch (event.type) {
              case 'response.output_text.delta':
                if (event.delta) yield { kind: 'text', text: event.delta }
                break
              case 'response.reasoning_summary_text.delta':
                if (event.delta) {
                  reasoning += event.delta
                  yield { kind: 'thinking', text: event.delta }
                }
                break
              case 'response.output_item.done': {
                // The finished item carries its arguments in full, so the
                // fragments streamed ahead of it are read past and never
                // reassembled.
                const call = toolCallOf(event.item)
                if (call !== null) calls.push(call)
                break
              }
              // A turn cut short still spent what it spent, and the log it goes
              // to is append-only, so its report is read like any other.
              case 'response.completed':
              case 'response.incomplete': {
                const read = readUsage(event.response?.usage)
                if (read.usage !== undefined) usage = read.usage
                if (read.problem !== undefined) usageProblem ??= read.problem
                break
              }
              // A stream that has already answered 200 and then gives up is
              // the provider's fault as far as asking again goes, which is what
              // an unlisted status means everywhere else. See `isRetryable`.
              case 'response.failed':
              case 'error':
                yield { kind: 'error', message: failureText(event), status: 500 }
                break
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      // Before the tool calls, in the order the model produced it.
      if (reasoning !== '') yield { kind: 'thinking_block', block: { kind: 'thinking', text: reasoning } }
      for (const call of calls) yield { kind: 'tool', tool: call }
      // A round whose usage could not be read still has its answer and tool
      // calls; the reason rides out here so the session can record it.
      yield { kind: 'done', usage, ...(usageProblem === undefined ? {} : { usageProblem }) }
    },
  }
}

/**
 * The transcript as this wire wants it.
 *
 * A tool round is two loose items and not a message with the calls hanging
 * off it, so one assistant turn can expand into several entries: what it said,
 * then one `function_call` for each tool it asked for. An assistant turn that
 * said nothing and only called tools contributes no message item, since an
 * empty one would be a turn the model never took. Thinking does not go back,
 * because this wire hands out a summary and has nothing to verify it against.
 */
export function toWireInput(messages: readonly ChatMessage[]): WireItem[] {
  const items: WireItem[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
      continue
    }
    // Pictures go ahead of the words about them.
    const content: WirePart[] = (m.images ?? []).map(image => ({ type: 'input_image', image_url: dataUrl(image) }))
    if (m.content !== '') content.push({ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content })
    if (content.length > 0) items.push({ role: m.role, content })
    for (const call of m.toolCalls ?? []) {
      items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.args })
    }
  }
  return items
}

function toWireTool(t: ToolInput): WireToolDef {
  return { type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }
}

/** The call an output item describes, where the item describes one. */
function toolCallOf(item: WireDoneItem | undefined): ToolCall | null {
  if (item?.type !== 'function_call') return null
  const { call_id, name, arguments: args } = item
  if (typeof call_id !== 'string' || typeof name !== 'string') return null
  return { id: call_id, name, args: typeof args === 'string' ? args : '' }
}

/**
 * What a failure event says, in whichever of the two places it says it. A bare
 * `error` event describes the request and carries its own message; a
 * `response.failed` describes the turn and carries the message under the
 * response it ended.
 */
function failureText(event: WireEvent): string {
  const nested = isObject(event.response?.error) ? event.response.error.message : undefined
  const message = typeof nested === 'string' ? nested : event.message
  const code = event.code === undefined ? '' : ` (${event.code})`
  return `provider stream failed${code}: ${message ?? 'the provider gave no reason'}`
}

function parseWire(line: string): WireEvent | null {
  const data = line.slice(5).trim()
  if (data === '' || data === '[DONE]') return null
  try {
    return JSON.parse(data) as WireEvent
  } catch {
    throw new StreamBrokenError(BAD_SSE)
  }
}

/**
 * `input` means the same thing on both wires: prompt tokens the provider had to
 * read in full, with the cached ones counted separately. `input_tokens` is the
 * whole prompt with the cached part inside it, so the cached half is subtracted
 * out here. `output_tokens` already contains the reasoning tokens, so
 * `reasoning` is a breakdown of `output` and is never added on top.
 */
function usageFromWire(u: WireUsage): TurnUsage {
  return {
    input: u.input_tokens - u.cached_tokens,
    output: u.output_tokens,
    cacheRead: u.cached_tokens,
    // This wire names no cache write and bills one at the ordinary input rate,
    // so there is nothing to report. Anthropic is the one that charges a
    // premium for the write and counts it apart.
    cacheWrite: 0,
    reasoning: u.reasoning_tokens,
  }
}

/** A usage object that cannot be read as numbers. */
class UsageError extends Error {}

/**
 * The turn's usage, or the reason it could not be read. A report that cannot be
 * read does not take the answer down with it: the text and the tool calls have
 * already arrived, and the session records that this turn's cost is unknown.
 */
function readUsage(value: unknown): { usage?: TurnUsage; problem?: string } {
  // A null usage is a server saying it has none, which is not a malformed
  // report; both are distinct from a report that cannot be read.
  if (value === undefined || value === null) return {}
  try {
    return { usage: usageFromWire(parseUsage(value)) }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return { problem: err.message }
  }
}

/**
 * Validate the usage object and resolve its optional fields. The two
 * `*_details` objects are optional, and a server with caching switched off
 * sends no cached count at all; that absence means zero and is settled here. A
 * payload missing its totals, or one reporting more cached tokens than it read,
 * comes back as an error, because the cost goes to an append-only log.
 */
function parseUsage(value: unknown): WireUsage {
  if (!isObject(value)) throw new UsageError('the usage field was not an object')
  const inputTokens = value.input_tokens
  const outputTokens = value.output_tokens
  if (typeof inputTokens !== 'number') throw new UsageError('usage arrived without input_tokens')
  if (typeof outputTokens !== 'number') throw new UsageError('usage arrived without output_tokens')
  if (inputTokens < 0 || outputTokens < 0) throw new UsageError('provider sent a negative token count')
  const cached = countIn(value.input_tokens_details, 'cached_tokens')
  if (cached < 0 || cached > inputTokens) {
    throw new UsageError(`provider reported ${cached} cached tokens against a prompt of ${inputTokens}`)
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_tokens: cached,
    reasoning_tokens: countIn(value.output_tokens_details, 'reasoning_tokens'),
  }
}

/** One count out of a details object, where the object and the count are both optional. */
function countIn(details: unknown, field: string): number {
  if (!isObject(details)) return 0
  const count = details[field]
  if (count === undefined || count === null) return 0
  if (typeof count !== 'number') throw new UsageError(`${field} was not a number`)
  return count
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
