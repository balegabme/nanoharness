// doc: docs/harness/providers.md
import type { ChatProvider, ChatInput } from '../core/provider.js'
import type { ChatChunk, ChatMessage, JsonSchema, ToolInput, TurnUsage } from '../core/types.js'
import { emptyUsage } from '../core/types.js'
import { endpointURL } from '../core/config.js'

interface OpenAIOptions {
  apiKey: string
  baseURL: string
}

interface WireDelta {
  content?: string
  // Thinking has no standard field on this wire. DeepSeek and vLLM send
  // `reasoning_content`, OpenRouter sends `reasoning`, and OpenAI itself sends
  // neither, so all the known spellings are read and the block simply stays
  // empty where a server streams nothing.
  reasoning_content?: string
  reasoning?: string
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

interface WireChunk {
  usage?: WireUsage
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
      // Which values a family accepts varies, and an unknown one is either a 400
      // or a silent drop, so "none" simply leaves the field out rather than
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
        throw new Error(`provider ${res.status}: ${text.slice(0, 200)}`)
      }
      if (!res.body) throw new Error('no response body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let usage: TurnUsage = emptyUsage()
      const pending = new Map<number, PendingTool>()

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
              if (thinking) yield { kind: 'thinking', text: thinking }
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
            }
          }
        }
      } finally {
        reader.releaseLock()
      }

      for (const tc of pending.values()) {
        if (tc.name) yield { kind: 'tool', tool: { id: tc.id, name: tc.name, args: tc.args } }
      }
      yield { kind: 'done', usage }
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
  let json: { choices?: { delta?: WireDelta }[]; usage?: WireUsage }
  try {
    json = JSON.parse(data)
  } catch {
    throw new Error('provider sent malformed SSE chunk')
  }
  const delta = json.choices?.[0]?.delta
  const usage = json.usage
  if (!delta && !usage) return null
  const out: WireChunk = {}
  if (usage !== undefined) out.usage = usage
  if (delta !== undefined) out.delta = delta
  return out
}

function usageFromWire(u: WireUsage): TurnUsage {
  return {
    input: u.prompt_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
  }
}
/**
 * `GET {baseURL}/v1/models` — the setup screen's test call. It doubles as a
 * connection check, because reaching it proves the endpoint answers and the key
 * is accepted. Not every OpenAI-compatible proxy implements it, so a 404 has to
 * read as "this server has no model list", not "your settings are wrong".
 */
export async function listModels(opts: OpenAIOptions, timeoutMs = 15_000): Promise<string[]> {
  const res = await fetch(endpointURL(opts.baseURL, 'v1', 'models'), {
    headers: { authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    if (res.status === 404) throw new Error(`this server has no /v1/models endpoint (404). Type the model id instead.`)
    throw new Error(`provider ${res.status}${detail === '' ? '' : `: ${detail}`}`)
  }

  const payload: unknown = await res.json()
  if (typeof payload !== 'object' || payload === null) throw new Error('model list was not an object')
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) throw new Error('model list had no `data` array')

  const ids = data
    .map(entry => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}
