import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from './session.js'
import { NO_BODY, ProviderError, StreamBrokenError } from './provider.js'
import { emptyUsage } from './types.js'
import type { ChatProvider } from './provider.js'
import type { AppEvent, ChatChunk, SessionNote } from './types.js'

/**
 * A round that fails is asked for again. These tests pin the parts of that which
 * leave no trace in the transcript: an answer that broke half way through is
 * thrown away rather than stitched onto the one that replaces it, and a refusal
 * the provider will repeat is not asked five times.
 */

/**
 * The journal minus the line every turn ends on. A test about how a turn ended
 * is about what the harness had to say, and every turn ends on a summary either
 * way.
 */
function said(session: Session): SessionNote[] {
  return session.notes.filter(note => note.kind !== 'summary')
}

/** One round's worth of stream: what it yields, and whether it then breaks. */
interface Step {
  chunks: ChatChunk[]
  fail?: Error
}

class FlakyProvider implements ChatProvider {
  rounds = 0

  constructor(private readonly steps: (round: number) => Step) {}

  async *stream(): AsyncGenerator<ChatChunk> {
    this.rounds += 1
    const step = this.steps(this.rounds)
    for (const chunk of step.chunks) yield chunk
    if (step.fail !== undefined) throw step.fail
  }
}

function say(text: string): Step {
  return { chunks: [{ kind: 'text', text }, { kind: 'done', usage: emptyUsage() }] }
}

/** A session on a scratch directory, with the events these tests read recorded. */
async function harness(provider: ChatProvider): Promise<{
  session: Session
  events: AppEvent[]
  cleanup: () => Promise<void>
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-retry-'))
  const session = new Session({ sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.' }, provider, [])
  const events: AppEvent[] = []
  for (const type of ['round.started', 'round.retry', 'session.error', 'session.finished', 'session.stopped'] as const) {
    session.bus.on(type, event => void events.push(event))
  }
  return { session, events, cleanup: () => rm(cwd, { recursive: true, force: true }) }
}

async function run(
  provider: ChatProvider,
  prompt: string,
  during?: (session: Session) => void,
): Promise<{ session: Session; events: AppEvent[] }> {
  const { session, events, cleanup } = await harness(provider)
  // The backoff between attempts is seconds of real waiting, which is the right
  // thing in the app and the wrong thing here.
  vi.useFakeTimers()
  try {
    // A turn whose last attempt fails throws, the same as it does in the app.
    // What is being read here is what it left behind, so the throw is caught.
    const turn = session.run(prompt).catch(() => emptyUsage())
    if (during !== undefined) {
      // Far enough in to be waiting out the first backoff, which is 500ms.
      await vi.advanceTimersByTimeAsync(100)
      during(session)
    }
    await vi.advanceTimersByTimeAsync(60_000)
    await turn
  } finally {
    vi.useRealTimers()
    await cleanup()
  }
  return { session, events }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a request that breaks part way through', () => {
  it('is made again, and the half it had already streamed is dropped', async () => {
    const provider = new FlakyProvider(round =>
      round === 1
        ? { chunks: [{ kind: 'text', text: 'I looked at the file and it' }], fail: new ProviderError('overloaded', 529) }
        : say('The file sets the timeout to 30 seconds.'),
    )

    const { session, events } = await run(provider, 'what does the file do')

    expect(provider.rounds).toBe(2)
    expect(session.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'The file sets the timeout to 30 seconds.' })
    // The answer that arrived stands on its own, with none of the broken
    // attempt's first sentence in front of it.
    expect(JSON.stringify(session.transcript)).not.toContain('I looked at the file and it')
    const retry = events.find(event => event.type === 'round.retry')
    expect(retry).toMatchObject({ attempt: 2, of: 5 })
    expect(session.notes.map(note => note.kind)).toEqual(['note', 'summary'])
    expect(events.some(event => event.type === 'session.finished')).toBe(true)
  })
})

describe('an error the provider sends down the stream itself', () => {
  it('is retried, because a 200 header says nothing about what came after it', async () => {
    const provider = new FlakyProvider(round =>
      round === 1
        ? { chunks: [{ kind: 'text', text: 'Reading the' }, { kind: 'error', message: 'Overloaded', status: 529 }] }
        : say('Two callers, both in src/main.'),
    )

    const { session, events } = await run(provider, 'who calls this')

    expect(provider.rounds).toBe(2)
    expect(session.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'Two callers, both in src/main.' })
    expect(JSON.stringify(session.transcript)).not.toContain('Reading the')
    expect(events.find(event => event.type === 'round.retry')).toMatchObject({ attempt: 2, of: 5 })
  })

  it('is not retried when the status it carries says the request was wrong', async () => {
    const provider = new FlakyProvider(() => ({ chunks: [{ kind: 'error', message: 'max_tokens too large', status: 400 }] }))

    const { session, events } = await run(provider, 'hello')

    expect(provider.rounds).toBe(1)
    expect(events.some(event => event.type === 'round.retry')).toBe(false)
    expect(said(session).at(-1)?.text).toContain('max_tokens too large')
  })
})

describe('a request the provider refuses', () => {
  it('is not asked again: a 400 says the same thing five times', async () => {
    const provider = new FlakyProvider(() => ({ chunks: [], fail: new ProviderError('model not found', 400) }))

    const { session, events } = await run(provider, 'hello')

    expect(provider.rounds).toBe(1)
    expect(events.some(event => event.type === 'round.retry')).toBe(false)
    expect(events.some(event => event.type === 'session.error')).toBe(true)
    expect(session.notes.map(note => note.kind)).toEqual(['error', 'summary'])
  })
})

describe('a body that never arrived', () => {
  it('is retried, though the response it came from was a 200', async () => {
    const provider = new FlakyProvider(round =>
      round === 1 ? { chunks: [], fail: new StreamBrokenError(NO_BODY) } : say('Done.'),
    )

    const { session } = await run(provider, 'hello')

    expect(provider.rounds).toBe(2)
    expect(session.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'Done.' })
  })
})

describe('the tokens a failed attempt burned', () => {
  it('are carried onto the round that works, and the provider keeps its own object', async () => {
    const spent = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    const second = { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0 }
    // The prompt is charged for before the answer is written, and the wire says
    // so as soon as it knows: a `usage` chunk, then the failure. An attempt that
    // breaks sends nothing after it, so this is the only shape the count of a
    // failed attempt can arrive in.
    const provider = new FlakyProvider(round =>
      round === 1
        ? { chunks: [{ kind: 'usage', usage: spent }, { kind: 'error', message: 'Overloaded', status: 529 }] }
        : { chunks: [{ kind: 'text', text: 'Done.' }, { kind: 'done', usage: second }] },
    )

    const { session } = await run(provider, 'hello')

    expect(session.spent).toMatchObject({ input: 11, output: 22, cacheRead: 3 })
    // The provider handed those objects over and may still be holding them.
    expect(spent).toEqual({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(second).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0 })
  })
})

/**
 * How long the turn waits, when the provider named a time. The wait itself is
 * what is under test, so these drive the clock in steps instead of jumping to
 * the end the way `run` does.
 */
async function waitsOut(asked: number, before: number, after: number): Promise<number> {
  const provider = new FlakyProvider(round =>
    round === 1 ? { chunks: [], fail: new ProviderError('slow down', 429, asked) } : say('Done.'),
  )
  const { session, cleanup } = await harness(provider)
  vi.useFakeTimers()
  try {
    const turn = session.run('hello').catch(() => emptyUsage())
    await vi.advanceTimersByTimeAsync(before)
    const early = provider.rounds
    await vi.advanceTimersByTimeAsync(after - before)
    await turn
    expect(provider.rounds).toBe(2)
    return early
  } finally {
    vi.useRealTimers()
    await cleanup()
  }
}

describe('a provider that says when to come back', () => {
  it('is waited out on its own terms rather than on the schedule', async () => {
    // The schedule's first gap is 500ms, and a 429 that asks for 20 seconds
    // means a request sent at second two is refused again.
    expect(await waitsOut(20_000, 2_000, 21_000)).toBe(1)
  })

  it('is not let hold the turn open past the cap', async () => {
    // An hour is a header the harness answers to only for the first minute.
    expect(await waitsOut(60 * 60_000, 59_000, 61_000)).toBe(1)
  })
})

describe('Stop pressed while the harness is waiting to try again', () => {
  it('ends the turn as a stop, not as the error it was about to retry', async () => {
    const provider = new FlakyProvider(() => ({ chunks: [], fail: new ProviderError('overloaded', 529) }))

    const { session, events } = await run(provider, 'hello', session => void session.stop())

    // The attempt that failed, and no second one made on a stopped turn.
    expect(provider.rounds).toBe(1)
    expect(session.interrupted).toBe(true)
    expect(events.some(event => event.type === 'session.stopped')).toBe(true)
    expect(events.some(event => event.type === 'session.error')).toBe(false)
    expect(said(session).at(-1)?.kind).toBe('stopped')
  })
})

describe('a provider that stays down', () => {
  it('is asked five times and then the turn ends saying so', async () => {
    const provider = new FlakyProvider(() => ({ chunks: [], fail: new ProviderError('bad gateway', 502) }))

    const { session, events } = await run(provider, 'hello')

    expect(provider.rounds).toBe(5)
    expect(events.filter(event => event.type === 'round.retry')).toHaveLength(4)
    expect(events.filter(event => event.type === 'round.started')).toHaveLength(5)
    const failed = said(session).at(-1)
    expect(failed?.kind).toBe('error')
    expect(failed?.text).toContain('bad gateway')
  })
})
