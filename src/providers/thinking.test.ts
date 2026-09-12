import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import type { ChatChunk, ChatMessage } from '../core/types.js'

/**
 * Where the reasoning goes. A model that thinks for twelve thousand tokens and
 * leaves nothing behind is a turn nobody can explain afterwards, which is the
 * whole reason a thinking block is kept, and the reason it must never be sent
 * back to an API that would reject it.
 */

function sse(lines: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function stub(response: () => Response): { body: () => Record<string, unknown> } {
  const seen: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return Promise.resolve(response())
  })
  return { body: () => seen[0] ?? {} }
}

async function drain(stream: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

afterEach(() => void vi.unstubAllGlobals())

describe('thinking on the OpenAI wire', () => {
  it('closes the round\'s reasoning into a block, before the tool call it led to', async () => {
    stub(() =>
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"the config file "}}]}',
        'data: {"choices":[{"delta":{"reasoning":"has a CLI that writes it"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"bash","arguments":"{}"}}]}}]}',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":4}}',
        'data: [DONE]',
      ]),
    )
    const provider = createOpenAIProvider({ apiKey: 'k', baseURL: 'https://example.invalid' })
    const chunks = await drain(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }))

    // Deltas still stream, because that is what the window draws live.
    expect(chunks.filter(c => c.kind === 'thinking').map(c => c.text)).toEqual(['the config file ', 'has a CLI that writes it'])

    const kinds = chunks.map(c => c.kind)
    expect(kinds.indexOf('thinking_block')).toBeLessThan(kinds.indexOf('tool'))
    const block = chunks.find(c => c.kind === 'thinking_block')
    expect(block?.kind === 'thinking_block' && block.block.kind === 'thinking' ? block.block : null).toEqual({
      kind: 'thinking',
      // Whole round, in order, and unsigned: this wire has no signature to give.
      text: 'the config file has a CLI that writes it',
    })
  })

  it('sends nothing back, so a stored block cannot break the next request', async () => {
    const request = stub(() => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: [DONE]']))
    const provider = createOpenAIProvider({ apiKey: 'k', baseURL: 'https://example.invalid' })
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there', thinking: [{ kind: 'thinking', text: 'unsigned reasoning' }] },
    ]
    await drain(provider.stream({ model: 'm', messages: history, tools: [] }))
    expect(JSON.stringify(request.body())).not.toContain('unsigned reasoning')
  })
})

describe('thinking on the Anthropic wire', () => {
  it('sends a signed block back and drops an unsigned one', async () => {
    const request = stub(() =>
      sse(['event: message_stop', 'data: {"type":"message_stop"}']),
    )
    const provider = createAnthropicProvider({ apiKey: 'k', baseURL: 'https://example.invalid' })
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      // A turn taken on an OpenAI-compatible provider, replayed into a session
      // that is now on Anthropic. The API verifies signatures and rejects a
      // thinking block it did not sign, so the unsigned one must not go.
      { role: 'assistant', content: 'first', thinking: [{ kind: 'thinking', text: 'unsigned reasoning' }] },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'second', thinking: [{ kind: 'thinking', text: 'signed reasoning', signature: 'sig' }] },
    ]
    await drain(provider.stream({ model: 'm', messages: history, tools: [] }))

    const body = JSON.stringify(request.body())
    expect(body).not.toContain('unsigned reasoning')
    expect(body).toContain('signed reasoning')
  })
})
