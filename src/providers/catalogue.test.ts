import { describe, expect, it } from 'vitest'
import { describe as fill, readCatalogue } from './catalogue.js'
import type { ModelOffer } from '../core/config.js'

/**
 * Reading the model catalogue. The payload below is the shape models.dev
 * actually returns, trimmed to four models of one provider: a tiered model on
 * its own wire, a plain one, one whose thinking is a toggle rather than a set
 * of levels, and one the harness has no wire for.
 */

const BODY = {
  'opencode-go': {
    id: 'opencode-go',
    api: 'https://opencode.ai/zen/go/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'grok-4.6': {
        id: 'grok-4.6',
        cost: {
          input: 2,
          output: 6,
          cache_read: 0.5,
          tiers: [{ input: 4, output: 12, cache_read: 1, tier: { type: 'context', size: 200000 } }],
        },
        limit: { context: 500000, output: 500000 },
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
        provider: { npm: '@ai-sdk/openai' },
      },
      'kimi-k3': {
        id: 'kimi-k3',
        cost: { input: 3, output: 15, cache_read: 0.3 },
        limit: { context: 1048576, output: 131072 },
        reasoning_options: [{ type: 'effort', values: ['max'] }],
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      },
      'minimax-m3': {
        id: 'minimax-m3',
        cost: { input: 0.3, output: 1.2 },
        limit: { context: 1000000, output: 131072 },
        reasoning_options: [{ type: 'toggle' }],
        modalities: { input: ['text'], output: ['text'] },
        provider: { npm: '@ai-sdk/anthropic' },
      },
      'omen-alpha': {
        id: 'omen-alpha',
        limit: { context: 200000, output: 64000 },
        modalities: { input: ['text'], output: ['text'] },
        provider: { npm: '@ai-sdk/google' },
      },
    },
  },
  // Same host, shallower path: the endpoint next door, and not this one.
  opencode: { id: 'opencode', api: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible', models: { 'kimi-k3': { id: 'kimi-k3', cost: { input: 99, output: 99 } } } },
  elsewhere: { id: 'elsewhere', api: 'https://example.invalid/v1', npm: '@ai-sdk/openai-compatible', models: { m: { id: 'm', cost: { input: 9, output: 9 } } } },
}

const GO = 'https://opencode.ai/zen/go/v1'

describe('what the catalogue says about a model', () => {
  it('reads the prices, the ceiling, the levels and whether it takes images', () => {
    expect(readCatalogue(BODY, GO)['kimi-k3']).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      maxOutput: 131072,
      efforts: ['max'],
      vision: true,
      wire: 'openai',
    })
  })

  it('reads a long-prompt price as a tier, keyed by the size that reaches it', () => {
    expect(readCatalogue(BODY, GO)['grok-4.6']?.tiers).toEqual([{ over: 200000, input: 4, output: 12, cacheRead: 1 }])
  })

  it('reads the wire off the model where it names one, and off the provider where it does not', () => {
    const read = readCatalogue(BODY, GO)
    expect(read['grok-4.6']?.wire).toBe('responses')
    expect(read['minimax-m3']?.wire).toBe('anthropic')
    expect(read['kimi-k3']?.wire).toBe('openai')
  })

  it('says nothing about a wire this harness cannot speak', () => {
    // The record's wire then stands, which is the same answer as a model the
    // catalogue has never described.
    expect(readCatalogue(BODY, GO)['omen-alpha']?.wire).toBeUndefined()
  })

  it('leaves out thinking it has no control for', () => {
    // A toggle and a token budget are neither of them a set of levels, and an
    // empty list would read as a model that thinks at no level at all.
    expect(readCatalogue(BODY, GO)['minimax-m3']?.efforts).toBeUndefined()
  })
})

describe('finding the address in the catalogue', () => {
  it('ignores a trailing slash', () => {
    expect(Object.keys(readCatalogue(BODY, 'https://opencode.ai/zen/go/v1/')).length).toBe(4)
  })

  it('tells apart two endpoints on one host that differ only by path', () => {
    // A host-only match took whichever was listed first, and described every
    // model at one address with the prices of the other.
    expect(readCatalogue(BODY, GO)['kimi-k3']?.input).toBe(3)
    expect(readCatalogue(BODY, 'https://opencode.ai/zen/v1')['kimi-k3']?.input).toBe(99)
  })

  it('comes back empty for an address nobody has listed', () => {
    expect(readCatalogue(BODY, 'https://nobody.invalid/v1')).toEqual({})
    expect(readCatalogue(BODY, 'not a url')).toEqual({})
  })

  it('comes back empty rather than throwing on a body it cannot read', () => {
    for (const bad of [null, 'text', 42, [], { 'opencode-go': 7 }]) expect(readCatalogue(bad, GO)).toEqual({})
  })
})

describe('filling in what the endpoint did not say', () => {
  const offers: ModelOffer[] = [
    { id: 'kimi-k3', facts: {} },
    { id: 'grok-4.6', facts: { output: 99 } },
    { id: 'something-new', facts: {} },
  ]

  it('describes a model the endpoint listed bare', () => {
    expect(fill(offers, readCatalogue(BODY, GO))[0]?.facts.input).toBe(3)
  })

  it('leaves anything the endpoint stated exactly as it stated it', () => {
    expect(fill(offers, readCatalogue(BODY, GO))[1]?.facts.output).toBe(99)
  })

  it('offers a model the catalogue has never heard of, still undescribed', () => {
    expect(fill(offers, readCatalogue(BODY, GO))[2]).toEqual({ id: 'something-new', facts: {} })
  })

  it('conjures no model the endpoint did not offer', () => {
    expect(fill(offers, readCatalogue(BODY, GO)).map(o => o.id)).toEqual(['kimi-k3', 'grok-4.6', 'something-new'])
  })
})
