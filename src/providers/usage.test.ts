import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import { cacheHitRate, emptyUsage } from '../core/types.js'
import { hitRate, hitText } from '../renderer/metrics.js'
import type { ChatChunk, TurnUsage } from '../core/types.js'

/**
 * What a turn cost, as the two wires report it and as the harness has to store
 * it. The two disagree about what the word "input" means: Anthropic reports
 * the cached tokens apart from it, OpenAI counts them inside it. A harness
 * that stores both verbatim and then divides one by the other reports a cache
 * hit rate that is wrong on one of the two providers and meaningless once a
 * user has spent tokens on both. These tests pin the normalization that makes
 * the stored number mean one thing.
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

async function collect(stream: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function doneOf(chunks: readonly ChatChunk[]): Extract<ChatChunk, { kind: 'done' }> {
  const done = chunks.find((chunk): chunk is Extract<ChatChunk, { kind: 'done' }> => chunk.kind === 'done')
  if (done === undefined) throw new Error('the stream ended without a done chunk')
  return done
}

async function usageOf(stream: AsyncGenerator<ChatChunk>): Promise<TurnUsage> {
  return doneOf(await collect(stream)).usage
}

function openaiStream(lines: readonly string[]): AsyncGenerator<ChatChunk> {
  vi.stubGlobal('fetch', () => Promise.resolve(sse(lines)))
  const provider = createOpenAIProvider({ apiKey: 'k', baseURL: 'https://example.invalid' })
  return provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] })
}

function openai(lines: readonly string[]): Promise<TurnUsage> {
  return usageOf(openaiStream(lines))
}

function anthropic(lines: readonly string[]): Promise<TurnUsage> {
  vi.stubGlobal('fetch', () => Promise.resolve(sse(lines)))
  const provider = createAnthropicProvider({ apiKey: 'k', baseURL: 'https://example.invalid' })
  return usageOf(provider.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] }))
}

afterEach(() => void vi.unstubAllGlobals())

describe('what a turn cost', () => {
  it('takes the cached half out of the OpenAI prompt count, so 9 of 10 cached reads as 90%', async () => {
    // 10,000 prompt tokens of which 9,000 came from cache: the cached half
    // comes out of `prompt_tokens`, and the turn reads 90%.
    const usage = await openai([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"usage":{"prompt_tokens":10000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":9000}}}',
      'data: [DONE]',
    ])
    expect(usage.input).toBe(1000)
    expect(usage.cacheRead).toBe(9000)
    expect(cacheHitRate(usage)).toBeCloseTo(0.9, 5)
  })

  it('reads the other cache field, the one that is not prompt_tokens_details', async () => {
    const usage = await openai([
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"usage":{"prompt_tokens":800,"completion_tokens":20,"prompt_cache_hit_tokens":600,"prompt_cache_miss_tokens":200}}',
      'data: [DONE]',
    ])
    expect(usage.input).toBe(200)
    expect(usage.cacheRead).toBe(600)
    expect(cacheHitRate(usage)).toBeCloseTo(0.75, 5)
  })

  it('leaves the counts on the other wire alone, because it already reports them apart', async () => {
    const usage = await anthropic([
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1000,"cache_read_input_tokens":9000,"cache_creation_input_tokens":0}}}',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":50}}',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ])
    expect(usage.input).toBe(1000)
    expect(usage.cacheRead).toBe(9000)
    expect(usage.output).toBe(50)
    // The same spend on either wire now gives the same answer.
    expect(cacheHitRate(usage)).toBeCloseTo(0.9, 5)
  })

  it('counts a cache write against the hit rate, because it was read in full and billed at a premium', async () => {
    const usage = await anthropic([
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20000,"cache_creation_input_tokens":5000}}}',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":8}}',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ])
    // A cache write is prompt the provider read in full and charged a premium
    // for, so it sits in the denominator like any other prompt token.
    expect(cacheHitRate(usage)).toBeCloseTo(20000 / 25010, 5)
  })

  it('refuses a contradictory usage report and never caps it', async () => {
    // A server that says more of the prompt was cached than there was prompt
    // has sent two numbers that cannot both be right, so neither is stored:
    // the turn's cost is unknown and the done chunk says why.
    const chunks = await collect(
      openaiStream([
        'data: {"choices":[{"delta":{"content":"the answer"}}],"usage":{"prompt_tokens":500,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":900}}}',
        'data: [DONE]',
      ]),
    )
    expect(chunks.some(chunk => chunk.kind === 'text' && chunk.text === 'the answer')).toBe(true)
    const done = doneOf(chunks)
    expect(done.usage).toEqual(emptyUsage())
    expect(done.usageProblem).toContain('900 cached tokens')
  })

  it('reports usage missing its totals as a problem, not as a free turn', async () => {
    const chunks = await collect(
      openaiStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        'data: {"usage":{"prompt_tokens":500}}',
        'data: [DONE]',
      ]),
    )
    const done = doneOf(chunks)
    expect(done.usage).toEqual(emptyUsage())
    expect(done.usageProblem).toContain('completion_tokens')
  })

  it('reports a cache count that is not a number as a problem too', async () => {
    const chunks = await collect(
      openaiStream([
        'data: {"usage":{"prompt_tokens":500,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":"900"}}}',
        'data: [DONE]',
      ]),
    )
    const done = doneOf(chunks)
    expect(done.usage).toEqual(emptyUsage())
    expect(done.usageProblem).toContain('cached_tokens')
  })

  it('prefers prompt_tokens_details over the other field when a server sends both', async () => {
    // A gateway fronting another endpoint can pass both spellings through. They
    // are read in a fixed order so one turn is not counted one way and the next
    // another; the standard field wins.
    const usage = await openai([
      'data: {"usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_cache_hit_tokens":250,"prompt_tokens_details":{"cached_tokens":400}}}',
      'data: [DONE]',
    ])
    expect(usage.cacheRead).toBe(400)
    expect(usage.input).toBe(600)
  })

  it('has no hit rate to report when nothing was sent', async () => {
    const usage = await openai(['data: {"usage":{"prompt_tokens":0,"completion_tokens":0}}', 'data: [DONE]'])
    expect(cacheHitRate(usage)).toBeNull()
  })
})


/**
 * The cache hit rate exists twice. `cacheHitRate` in src/core/types.ts is the
 * definition and is what `nh usage` and the main process divide; `hitRate` in
 * src/renderer/metrics.ts is a copy, because eslint.config.js forbids the
 * renderer a runtime import from core and the renderer ships as its own
 * bundle. A copy that nothing compares is a copy that drifts, and a window
 * that disagrees with `nh usage` about a turn they both watched is worse than
 * either number. So the two are run against the same spend, taken off the
 * wire and never made up, and have to answer the same.
 *
 * This test lives outside src/renderer because the same eslint rule would stop
 * it importing core from in there.
 */
describe('the window and the CLI dividing the same turn', () => {
  it('agree on an OpenAI turn, where the cached half had to be subtracted out', async () => {
    const usage = await openai([
      'data: {"usage":{"prompt_tokens":10000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":9000}}}',
      'data: [DONE]',
    ])
    expect(hitRate(usage)).toBe(cacheHitRate(usage))
    expect(hitText(usage)).toBe('90%')
  })

  it('agree on an Anthropic turn, where a cache write is in the denominator', async () => {
    const usage = await anthropic([
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20000,"cache_creation_input_tokens":5000}}}',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":8}}',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ])
    // A copy that forgot cacheWrite would say 100% here, and the CLI 80%.
    expect(hitRate(usage)).toBe(cacheHitRate(usage))
    expect(hitText(usage)).toBe('80%')
  })

  it('agree that a turn which sent nothing has no rate, with neither showing 0%', async () => {
    const usage = await openai(['data: {"usage":{"prompt_tokens":0,"completion_tokens":0}}', 'data: [DONE]'])
    expect(hitRate(usage)).toBeNull()
    expect(cacheHitRate(usage)).toBeNull()
    expect(hitText(usage)).toBe('n/a')
  })
})
