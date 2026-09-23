import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import { USER_AGENT, wireHeaders } from './headers.js'
import { KNOWN_PROVIDERS, defaultSessionHeader } from './profiles.js'
import { createProvider } from './factory.js'
import { parseHeaderName } from '../core/config.js'
import type { ChatChunk } from '../core/types.js'

/**
 * Who the harness says it is, and which conversation a request belongs to.
 *
 * Both answers travel as headers, and an endpoint that wanted them and did
 * not get them refuses the whole turn, so what goes on the wire is pinned here
 * for both formats.
 */

/** A stream that opens and closes, which both wires read as a round with nothing in it. */
function empty(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The headers one `stream()` call put on its request. */
async function sentHeaders(run: () => AsyncGenerator<ChatChunk>): Promise<Headers> {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => empty())
  vi.stubGlobal('fetch', fetchMock)
  // Drained and not merely started: the request goes out on the first pull.
  for await (const chunk of run()) void chunk
  const init = fetchMock.mock.calls[0]?.[1]
  return new Headers(init?.headers)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wireHeaders', () => {
  it('names the harness and its version', () => {
    expect(USER_AGENT).toMatch(/^nanoharness\/\d+\.\d+\.\d+/)
    expect(wireHeaders()).toEqual({ 'user-agent': USER_AGENT })
  })

  it('sends the conversation id under the name the endpoint asked for', () => {
    expect(wireHeaders('x-session', 'abc')).toEqual({ 'user-agent': USER_AGENT, 'x-session': 'abc' })
  })

  it('sends nothing where either half is missing', () => {
    // An endpoint that named no header has no field to put an id in, and an id
    // that is blank is not an identity. Either way only the agent goes.
    expect(wireHeaders(undefined, 'abc')).toEqual({ 'user-agent': USER_AGENT })
    expect(wireHeaders('x-session', undefined)).toEqual({ 'user-agent': USER_AGENT })
    expect(wireHeaders('  ', 'abc')).toEqual({ 'user-agent': USER_AGENT })
    expect(wireHeaders('x-session', '   ')).toEqual({ 'user-agent': USER_AGENT })
  })
})

describe('parseHeaderName', () => {
  it('keeps a name a request can actually carry', () => {
    expect(parseHeaderName('x-opencode-session')).toBe('x-opencode-session')
    expect(parseHeaderName('  x-session-id  ')).toBe('x-session-id')
    expect(parseHeaderName('X-Session')).toBe('X-Session')
  })

  it('drops anything fetch would throw on', () => {
    // A record holding one of these would fail every turn, with an error about
    // the header, not about the endpoint that wanted it.
    for (const bad of ['x session', 'x:session', 'x\nsession', '', '   ', 42, null, undefined]) {
      expect(parseHeaderName(bad)).toBeUndefined()
    }
  })
})

describe('defaultSessionHeader', () => {
  it('knows the endpoints that refuse a request without one', () => {
    expect(defaultSessionHeader('https://opencode.ai/zen/go/v1')).toBe('x-opencode-session')
    expect(defaultSessionHeader('https://opencode.ai/zen/v1')).toBe('x-opencode-session')
    expect(defaultSessionHeader('https://eu.opencode.ai/zen/go/v1')).toBe('x-opencode-session')
  })

  it('says nothing about anyone else', () => {
    expect(defaultSessionHeader('https://api.example.com/v1')).toBeUndefined()
    expect(defaultSessionHeader('http://localhost:8080/v1')).toBeUndefined()
    // A host that merely ends in the same letters is a different host.
    expect(defaultSessionHeader('https://notopencode.ai/v1')).toBeUndefined()
    expect(defaultSessionHeader('not a url')).toBeUndefined()
  })

  it('is what a record without its own header falls back to', async () => {
    const named = createProvider({ kind: 'openai', baseURL: 'https://opencode.ai/zen/go/v1', apiKey: 'k' })
    const headers = await sentHeaders(() => named.stream({ model: 'm', messages: [], tools: [], conversationId: 's1' }))
    expect(headers.get('x-opencode-session')).toBe('s1')
  })

  it('loses to a record that named one itself', async () => {
    const named = createProvider({
      kind: 'openai',
      baseURL: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      sessionHeader: 'x-mine',
    })
    const headers = await sentHeaders(() => named.stream({ model: 'm', messages: [], tools: [], conversationId: 's1' }))
    expect(headers.get('x-mine')).toBe('s1')
    expect(headers.get('x-opencode-session')).toBeNull()
  })
})

describe('KNOWN_PROVIDERS', () => {
  it('describes each entry well enough to fill a form', () => {
    for (const known of KNOWN_PROVIDERS) {
      expect(known.id).not.toBe('')
      expect(known.label).not.toBe('')
      expect(known.note).not.toBe('')
      expect(() => new URL(known.baseURL)).not.toThrow()
      if (known.sessionHeader !== undefined) expect(parseHeaderName(known.sessionHeader)).toBe(known.sessionHeader)
    }
  })

  it('has no two entries under one id', () => {
    const ids = KNOWN_PROVIDERS.map(known => known.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reaches the wire from its own address alone', async () => {
    // What picking an entry and pasting a key has to be enough for: the record
    // it saves carries no header of its own, so the address has to supply it.
    for (const known of KNOWN_PROVIDERS) {
      if (known.sessionHeader === undefined) continue
      const provider = createProvider({ kind: known.kind, baseURL: known.baseURL, apiKey: 'k' })
      const headers = await sentHeaders(() => provider.stream({ model: 'm', messages: [], tools: [], conversationId: 's1' }))
      expect(headers.get(known.sessionHeader)).toBe('s1')
    }
  })
})

describe('on the wire', () => {
  const input = { model: 'm', messages: [], tools: [], conversationId: 'session-7' }

  it('carries both on an OpenAI request', async () => {
    const provider = createOpenAIProvider({ baseURL: 'https://example.test', apiKey: 'k', sessionHeader: 'x-session' })
    const headers = await sentHeaders(() => provider.stream(input))
    expect(headers.get('user-agent')).toBe(USER_AGENT)
    expect(headers.get('x-session')).toBe('session-7')
  })

  it('carries both on an Anthropic request', async () => {
    const provider = createAnthropicProvider({ baseURL: 'https://example.test', apiKey: 'k', sessionHeader: 'x-session' })
    const headers = await sentHeaders(() => provider.stream(input))
    expect(headers.get('user-agent')).toBe(USER_AGENT)
    expect(headers.get('x-session')).toBe('session-7')
  })

  it('leaves the id off an endpoint that never asked for one', async () => {
    const provider = createOpenAIProvider({ baseURL: 'https://example.test', apiKey: 'k' })
    const headers = await sentHeaders(() => provider.stream(input))
    expect(headers.get('user-agent')).toBe(USER_AGENT)
    expect([...headers.keys()]).not.toContain('x-session')
  })
})
