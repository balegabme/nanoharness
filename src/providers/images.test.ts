import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import { createResponsesProvider } from './responses.js'
import type { ChatProvider } from '../core/provider.js'
import type { ChatMessage } from '../core/types.js'

/**
 * A message with a picture, as each wire sends it. A wire that dropped the
 * picture, or sent it as text, would still get an answer, just one about
 * nothing, so the request body itself is what is checked.
 */

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are a test.' },
  {
    role: 'user',
    content: 'what is this?',
    images: [{ id: 'a', mediaType: 'image/png', width: 1, height: 1, data: PIXEL }],
  },
]

/** The JSON body one `stream()` call sent, read from a `fetch` that answers with an empty stream. */
async function sentBody(provider: ChatProvider): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  for await (const chunk of provider.stream({ model: 'm', messages, tools: [] })) void chunk
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a picture on the wire', () => {
  it('goes to a chat-completions endpoint as an image part ahead of the text', async () => {
    const body = await sentBody(createOpenAIProvider({ baseURL: 'https://host/v1', apiKey: 'k' }))
    expect((body.messages as unknown[])[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL}` } },
        { type: 'text', text: 'what is this?' },
      ],
    })
  })

  it('goes to a messages endpoint as a base64 image block ahead of the text', async () => {
    const body = await sentBody(createAnthropicProvider({ baseURL: 'https://host/v1', apiKey: 'k' }))
    expect((body.messages as unknown[])[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } },
        { type: 'text', text: 'what is this?' },
      ],
    })
  })

  it('goes to a responses endpoint as an input image ahead of the text', async () => {
    const body = await sentBody(createResponsesProvider({ baseURL: 'https://host/v1', apiKey: 'k' }))
    expect((body.input as unknown[]).find(item => (item as { role?: string }).role === 'user')).toEqual({
      role: 'user',
      content: [
        { type: 'input_image', image_url: `data:image/png;base64,${PIXEL}` },
        { type: 'input_text', text: 'what is this?' },
      ],
    })
  })
})
