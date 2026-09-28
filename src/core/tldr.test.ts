import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyUsage } from '../shared/usage.js'
import { Session } from './session.js'
import { TLDR_INSTRUCTION, TLDR_SYSTEM } from './tldr.js'
import { estimateParts, partsTotal, toolTokens } from './context.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { AppEvent, ChatChunk, ToolResult } from './types.js'
import type { ModelFacts } from './config.js'
import type { Tool } from './session.js'

/**
 * `/tldr` end to end: a real turn against a scripted provider, then the TL;DR,
 * with the requests read back to see which way it was asked.
 */

type Kind = 'turn' | 'whole' | 'alone'

function kindOf(input: ChatInput): Kind {
  if (input.messages[0]?.content === TLDR_SYSTEM) return 'alone'
  if (input.messages.at(-1)?.content === TLDR_INSTRUCTION) return 'whole'
  return 'turn'
}

/** Reports every prompt at exactly the estimate, so the sizes the route is chosen by are the ones worked out below. */
class ScriptedProvider implements ChatProvider {
  readonly seen: { kind: Kind; input: ChatInput }[] = []

  constructor(private readonly answer: (kind: Kind) => ChatChunk[]) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    const kind = kindOf(input)
    this.seen.push({ kind, input })
    yield* this.answer(kind)
    const prompt = partsTotal(estimateParts(input.messages, toolTokens(input.tools)))
    yield { kind: 'done', usage: { ...emptyUsage(), input: prompt, output: 10 } }
  }

  of(kind: Kind): ChatInput[] {
    return this.seen.filter(one => one.kind === kind).map(one => one.input)
  }
}

const NOOP: Tool = {
  input: { name: 'noop', description: 'does nothing', inputSchema: { type: 'object', properties: {} } },
  async run(): Promise<ToolResult> {
    return { ok: true, summary: 'nothing', content: '' }
  },
}

/**
 * A 2,000-token question and a 500-token answer. Warm, the whole conversation
 * is mostly a cache read and costs well under twice the answer alone. Cold,
 * all of it is written again at the write rate and costs far more.
 */
const QUESTION = 'q'.repeat(8_000)
const ANSWER = 'a'.repeat(2_000)
const PRICED: ModelFacts = { context: 200_000, maxOutput: 1_000, input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

const cleanup: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function open(provider: ChatProvider, facts: ModelFacts): Promise<{ session: Session; events: AppEvent[] }> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-tldr-'))
  cleanup.push(cwd)
  const session = new Session({ sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', facts }, provider, [NOOP])
  const events: AppEvent[] = []
  session.bus.on('session.tldr', (event: AppEvent) => void events.push(event))
  return { session, events }
}

function answering(tldr: (kind: Kind) => ChatChunk[] = () => [{ kind: 'text', text: 'short version' }]): ScriptedProvider {
  return new ScriptedProvider(kind => (kind === 'turn' ? [{ kind: 'text', text: ANSWER }] : tldr(kind)))
}

describe('/tldr', () => {
  it('asks on the request the turn had already sent while the cache is warm, and keeps the result out of the conversation', async () => {
    const provider = answering()
    const { session, events } = await open(provider, PRICED)
    await session.run(QUESTION)

    const spend = await session.tldr()

    const [turn] = provider.of('turn')
    const [whole] = provider.of('whole')
    expect(provider.of('alone')).toHaveLength(0)
    expect(whole?.messages.slice(0, turn?.messages.length)).toEqual(turn?.messages)
    expect(whole?.tools).toEqual(turn?.tools)
    expect(spend.written).toBe(true)
    expect(spend.usage.input).toBeGreaterThan(0)
    expect(events).toMatchObject([{ type: 'session.tldr', text: 'short version' }])
    expect(session.notes.filter(note => note.kind === 'tldr').map(note => note.text)).toEqual(['short version'])

    await session.run('next')
    const next = provider.of('turn').at(-1)
    expect(JSON.stringify(next?.messages)).not.toContain('short version')
    expect(JSON.stringify(next?.messages)).not.toContain(TLDR_INSTRUCTION)
  })

  it('sends the answer alone, with no tools, once the cache has gone cold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const provider = answering()
    const { session } = await open(provider, PRICED)
    await session.run(QUESTION)
    vi.setSystemTime(Date.now() + 6 * 60_000)

    expect((await session.tldr()).written).toBe(true)

    expect(provider.of('whole')).toHaveLength(0)
    const [alone] = provider.of('alone')
    expect(alone?.tools).toEqual([])
    expect(alone?.messages).toHaveLength(2)
    expect(alone?.messages[1]?.content).toContain(ANSWER)
    expect(alone?.messages[1]?.content).not.toContain(QUESTION)
  })

  it('falls back to the answer alone when the whole conversation brings back a tool call', async () => {
    const provider = answering(kind =>
      kind === 'whole' ? [{ kind: 'tool', tool: { id: 'c1', name: 'noop', args: '{}' } }] : [{ kind: 'text', text: 'short version' }],
    )
    const { session } = await open(provider, PRICED)
    await session.run(QUESTION)

    expect((await session.tldr()).written).toBe(true)

    expect(provider.of('whole')).toHaveLength(1)
    expect(provider.of('alone')).toHaveLength(1)
    expect(session.transcript.some(m => m.role === 'tool')).toBe(false)
  })

  it('says there is nothing to shorten before the first answer, and asks nobody', async () => {
    const provider = answering()
    const { session } = await open(provider, PRICED)

    expect((await session.tldr()).written).toBe(false)

    expect(provider.seen).toHaveLength(0)
    expect(session.notes.map(note => note.text)).toEqual(['There is no answer to shorten yet.'])
  })
})
