import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResponsesProvider, toWireInput } from './responses.js'
import type { ChatChunk, ChatMessage } from '../core/types.js'

/**
 * The Responses wire. Everything below is shaped the way a live endpoint sent
 * it: named events in the `type` field of each `data:` line, a transcript that
 * is a flat list of items rather than a list of messages, and a usage report
 * under different names for the same arithmetic the other wire does.
 */

function sse(lines: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      // Each event arrives as the endpoint writes it: a named `event:` line,
      // the payload, and a blank line. The reader is meant to ignore the first.
      for (const line of lines) controller.enqueue(encoder.encode(`event: x\ndata: ${line}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** What went out on the wire, once a stream has been read to the end. */
let sent: Record<string, unknown> = {}

function stream(events: readonly unknown[], input: Partial<Parameters<ReturnType<typeof createResponsesProvider>['stream']>[0]> = {}): AsyncGenerator<ChatChunk> {
  vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
    sent = JSON.parse(init.body) as Record<string, unknown>
    return Promise.resolve(sse(events.map(event => JSON.stringify(event))))
  })
  const provider = createResponsesProvider({ apiKey: 'k', baseURL: 'https://example.invalid/v1' })
  return provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], ...input })
}

async function collect(chunks: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

function doneOf(chunks: readonly ChatChunk[]): Extract<ChatChunk, { kind: 'done' }> {
  const found = chunks.find((chunk): chunk is Extract<ChatChunk, { kind: 'done' }> => chunk.kind === 'done')
  if (found === undefined) throw new Error('the stream never finished')
  return found
}

const USAGE = {
  input_tokens: 299,
  output_tokens: 63,
  total_tokens: 362,
  input_tokens_details: { cached_tokens: 128 },
  output_tokens_details: { reasoning_tokens: 51 },
}

const CALL = {
  id: 'fc_1',
  type: 'function_call',
  status: 'completed',
  name: 'get_weather',
  call_id: 'call-abc',
  arguments: '{"city":"Oslo"}',
}

function completed(usage: unknown = USAGE): unknown {
  return { type: 'response.completed', response: { status: 'completed', usage } }
}

afterEach(() => void vi.unstubAllGlobals())

describe('reading a Responses stream', () => {
  it('reads the answer and the summary of the thinking apart', async () => {
    const chunks = await collect(
      stream([
        { type: 'response.reasoning_summary_text.delta', delta: 'The user ' },
        { type: 'response.reasoning_summary_text.delta', delta: 'said hello.' },
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: 'there.' },
        completed(),
      ]),
    )
    expect(chunks.filter(c => c.kind === 'text').map(c => c.text).join('')).toBe('Hello there.')
    expect(chunks.filter(c => c.kind === 'thinking').map(c => c.text).join('')).toBe('The user said hello.')
    // The whole of it once more at the end, so the transcript keeps a block
    // rather than the deltas it was drawn from.
    expect(chunks.find(c => c.kind === 'thinking_block')?.block).toEqual({ kind: 'thinking', text: 'The user said hello.' })
  })

  it('takes a tool call off the finished item rather than the fragments', async () => {
    const chunks = await collect(
      stream([
        { type: 'response.function_call_arguments.delta', delta: '{"city"' },
        { type: 'response.function_call_arguments.delta', delta: ':"Oslo"}' },
        { type: 'response.output_item.done', item: CALL },
        completed(),
      ]),
    )
    const calls = chunks.filter(c => c.kind === 'tool').map(c => c.tool)
    expect(calls).toEqual([{ id: 'call-abc', name: 'get_weather', args: '{"city":"Oslo"}' }])
  })

  it('reads the call id the wire pairs a result by, not the item id', async () => {
    const chunks = await collect(stream([{ type: 'response.output_item.done', item: CALL }, completed()]))
    expect(chunks.find(c => c.kind === 'tool')?.tool.id).toBe('call-abc')
  })

  it('passes over the items that are not tool calls', async () => {
    const chunks = await collect(
      stream([
        { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', summary: [] } },
        { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', role: 'assistant' } },
        completed(),
      ]),
    )
    expect(chunks.filter(c => c.kind === 'tool')).toHaveLength(0)
  })
})

describe('what a Responses turn charged', () => {
  it('counts the cached tokens apart from the ones read in full', async () => {
    const { usage } = doneOf(await collect(stream([completed()])))
    // 299 read, 128 of them cached, so 171 fresh. Reasoning is a breakdown of
    // the output rather than something to add to it.
    expect(usage).toEqual({ input: 171, output: 63, cacheRead: 128, cacheWrite: 0, reasoning: 51 })
  })

  it('reads a turn cut short the same way, since it spent what it spent', async () => {
    const { usage } = doneOf(await collect(stream([{ type: 'response.incomplete', response: { status: 'incomplete', usage: USAGE } }])))
    expect(usage.output).toBe(63)
  })

  it('settles the missing details objects at zero', async () => {
    const { usage } = doneOf(await collect(stream([completed({ input_tokens: 10, output_tokens: 4 })])))
    expect(usage).toEqual({ input: 10, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  })

  it('keeps the answer and says the cost is unknown when the report cannot be read', async () => {
    const chunks = await collect(
      stream([{ type: 'response.output_text.delta', delta: 'hi' }, completed({ output_tokens: 4 })]),
    )
    const done = doneOf(chunks)
    expect(chunks.some(c => c.kind === 'text')).toBe(true)
    expect(done.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(done.usageProblem).toBe('usage arrived without input_tokens')
  })

  it('refuses a report claiming more cached tokens than it read', async () => {
    const done = doneOf(await collect(stream([completed({ input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 99 } })])))
    expect(done.usageProblem).toBe('provider reported 99 cached tokens against a prompt of 10')
  })

  it('takes a server with nothing to report at its word', async () => {
    const done = doneOf(await collect(stream([completed(null)])))
    expect(done.usageProblem).toBeUndefined()
    expect(done.usage.output).toBe(0)
  })
})

describe('a Responses stream that gives up after answering 200', () => {
  it('reports the failure rather than finishing quietly', async () => {
    const chunks = await collect(
      stream([{ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'Upstream request failed.' } } }]),
    )
    const failure = chunks.find(c => c.kind === 'error')
    expect(failure?.message).toContain('Upstream request failed.')
    // Nothing on this wire says which failures are worth asking again for, and
    // a stream that broke mid-answer is the provider's to explain.
    expect(failure?.status).toBe(500)
  })

  it('reads a bare error event, which carries its message at the top level', async () => {
    const chunks = await collect(stream([{ type: 'error', code: 'rate_limit', message: 'slow down' }]))
    expect(chunks.find(c => c.kind === 'error')?.message).toBe('provider stream failed (rate_limit): slow down')
  })
})

describe('what a Responses request asks for', () => {
  it('leaves the conversation with the harness', async () => {
    await collect(stream([completed()]))
    expect(sent.store).toBe(false)
  })

  it('names the effort level, and leaves the field out for none', async () => {
    await collect(stream([completed()], { effort: 'high' }))
    expect(sent.reasoning).toEqual({ effort: 'high' })
    await collect(stream([completed()], { effort: 'none' }))
    expect(sent.reasoning).toBeUndefined()
  })

  it('writes a tool definition flat, where the other wire nests it', async () => {
    const tools = [{ name: 'read', description: 'Read a file.', inputSchema: { type: 'object' as const, properties: {} } }]
    await collect(stream([completed()], { tools }))
    expect(sent.tools).toEqual([{ type: 'function', name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }])
  })
})

describe('the transcript as this wire wants it', () => {
  it('sends a turn as a role with its content, going up and coming back', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi.' },
      { role: 'assistant', content: 'Hello.' },
    ]
    expect(toWireInput(messages)).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: 'Be brief.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Hi.' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] },
    ])
  })

  it('unfolds a tool round into loose items paired by call id', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'Let me look.', toolCalls: [{ id: 'call-1', name: 'read', args: '{}' }] },
      { role: 'tool', content: 'file contents', toolCallId: 'call-1' },
    ]
    expect(toWireInput(messages)).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'Let me look.' }] },
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'file contents' },
    ])
  })

  it('sends no message item for a turn that only called tools', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read', args: '{}' }] }]
    // An empty message item would be a turn the model never took.
    expect(toWireInput(messages)).toEqual([{ type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' }])
  })

  it('leaves thinking behind, since the wire hands out a summary and no signature', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'Hello.', thinking: [{ kind: 'thinking', text: 'they said hi' }] }]
    expect(JSON.stringify(toWireInput(messages))).not.toContain('they said hi')
  })
})
