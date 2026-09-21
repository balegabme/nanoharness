import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from './factory.js'
import { parseStored, resolveFacts } from '../core/config.js'
import { isProviderKind as rendererGuard, PROVIDER_KINDS as RENDERER_KINDS } from '../renderer/facts.js'
import { isProviderKind, PROVIDER_KINDS } from '../core/config.js'
import type { ProviderRecord } from '../core/config.js'

/**
 * Which client a record and a model add up to.
 *
 * A provider record names one wire, and a gateway fronting many upstreams can
 * hold a model that answers on another. The model's own wire is stored with its
 * prices, so the pair decides, and the path a request takes is asserted here
 * against the address it actually goes to.
 */

const GO = 'https://opencode.ai/zen/go/v1'

/** The URL the client would post a turn to, without a turn ever being sent. */
async function pathFor(record: ProviderRecord, model: string): Promise<string> {
  let url = ''
  vi.stubGlobal('fetch', (target: string) => {
    url = target
    return Promise.resolve(new Response('no', { status: 400 }))
  })
  const { wire } = resolveFacts(record, model)
  const provider = createProvider({ kind: record.kind, baseURL: record.baseURL, apiKey: 'k', ...(wire === undefined ? {} : { wire }) })
  const stream = provider.stream({ model, messages: [{ role: 'user', content: 'hi' }], tools: [] })
  await expect(stream.next()).rejects.toThrow()
  return url
}

function record(facts: ProviderRecord['facts']): ProviderRecord {
  return { id: 'p', name: 'go', kind: 'openai', baseURL: GO, models: ['grok-4.6', 'kimi-k3'], ...(facts === undefined ? {} : { facts }) }
}

afterEach(() => void vi.unstubAllGlobals())

describe('the wire a model is asked on', () => {
  it('sends a model its endpoint refuses on the record’s wire over the one it named', async () => {
    const go = record({ 'grok-4.6': { wire: 'responses' }, 'kimi-k3': {} })
    expect(await pathFor(go, 'grok-4.6')).toBe('https://opencode.ai/zen/go/v1/responses')
    expect(await pathFor(go, 'kimi-k3')).toBe('https://opencode.ai/zen/go/v1/chat/completions')
  })

  it('reaches the third wire the same way', async () => {
    expect(await pathFor(record({ m: { wire: 'anthropic' } }), 'm')).toBe('https://opencode.ai/zen/go/v1/messages')
  })

  it('leaves a model nobody described on the wire the record names', async () => {
    expect(await pathFor(record(undefined), 'grok-4.6')).toBe('https://opencode.ai/zen/go/v1/chat/completions')
  })

  it('takes the wire a correction names over the one the catalogue reported', () => {
    const corrected: ProviderRecord = { ...record({ m: { wire: 'responses' } }), overrides: { m: { wire: 'anthropic' } } }
    expect(resolveFacts(corrected, 'm').wire).toBe('anthropic')
  })
})

describe('a wire named in a settings file', () => {
  const file = (kind: unknown): unknown => ({ providers: [{ id: 'p', baseURL: 'https://example.invalid/v1', kind, models: ['m'] }] })

  it('is read back as it was written', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(parseStored(file(kind)).providers[0]?.kind).toBe(kind)
    }
  })

  it('reads anything that is not a wire as the format most endpoints speak', () => {
    for (const kind of [undefined, 'grpc', 7, null]) {
      expect(parseStored(file(kind)).providers[0]?.kind).toBe('openai')
    }
  })

  it('keeps a model’s own wire across a save, and drops one that is not a wire', () => {
    const stored = (wire: unknown): unknown => ({ providers: [{ id: 'p', baseURL: GO, kind: 'openai', models: ['m'], facts: { m: { input: 1, output: 2, wire } } }] })
    expect(parseStored(stored('responses')).providers[0]?.facts?.m?.wire).toBe('responses')
    expect(parseStored(stored('grpc')).providers[0]?.facts?.m?.wire).toBeUndefined()
  })
})

describe('the window’s copy of the wire list', () => {
  it('holds the same wires the main process does', () => {
    // The renderer may not import core at runtime, so it keeps a copy. This is
    // what fails when the two drift.
    expect(RENDERER_KINDS).toEqual(PROVIDER_KINDS)
    for (const kind of [...PROVIDER_KINDS, 'grpc', '', undefined]) {
      expect(rendererGuard(kind)).toBe(isProviderKind(kind))
    }
  })
})
