import { describe, expect, it } from 'vitest'
import { matches } from './match.js'

/**
 * The filter over a fetched model list. An endpoint can offer thirty ids in an
 * order it chose for itself, so this is how someone gets to the one they came
 * for. The ids below are real ones, written the way their endpoints write them.
 */

describe('finding a model by name', () => {
  it('finds one however the id spells the gaps', () => {
    // The person remembers a name, not an endpoint's punctuation.
    expect(matches('gpt5', 'gpt-5.6-luna')).toBe(true)
    expect(matches('gpt 5', 'gpt-5.6-luna')).toBe(true)
    expect(matches('gpt-5', 'gpt_5_6_luna')).toBe(true)
    expect(matches('claude opus', 'claude-opus-5')).toBe(true)
    expect(matches('claudeopus', 'claude-opus-5')).toBe(true)
  })

  it('finds one by any part of its name', () => {
    expect(matches('luna', 'gpt-5.6-luna')).toBe(true)
    expect(matches('4.6', 'grok-4.6')).toBe(true)
    expect(matches('46', 'grok-4.6')).toBe(true)
  })

  it('ignores case and stray spacing', () => {
    expect(matches('  KIMI  ', 'kimi-k3')).toBe(true)
    expect(matches('Qwen3.7', 'qwen3.7-plus')).toBe(true)
  })

  it('leaves out what was not asked for', () => {
    expect(matches('gpt', 'claude-opus-5')).toBe(false)
    expect(matches('opus 4', 'claude-opus-5')).toBe(false)
    // A run-together query still has to appear in order.
    expect(matches('k3kimi', 'kimi-k3')).toBe(false)
  })

  it('keeps the whole list while nothing is typed', () => {
    // An empty box is not a question, and a box holding punctuation alone has
    // not asked one either.
    for (const query of ['', '   ', '-', '..']) {
      expect(matches(query, 'kimi-k3')).toBe(true)
    }
  })
})
