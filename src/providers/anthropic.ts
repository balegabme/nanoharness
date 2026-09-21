// doc: docs/harness/providers.md
import { BAD_SSE, NO_BODY, ProviderError, StreamBrokenError, retryAfterMs } from '../core/provider.js'
import type { ChatProvider, ChatInput } from '../core/provider.js'
import type { ChatChunk, ChatMessage, JsonSchema, ThinkingBlock, ToolCall, ToolInput, TurnUsage } from '../core/types.js'
import { emptyUsage } from '../core/types.js'
import { endpointURL } from '../core/config.js'
import { readOffers } from './model-facts.js'
import { wireHeaders } from './headers.js'
import type { Effort, ModelOffer } from '../core/config.js'

interface AnthropicOptions {
  apiKey: string
  baseURL: string
  /** Where this endpoint wants the conversation id. See `wireHeaders`. */
  sessionHeader?: string
}

/**
 * The `anthropic-version` header every request must carry. It is not a "latest"
 * marker that drifts: it names the request/response format, and 2023-06-01 is
 * the one the Messages API documents today. Changing it changes the wire
 * contract, so it is pinned rather than derived.
 */
const VERSION = '2023-06-01'

/**
 * The documented API authenticates with `x-api-key`; several compatible
 * gateways read a bearer token instead. Both headers carry the same key, so one
 * endpoint's convention does not have to be guessed at.
 */
function authHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` }
}

/**
 * Thinking budgets per effort level. The API demands at least 1,024 tokens and
 * a budget strictly below `max_tokens`, so the two are picked together rather
 * than left to collide (plan §11).
 *
 * The scale is the seven levels OpenAI-compatible servers accept, mapped onto
 * budgets: `minimal` is the API floor of 1,024 tokens, `low` through `high`
 * double each other, and the two levels above `high` add 16,384 tokens each.
 *
 * `max_tokens` is the budget plus room for an answer, which on the top two
 * levels is more output than several Claude models will produce. The model's
 * own ceiling is passed in where the endpoint published one, and the request is
 * cut to fit inside it, keeping the answer's room where there is enough to keep
 * and splitting the ceiling down the middle where there is not.
 */
const BUDGETS: Record<Effort, number> = { none: 0, minimal: 1024, low: 4096, medium: 16384, high: 32768, xhigh: 49152, max: 65536 }
const BASE_MAX_TOKENS = 8192
const MIN_BUDGET = 1024

/** The thinking budget for this level on a model that will produce `ceiling` tokens at most. */
export function budgetFor(effort: Effort, ceiling?: number): number {
  const budget = BUDGETS[effort]
  if (budget === 0 || ceiling === undefined || budget + BASE_MAX_TOKENS <= ceiling) return budget
  const spare = ceiling - BASE_MAX_TOKENS
  const room = Math.floor(spare >= MIN_BUDGET ? spare : ceiling / 2)
  // Under the API's floor there is no budget worth sending. Thinking is
  // dropped and the whole ceiling answers.
  return room < MIN_BUDGET ? 0 : room
}

export function maxTokensFor(effort: Effort, ceiling?: number): number {
  const budget = budgetFor(effort, ceiling)
  const wanted = budget === 0 ? BASE_MAX_TOKENS : budget + BASE_MAX_TOKENS
  return ceiling === undefined ? wanted : Math.min(wanted, ceiling)
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface WireMessage {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

interface WireTool {
  name: string
  description: string
  input_schema: JsonSchema & { type: 'object' }
}

interface WireRequest {
  model: string
  max_tokens: number
  messages: WireMessage[]
  stream: true
  system?: string
  tools?: WireTool[]
  thinking?: { type: 'enabled'; budget_tokens: number }
}

interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface StreamEvent {
  type?: string
  index?: number
  message?: { usage?: WireUsage }
  usage?: WireUsage
  error?: { type?: string; message?: string }
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
}

/**
 * The status each documented error type would have arrived as, had the failure
 * happened before the response headers. A mid-stream error comes down the SSE
 * channel with 200 already sent, so the type string is the only thing saying
 * whether sending the request again is worth anything. An unlisted type is read
 * as 500: what breaks halfway through a stream is nearly always the provider
 * having trouble, and a request the provider refuses outright does not get this
 * far.
 */
const ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 403,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
}

interface PendingTool {
  id: string
  name: string
  args: string
}

export function createAnthropicProvider(opts: AnthropicOptions): ChatProvider {
  return {
    async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
      const effort: Effort = input.effort ?? 'medium'
      const budget = budgetFor(effort, input.maxTokens)
      const body: WireRequest = {
        model: input.model,
        // Unlike the OpenAI wire this field is required, and a thinking budget
        // has to stay strictly under it, so both are derived from the effort
        // and from what this model will produce.
        max_tokens: maxTokensFor(effort, input.maxTokens),
        messages: toWireMessages(input.messages),
        stream: true,
      }
      const system = input.messages.find(m => m.role === 'system')?.content
      // The system prompt is a top-level field here, never a message.
      if (system !== undefined && system !== '') body.system = system
      if (input.tools.length > 0) body.tools = input.tools.map(toWireTool)
      if (budget > 0) body.thinking = { type: 'enabled', budget_tokens: budget }

      const res = await fetch(endpointURL(opts.baseURL, 'v1', 'messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': VERSION,
          ...authHeaders(opts.apiKey),
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
      const usage: TurnUsage = emptyUsage()
      // Tool arguments arrive as JSON fragments on the block that started them,
      // so the index is what ties a fragment to its call.
      const pending = new Map<number, PendingTool>()
      const finished: ToolCall[] = []
      // Thinking blocks are collected whole. The API signs each one and refuses
      // a modified block on the next request of a tool-using turn, so the text
      // and its signature are kept together and handed straight back.
      const thinking = new Map<number, ThinkingBlock>()

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            // Named events carry the same payload on their `data:` line, so the
            // `event:` line adds nothing this parser needs.
            if (!line.startsWith('data:')) continue
            const event = parseEvent(line)
            if (event === null) continue

            switch (event.type) {
              case 'message_start':
                applyUsage(usage, event.message?.usage)
                // The prompt's cost, known before a token of the answer has
                // arrived. It is the part a retry pays for twice, so it goes
                // out now rather than at the end the request may not reach.
                yield { kind: 'usage', usage: { ...usage } }
                break
              case 'content_block_start': {
                const block = event.content_block
                if (event.index === undefined) break
                if (block?.type === 'tool_use') {
                  pending.set(event.index, { id: block.id ?? '', name: block.name ?? '', args: '' })
                } else if (block?.type === 'thinking') {
                  thinking.set(event.index, { kind: 'thinking', text: '' })
                } else if (block?.type === 'redacted_thinking') {
                  // Encrypted by the API, unreadable here, and still
                  // required back verbatim, so it is carried, not shown.
                  thinking.set(event.index, { kind: 'redacted', data: block.data ?? '' })
                }
                break
              }
              case 'content_block_delta': {
                const delta = event.delta
                if (delta?.type === 'text_delta' && delta.text) yield { kind: 'text', text: delta.text }
                else if (delta?.type === 'thinking_delta' && delta.thinking) {
                  const block = event.index === undefined ? undefined : thinking.get(event.index)
                  if (block?.kind === 'thinking') block.text += delta.thinking
                  yield { kind: 'thinking', text: delta.thinking }
                } else if (delta?.type === 'signature_delta' && delta.signature !== undefined && event.index !== undefined) {
                  const block = thinking.get(event.index)
                  if (block?.kind === 'thinking') block.signature = (block.signature ?? '') + delta.signature
                } else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined && event.index !== undefined) {
                  const entry = pending.get(event.index)
                  if (entry) entry.args += delta.partial_json
                }
                break
              }
              case 'content_block_stop': {
                if (event.index === undefined) break
                const entry = pending.get(event.index)
                if (entry && entry.name !== '') finished.push({ id: entry.id, name: entry.name, args: entry.args })
                pending.delete(event.index)
                const block = thinking.get(event.index)
                if (block !== undefined) {
                  thinking.delete(event.index)
                  yield { kind: 'thinking_block', block }
                }
                break
              }
              case 'message_delta':
                applyUsage(usage, event.usage)
                yield { kind: 'usage', usage: { ...usage } }
                break
              case 'error':
                yield {
                  kind: 'error',
                  message: event.error?.message ?? 'provider sent an error event',
                  status: ERROR_STATUS[event.error?.type ?? ''] ?? 500,
                }
                break
              default:
                break
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      for (const call of finished) yield { kind: 'tool', tool: call }
      yield { kind: 'done', usage }
    },
  }
}

/**
 * Fold the harness message list into the Anthropic shape: the system prompt is
 * lifted out, tool results become `tool_result` blocks on a user message, and
 * consecutive results merge into one message because the API wants alternating
 * roles.
 */
function toWireMessages(messages: readonly ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      const block: ContentBlock = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = out[out.length - 1]
      if (last?.role === 'user' && last.content.every(b => b.type === 'tool_result')) last.content.push(block)
      else out.push({ role: 'user', content: [block] })
      continue
    }

    const content: ContentBlock[] = []
    // Signed thinking comes first, in the order it was produced: the API
    // verifies the signature and rejects a reordered or edited block outright.
    for (const block of m.thinking ?? []) {
      if (block.kind === 'redacted') content.push({ type: 'redacted_thinking', data: block.data })
      else if (block.signature !== undefined) content.push({ type: 'thinking', thinking: block.text, signature: block.signature })
    }
    if (m.content !== '') content.push({ type: 'text', text: m.content })
    for (const call of m.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseArgs(call.args) })
    }
    if (content.length === 0) continue
    out.push({ role: m.role, content })
  }
  return out
}

/**
 * Tool arguments travel as a JSON string in the harness, but Anthropic wants the
 * parsed object back on replay. A call the model malformed still has to round
 * trip, so it goes back as an empty object rather than throwing mid-conversation.
 */
function parseArgs(args: string): unknown {
  if (args.trim() === '') return {}
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

function toWireTool(t: ToolInput): WireTool {
  return { name: t.name, description: t.description, input_schema: t.inputSchema }
}

function parseEvent(line: string): StreamEvent | null {
  const data = line.slice(5).trim()
  if (data === '') return null
  try {
    return JSON.parse(data) as StreamEvent
  } catch {
    throw new StreamBrokenError(BAD_SSE)
  }
}

/**
 * Usage arrives in two halves, input counts at `message_start` and output
 * counts at `message_delta`, so the totals accumulate instead of overwriting.
 */
function applyUsage(usage: TurnUsage, wire: WireUsage | undefined): void {
  if (!wire) return
  if (wire.input_tokens !== undefined) usage.input = wire.input_tokens
  if (wire.output_tokens !== undefined) usage.output = wire.output_tokens
  if (wire.cache_read_input_tokens !== undefined) usage.cacheRead = wire.cache_read_input_tokens
  if (wire.cache_creation_input_tokens !== undefined) usage.cacheWrite = wire.cache_creation_input_tokens
}

/**
 * `GET {baseURL}/v1/models`, the settings screen's test call, same job as its
 * OpenAI counterpart: reaching it proves the endpoint answers and the key is
 * accepted, and the ids fill the model picker.
 */
export async function listModels(opts: AnthropicOptions, timeoutMs = 15_000): Promise<ModelOffer[]> {
  const res = await fetch(endpointURL(opts.baseURL, 'v1', 'models'), {
    headers: { 'anthropic-version': VERSION, ...authHeaders(opts.apiKey), ...wireHeaders() },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    if (res.status === 404) throw new ProviderError('this server has no /v1/models endpoint (404). Type the model id instead.', 404)
    throw new ProviderError(`provider ${res.status}${detail === '' ? '' : `: ${detail}`}`, res.status)
  }

  const payload: unknown = await res.json()
  if (typeof payload !== 'object' || payload === null) throw new Error('model list was not an object')
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) throw new Error('model list had no `data` array')
  return readOffers(data)
}
