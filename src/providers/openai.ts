// doc: docs/harness/providers.md
import { BAD_SSE, NO_BODY, ProviderError, StreamBrokenError, retryAfterMs } from '../core/provider.js'
import type { ChatProvider, ChatInput } from '../core/provider.js'
import type { ChatChunk, ChatMessage, JsonSchema, ToolInput, TurnUsage } from '../core/types.js'
import { emptyUsage } from '../core/types.js'
import { endpointURL } from '../core/config.js'
import { readOffers } from './model-facts.js'
import type { ModelOffer } from '../core/config.js'

interface OpenAIOptions {
  apiKey: string
  baseURL: string
}

interface WireDelta {
  content?: string
  // Thinking has no standard field on this wire. Servers that stream it use
  // one of these two names and the documented shape uses neither, so both
  // spellings are read and the block stays empty where a server streams
  // nothing.
  reasoning_content?: string
  reasoning?: string
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
}

// After `parseUsage` has read it: the totals are there and the optional fields
// are resolved to numbers, so nothing downstream needs a fallback.
interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  reasoning_tokens: number
}

interface WireChunk {
  usage?: WireUsage
  /** A usage report was present and could not be read; the round still stands. */
  usageProblem?: string
  delta?: WireDelta
}

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type WireMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface WireToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: JsonSchema & { type: 'object' } }
}

interface WireRequest {
  model: string
  messages: WireMessage[]
  tools: WireToolDef[]
  stream: true
  stream_options: { include_usage: true }
  reasoning_effort?: string
}

interface PendingTool {
  id: string
  name: string
  args: string
}

export function createOpenAIProvider(opts: OpenAIOptions): ChatProvider {
  return {
    async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
      const body: WireRequest = {
        model: input.model,
        messages: input.messages.map(toWireMessage),
        tools: input.tools.map(toWireTool),
        stream: true,
        // Without this OpenAI streams no usage at all and every turn reads as
        // zero tokens. Compatible servers that do not know the field ignore it.
        stream_options: { include_usage: true },
      }
      // Which values a family accepts varies, and an unknown one is either a
      // 400 or a silent drop, so "none" leaves the field out rather than
      // asserting a level the model may not have (plan §11).
      if (input.effort !== undefined && input.effort !== 'none') body.reasoning_effort = input.effort
      const res = await fetch(endpointURL(opts.baseURL, 'v1', 'chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.apiKey}`,
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
      /** Why a usage chunk could not be read, if one could not. */
      let usageProblem: string | undefined
      const pending = new Map<number, PendingTool>()
      /**
       * The round's reasoning, kept so the transcript has it. This wire carries
       * no signature and `toWireMessage` never sends thinking back, so the block
       * is for the window and the stored transcript alone; nothing else keeps
       * it.
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
            if (line.startsWith('data:')) {
              const event = parseWire(line)
              if (event === null) continue
              const delta = event.delta
              if (delta?.content) yield { kind: 'text', text: delta.content }
              const thinking = delta?.reasoning_content ?? delta?.reasoning
              if (thinking) {
                reasoning += thinking
                yield { kind: 'thinking', text: thinking }
              }
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const entry = pending.get(tc.index) ?? { id: '', name: '', args: '' }
                  if (tc.id) entry.id = tc.id
                  if (tc.function?.name && !entry.name) entry.name = tc.function.name
                  if (tc.function?.arguments) entry.args += tc.function.arguments
                  pending.set(tc.index, entry)
                }
              }
              if (event.usage) usage = usageFromWire(event.usage)
              if (event.usageProblem !== undefined) usageProblem ??= event.usageProblem
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      // Before the tool calls, in the order the model produced it.
      if (reasoning !== '') yield { kind: 'thinking_block', block: { kind: 'thinking', text: reasoning } }
      for (const tc of pending.values()) {
        if (tc.name) yield { kind: 'tool', tool: { id: tc.id, name: tc.name, args: tc.args } }
      }
      // A round whose usage could not be read still has its answer and tool
      // calls; the reason rides out here so the session can record it.
      yield { kind: 'done', usage, ...(usageProblem === undefined ? {} : { usageProblem }) }
    },
  }
}

function toWireMessage(m: ChatMessage): WireMessage {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  }
  if (!m.toolCalls || m.toolCalls.length === 0) {
    return { role: m.role, content: m.content }
  }
  const tool_calls: WireToolCall[] = m.toolCalls.map(tc => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.args },
  }))
  return { role: m.role, content: m.content, tool_calls }
}

function toWireTool(t: ToolInput): WireToolDef {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }
}

function parseWire(line: string): WireChunk | null {
  const data = line.slice(5).trim()
  if (data === '[DONE]') return null
  let json: { choices?: { delta?: WireDelta }[]; usage?: unknown }
  try {
    json = JSON.parse(data)
  } catch {
    throw new StreamBrokenError(BAD_SSE)
  }
  const delta = json.choices?.[0]?.delta
  // A null usage is a server saying it has none, which is not a malformed
  // report; both are distinct from a report that cannot be read.
  let usage: WireUsage | undefined
  let usageProblem: string | undefined
  if (json.usage !== undefined && json.usage !== null) {
    try {
      usage = parseUsage(json.usage)
    } catch (err) {
      if (!(err instanceof UsageError)) throw err
      // The line may carry content as well, and that content is the model's
      // output. The unreadable usage rides beside the delta instead of taking
      // the line down.
      usageProblem = err.message
    }
  }
  if (!delta && usage === undefined && usageProblem === undefined) return null
  const out: WireChunk = {}
  if (usage !== undefined) out.usage = usage
  if (usageProblem !== undefined) out.usageProblem = usageProblem
  if (delta !== undefined) out.delta = delta
  return out
}

/**
 * `input` means the same thing on both wires: prompt tokens the provider had to
 * read in full, with the cached ones counted separately. This wire reports it
 * differently. `prompt_tokens` is the whole prompt with the cached part inside
 * it, so the cached half is subtracted out here. `completion_tokens` already
 * contains the reasoning tokens, so `reasoning` is a breakdown of `output` and
 * is never added on top. `providers.md` has the whole of it.
 */
function usageFromWire(u: WireUsage): TurnUsage {
  return {
    input: u.prompt_tokens - u.cached_tokens,
    output: u.completion_tokens,
    cacheRead: u.cached_tokens,
    // This wire bills cache writes at the ordinary input rate and never names
    // them, so there is nothing to report. Anthropic is the one that charges a
    // premium for the write and counts it apart.
    cacheWrite: 0,
    reasoning: u.reasoning_tokens,
  }
}

/** A usage object that cannot be read as numbers. */
class UsageError extends Error {}

/**
 * Validate the usage object and resolve its optional fields. The two
 * `*_details` objects are optional in the spec, a server with caching switched
 * off sends no cached count at all, and some servers spell that count
 * `prompt_cache_hit_tokens` instead; those absences mean zero and are settled
 * here. A payload missing its totals, or one that reports more cached tokens
 * than prompt tokens, comes back as an error, because the cost goes to an
 * append-only log.
 */
function parseUsage(value: unknown): WireUsage {
  if (!isObject(value)) throw new UsageError('the usage field was not an object')
  const prompt = value.prompt_tokens
  const completion = value.completion_tokens
  if (typeof prompt !== 'number') throw new UsageError('usage arrived without prompt_tokens')
  if (typeof completion !== 'number') throw new UsageError('usage arrived without completion_tokens')
  if (prompt < 0 || completion < 0) throw new UsageError('provider sent a negative token count')
  const cached = cachedTokens(value)
  if (cached < 0 || cached > prompt) {
    throw new UsageError(`provider reported ${cached} cached tokens against a prompt of ${prompt}`)
  }
  const completionDetails = value.completion_tokens_details
  const reasoning = isObject(completionDetails) ? completionDetails.reasoning_tokens : undefined
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: cached,
    reasoning_tokens: typeof reasoning === 'number' ? reasoning : 0,
  }
}

/**
 * The two spellings of the cached count, standard first.
 */
function cachedTokens(u: Record<string, unknown>): number {
  const details = u.prompt_tokens_details
  const standard = isObject(details) ? details.cached_tokens : undefined
  if (standard !== undefined) {
    if (typeof standard !== 'number') throw new UsageError('cached_tokens was not a number')
    return standard
  }
  const hits = u.prompt_cache_hit_tokens
  if (hits !== undefined) {
    if (typeof hits !== 'number') throw new UsageError('prompt_cache_hit_tokens was not a number')
    return hits
  }
  return 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
/**
 * `GET {baseURL}/v1/models`, the setup screen's test call. It doubles as a
 * connection check, because reaching it proves the endpoint answers and the key
 * is accepted. Not every OpenAI-compatible proxy implements it, so a 404 has to
 * read as "this server has no model list", not "your settings are wrong".
 */
export async function listModels(opts: OpenAIOptions, timeoutMs = 15_000): Promise<ModelOffer[]> {
  const res = await fetch(endpointURL(opts.baseURL, 'v1', 'models'), {
    headers: { authorization: `Bearer ${opts.apiKey}` },
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
