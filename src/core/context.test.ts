import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from './session.js'
import { estimateParts, messageTokens, partsTotal, toolTokens } from './context.js'
import { emptyUsage } from './types.js'
import { parseState } from '../main/workspace-store.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { AppEvent, ChatChunk, ChatMessage, ContextLedger, ToolResult } from './types.js'
import type { ModelFacts } from './config.js'
import type { Tool } from './session.js'

/**
 * How big the next request is. The provider's own count is the only exact
 * figure, so these tests run real turns against a provider whose tokenizer
 * counts differently from the estimator, report what it counted, and read the
 * ledger the context button draws.
 */

/** One round: what the model says, and how its tokenizer compares with the estimator's. */
interface Round {
  chunks: ChatChunk[]
  /** The prompt is reported as the estimate times this. Absent: no usage at all. */
  ratio?: number
}

class MeasuringProvider implements ChatProvider {
  /** The prompt each request was reported at, in order. */
  readonly reported: number[] = []

  constructor(private readonly rounds: (n: number) => Round) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    const round = this.rounds(this.reported.length + 1)
    const prompt = round.ratio === undefined ? 0 : Math.round(estimateOf(input) * round.ratio)
    this.reported.push(prompt)
    yield* round.chunks
    yield { kind: 'done', usage: { ...emptyUsage(), input: prompt, output: 20 } }
  }
}

/** The request as the estimator sizes it, which is what the session compares the report with. */
function estimateOf(input: ChatInput): number {
  return partsTotal(estimateParts(input.messages, toolTokens(input.tools)))
}

const COUNT: Tool = {
  input: { name: 'count', description: 'count one', inputSchema: { type: 'object', properties: {} } },
  async run(): Promise<ToolResult> {
    return { ok: true, summary: 'counted', content: 'counted to one' }
  },
}

function callCount(id: string): ChatChunk[] {
  return [{ kind: 'tool', tool: { id, name: 'count', args: '{}' } }]
}

/** Long enough that rounding one token either way cannot pass for a wrong factor. */
const ANSWER = 'The counter reached one, which is the number the task asked for. '.repeat(6).trim()

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function session(provider: ChatProvider, facts?: ModelFacts): Promise<{ session: Session; ledgers: ContextLedger[] }> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-context-'))
  cleanup.push(cwd)
  const built = new Session(
    { sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', ...(facts === undefined ? {} : { facts }) },
    provider,
    [COUNT],
  )
  const ledgers: ContextLedger[] = []
  built.bus.on('context', (event: AppEvent) => {
    if (event.type === 'context') ledgers.push(event.ledger)
  })
  return { session: built, ledgers }
}

/**
 * Within a token. A reported count is a whole number, so the ratio the session
 * works out from it is only close to the one the provider was told to use.
 */
function near(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)
}

/** The assistant message a turn ended on, as stored. */
function lastAnswer(s: Session): ChatMessage {
  const last = s.transcript.at(-1)
  if (last?.role !== 'assistant') throw new Error('the turn did not end on an answer')
  return last
}

describe('the ledger', () => {
  it('anchors on the last prompt the provider counted and estimates what came after it', async () => {
    const provider = new MeasuringProvider(n => (n === 1 ? { chunks: callCount('c1'), ratio: 1.5 } : { chunks: [{ kind: 'text', text: ANSWER }], ratio: 1.5 }))
    const { session: s, ledgers } = await session(provider, { context: 100_000 })

    await s.run('count to one')

    const ledger = s.context
    // The second request carried the whole conversation up to the tool result,
    // and the answer came back after it. That answer is all nobody has counted.
    expect(ledger.measured).toBe(provider.reported[1])
    near(ledger.estimated, messageTokens(lastAnswer(s)) * 1.5)
    expect(ledger.tokens).toBe((ledger.measured ?? 0) + ledger.estimated)
    // The parts are estimates scaled to the total, so they add up to it exactly.
    expect(partsTotal(ledger.parts)).toBe(ledger.tokens)
    // The window saw it as it went, and last as it stands now.
    expect(ledgers.length).toBeGreaterThan(1)
    expect({ ...ledgers.at(-1), at: 0 }).toEqual({ ...ledger, at: 0 })
  })

  it('moves the correction part of the way towards each new count, inside its clamp', async () => {
    // The first count matches the estimator. The second says it undercounts
    // five times over, which is past the clamp, so the factor moves 30% of the
    // way from 1 towards 2 and not towards 5.
    const provider = new MeasuringProvider(n => (n === 1 ? { chunks: callCount('c1'), ratio: 1 } : { chunks: [{ kind: 'text', text: ANSWER }], ratio: 5 }))
    const { session: s } = await session(provider, { context: 100_000 })

    await s.run('count to one')

    expect(s.context.estimated).toBe(Math.round(messageTokens(lastAnswer(s)) * 1.3))
  })

  it('stays an estimate against a server that reports no usage', async () => {
    const provider = new MeasuringProvider(() => ({ chunks: [{ kind: 'text', text: ANSWER }] }))
    const { session: s } = await session(provider, { context: 100_000 })

    await s.run('say something')

    const ledger = s.context
    expect(ledger.measured).toBeNull()
    expect(ledger.tokens).toBe(ledger.estimated)
    expect(ledger.tokens).toBe(partsTotal(estimateParts(s.wireMessages(), toolTokens([COUNT.input]))))
  })
})

describe('the room kept for the answer', () => {
  it('is the ceiling a wire declares, since its server counts that against the window', async () => {
    const provider = Object.assign(new MeasuringProvider(() => ({ chunks: [] })), { declaredOutput: () => 50_000 })
    const { session: s } = await session(provider, { context: 200_000, maxOutput: 8_000 })

    expect(s.context).toMatchObject({ window: 200_000, reserve: 50_000, usable: 150_000, threshold: 120_000 })
  })

  it('is the output ceiling of the model where that is under the default, and the default otherwise', async () => {
    const small = await session(new MeasuringProvider(() => ({ chunks: [] })), { context: 200_000, maxOutput: 8_000 })
    const large = await session(new MeasuringProvider(() => ({ chunks: [] })), { context: 200_000, maxOutput: 64_000 })
    const unknown = await session(new MeasuringProvider(() => ({ chunks: [] })), { context: 200_000 })

    expect(small.session.context.reserve).toBe(8_000)
    expect(large.session.context.reserve).toBe(20_000)
    expect(unknown.session.context.reserve).toBe(20_000)
  })

  it('leaves no usable space and no threshold where nobody has said how big the window is', async () => {
    const provider = new MeasuringProvider(() => ({ chunks: [{ kind: 'text', text: ANSWER }], ratio: 1 }))
    const { session: s } = await session(provider)

    await s.run('say something')

    expect(s.context).toMatchObject({ window: null, usable: null, threshold: null })
    expect(s.context.tokens).toBeGreaterThan(0)
  })

  it('leaves no usable space where the reserve fills the window, and compacts nothing', async () => {
    const provider = Object.assign(new MeasuringProvider(() => ({ chunks: [{ kind: 'text', text: ANSWER }], ratio: 1 })), {
      declaredOutput: () => 50_000,
    })
    const { session: s } = await session(provider, { context: 40_000 })

    await s.run('say something')
    await s.run('say it again')

    expect(s.context).toMatchObject({ window: 40_000, reserve: 50_000, usable: null, threshold: null })
    // One request per turn: a threshold of nought would have put a summary before each.
    expect(provider.reported).toHaveLength(2)
    expect(s.context.compactions).toEqual([])
  })
})

describe('a ledger written down', () => {
  it('reads back as it was written, and a damaged one is dropped whole', async () => {
    const provider = new MeasuringProvider(n => (n === 1 ? { chunks: callCount('c1'), ratio: 1.2 } : { chunks: [{ kind: 'text', text: ANSWER }], ratio: 1.2 }))
    const { session: s } = await session(provider, { context: 100_000 })
    await s.run('count to one')

    const ledger = s.context
    const stored = (context: unknown): unknown =>
      JSON.parse(
        JSON.stringify({
          workspaces: [{ id: 'w1', name: 'demo', root: '/demo' }],
          sessions: [{ id: 's1', workspaceId: 'w1', title: 'count', role: 'builder', createdAt: 1, updatedAt: 2, context }],
        }),
      ) as unknown

    expect(parseState(stored(ledger)).sessions[0]?.context).toEqual(ledger)
    const damaged = { ...ledger, parts: { ...ledger.parts, toolResults: 'many' } }
    expect(parseState(stored(damaged)).sessions[0]?.context).toBeUndefined()
  })

  it('hands its correction to the session rebuilt from it, which sizes the same history the same before it sends anything', async () => {
    const provider = new MeasuringProvider(n => (n === 1 ? { chunks: callCount('c1'), ratio: 1.5 } : { chunks: [{ kind: 'text', text: ANSWER }], ratio: 1.5 }))
    const { session: s } = await session(provider, { context: 100_000 })
    await s.run('count to one')
    const state = parseState(
      JSON.parse(
        JSON.stringify({
          workspaces: [{ id: 'w1', name: 'demo', root: '/demo' }],
          sessions: [{ id: 's1', workspaceId: 'w1', title: 'count', role: 'builder', createdAt: 1, updatedAt: 2, context: s.context }],
        }),
      ) as unknown,
    )
    const stored = state.sessions[0]?.context
    if (stored === undefined) throw new Error('the ledger did not read back')

    const rebuild = async (calibration?: number): Promise<Session> => {
      const cwd = await mkdtemp(join(tmpdir(), 'nh-context-'))
      cleanup.push(cwd)
      return new Session(
        {
          sessionId: 'test',
          cwd,
          model: 'test-model',
          systemPrompt: 'You are a test.',
          facts: { context: 100_000 },
          history: s.transcript,
          ...(calibration === undefined ? {} : { calibration }),
        },
        new MeasuringProvider(() => ({ chunks: [] })),
        [COUNT],
      )
    }

    // Nothing has been counted since the rebuild, so all of it is estimated,
    // at the factor the first run measured.
    const rebuilt = await rebuild(stored.calibration)
    expect(rebuilt.context.measured).toBeNull()
    expect(Math.abs(rebuilt.context.tokens - s.context.tokens)).toBeLessThanOrEqual(2)
    // Without it the estimator starts again at 1 and undercounts by a third.
    const fresh = await rebuild()
    near(fresh.context.tokens, rebuilt.context.tokens / stored.calibration)
  })

  it('hands its compactions to the session rebuilt from it', async () => {
    const compactions = [{ at: 1, reason: 'auto' as const, before: 90_000, after: 20_000 }]
    const cwd = await mkdtemp(join(tmpdir(), 'nh-context-'))
    cleanup.push(cwd)
    const rebuilt = new Session(
      { sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', facts: { context: 100_000 }, compactions },
      new MeasuringProvider(() => ({ chunks: [] })),
      [],
    )

    expect(rebuilt.context.compactions).toEqual(compactions)
  })
})
