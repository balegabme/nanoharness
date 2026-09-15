import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'
import { ProviderError } from '../core/provider.js'
import type { ChatChunk } from '../core/types.js'

/**
 * How a failed request reaches the session. Two things have to survive the trip
 * for a retry to be worth making: whether the failure is the provider's or the
 * request's, and what the attempt had already been charged for. Anthropic
 * reports an overloaded model inside a stream whose status was 200, so neither
 * is readable from the HTTP layer and both are read off the wire instead.
 */

function sse(lines: readonly string[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } })
}

function stream(lines: readonly string[]): AsyncGenerator<ChatChunk> {
  vi.stubGlobal('fetch', () => Promise.resolve(sse(lines)))
  const provider = createAnthropicProvider({ apiKey: 'k', baseURL: 'https://example.invalid' })
  return provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })
}

async function collect(chunks: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

function errorOf(chunks: readonly ChatChunk[]): Extract<ChatChunk, { kind: 'error' }> {
  const found = chunks.find((chunk): chunk is Extract<ChatChunk, { kind: 'error' }> => chunk.kind === 'error')
  if (found === undefined) throw new Error('the stream carried no error chunk')
  return found
}

function errorEvent(type: string): string[] {
  return [`data: ${JSON.stringify({ type: 'error', error: { type, message: `${type} happened` } })}`]
}

afterEach(() => void vi.unstubAllGlobals())

describe('an error event in the middle of an Anthropic stream', () => {
  it('carries the status the same failure would have arrived as', async () => {
    expect(errorOf(await collect(stream(errorEvent('overloaded_error')))).status).toBe(529)
    expect(errorOf(await collect(stream(errorEvent('rate_limit_error')))).status).toBe(429)
    expect(errorOf(await collect(stream(errorEvent('invalid_request_error')))).status).toBe(400)
    expect(errorOf(await collect(stream(errorEvent('authentication_error')))).status).toBe(401)
  })

  it('reads an unlisted type as a provider fault, since that is what breaks a stream', async () => {
    expect(errorOf(await collect(stream(errorEvent('some_new_error')))).status).toBe(500)
  })

  it("keeps the provider's own words", async () => {
    expect(errorOf(await collect(stream(errorEvent('overloaded_error')))).message).toBe('overloaded_error happened')
  })
})

describe('what an attempt had cost when it broke', () => {
  it('is on the wire before the error, because the prompt is billed first', async () => {
    const start = {
      type: 'message_start',
      message: { usage: { input_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 } },
    }
    const chunks = await collect(stream([`data: ${JSON.stringify(start)}`, ...errorEvent('overloaded_error')]))

    const spent = chunks.find((chunk): chunk is Extract<ChatChunk, { kind: 'usage' }> => chunk.kind === 'usage')
    // Without this the retry re-reads a 950-token prompt and the turn's counter
    // says the first read never happened.
    expect(spent?.usage).toMatchObject({ input: 40, cacheRead: 900, cacheWrite: 10 })
    expect(chunks.indexOf(spent as ChatChunk)).toBeLessThan(chunks.indexOf(errorOf(chunks)))
  })
})

describe('a provider that says when to come back', () => {
  it('sends Retry-After out with the error, in seconds or as a date', async () => {
    const refuse = (header: string): Promise<Response> =>
      Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': header } }))

    vi.stubGlobal('fetch', () => refuse('12'))
    const provider = createAnthropicProvider({ apiKey: 'k', baseURL: 'https://example.invalid' })
    const seconds = await collect(provider.stream({ model: 'm', messages: [], tools: [] })).catch((err: unknown) => err)
    expect((seconds as ProviderError).retryAfterMs).toBe(12_000)

    vi.stubGlobal('fetch', () => refuse(new Date(Date.now() + 30_000).toUTCString()))
    const date = await collect(provider.stream({ model: 'm', messages: [], tools: [] })).catch((err: unknown) => err)
    // The header has one-second resolution, so the millisecond count is not exact.
    expect((date as ProviderError).retryAfterMs).toBeGreaterThan(28_000)
    expect((date as ProviderError).retryAfterMs).toBeLessThanOrEqual(30_000)
  })
})
