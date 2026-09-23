import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from './session.js'
import { cloneHistory } from './spawn.js'
import type { SpawnHost } from './spawn.js'
import { FLAT_SYSTEM, SUMMARY_INSTRUCTION, wrapSummary } from './compaction.js'
import { estimateParts, partsTotal, toolTokens } from './context.js'
import { costOf } from './cost.js'
import { emptyUsage } from './types.js'
import { createAnthropicProvider } from '../providers/anthropic.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { AppEvent, ChatChunk, ChatMessage, ToolResult, TurnUsage } from './types.js'
import type { ModelFacts } from './config.js'
import type { Tool } from './session.js'

/**
 * Compaction end to end: real turns against a scripted provider, until the
 * context crosses the threshold, with the requests the session made read back
 * afterwards. The cache is the reason the summary is asked for the way it is,
 * so the tests hold the summary request to the request before it byte for byte.
 */

/** What a request was for, told apart by what only that kind of request carries. */
type Kind = 'turn' | 'summary' | 'flat'

function kindOf(input: ChatInput): Kind {
  if (input.messages[0]?.content === FLAT_SYSTEM) return 'flat'
  if (input.messages.at(-1)?.content === SUMMARY_INSTRUCTION) return 'summary'
  return 'turn'
}

interface Seen {
  kind: Kind
  input: ChatInput
  usage: TurnUsage
}

type Script = (kind: Kind, input: ChatInput) => ChatChunk[]

/**
 * Reports every prompt at exactly the estimate, so the calibration stays at 1
 * and the thresholds below can be worked out by hand.
 */
class ScriptedProvider implements ChatProvider {
  readonly seen: Seen[] = []
  private held: { kind: Kind; release: Promise<void> } | null = null

  constructor(private readonly script: Script) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    const kind = kindOf(input)
    const usage = { ...emptyUsage(), input: estimateOf(input), output: 10 }
    this.seen.push({ kind, input, usage })
    if (this.held?.kind === kind) {
      const { release } = this.held
      this.held = null
      await release
    }
    for (const chunk of this.script(kind, input)) {
      yield chunk
      if (chunk.kind === 'error') return
    }
    yield { kind: 'done', usage }
  }

  /** Hold the next request of this kind until the returned function is called. */
  hold(kind: Kind): () => void {
    let open = (): void => {}
    const release = new Promise<void>(resolve => {
      open = resolve
    })
    this.held = { kind, release }
    return open
  }

  of(kind: Kind): Seen[] {
    return this.seen.filter(one => one.kind === kind)
  }
}

function estimateOf(input: ChatInput): number {
  return partsTotal(estimateParts(input.messages, toolTokens(input.tools)))
}

const BLOB: Tool = {
  input: {
    name: 'blob',
    description: 'return that many characters',
    inputSchema: { type: 'object', properties: { size: { type: 'number' }, call: { type: 'number' } }, required: ['size'] },
  },
  async run(args): Promise<ToolResult> {
    const content = 'x'.repeat(Number(args.size))
    return { ok: true, summary: `${content.length} characters`, content }
  },
}

/**
 * A model that works: each turn it calls `blob` `calls` times, one call a
 * round, then answers. `size` says how long the nth call's output is, counted
 * across the session. Each call carries its number, because the session ends a
 * turn that asks for the same call over and over. Summaries come back as
 * `summary 1`, `summary 2` and so on.
 */
function worker(size: (n: number) => number, calls = 1): Script {
  let made = 0
  // Kept here and not read off the request: after a compaction the request no
  // longer shows every call this turn made.
  let thisTurn = 0
  let summaries = 0
  return kind => {
    if (kind === 'summary') return [{ kind: 'text', text: `summary ${(summaries += 1)}` }]
    if (kind === 'flat') return [{ kind: 'text', text: 'flat summary' }]
    if (thisTurn >= calls) {
      thisTurn = 0
      return [{ kind: 'text', text: `done after ${made} calls` }]
    }
    thisTurn += 1
    made += 1
    return [{ kind: 'tool', tool: { id: `c${made}`, name: 'blob', args: JSON.stringify({ size: size(made), call: made }) } }]
  }
}

/**
 * A 4,000-token window with 1,000 kept for the answer: 3,000 usable, the
 * threshold at 2,400 and about 640 tokens kept verbatim after a summary. A
 * 2,000-character output is about 500 tokens, so a turn adds a little over 500
 * and the fifth one crosses.
 */
const SMALL: ModelFacts = { context: 4_000, maxOutput: 1_000 }

const cleanup: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Harness {
  session: Session
  events: AppEvent[]
}

async function open(
  provider: ChatProvider,
  facts: ModelFacts | undefined,
  extra: { history?: ChatMessage[]; autoCompact?: boolean; contextLimit?: number; spawn?: SpawnHost } = {},
): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-compaction-'))
  cleanup.push(cwd)
  const session = new Session(
    {
      sessionId: 'test',
      cwd,
      model: 'test-model',
      systemPrompt: 'You are a test.',
      effort: 'high',
      ...(facts === undefined ? {} : { facts }),
      ...extra,
    },
    provider,
    [BLOB],
  )
  const events: AppEvent[] = []
  for (const type of ['context.compacting', 'context.compacted', 'session.error', 'session.finished', 'session.stopped'] as const) {
    session.bus.on(type, (event: AppEvent) => void events.push(event))
  }
  return { session, events }
}

/** A spawn host with no subagents, which counts how often it is told to stop them all. */
function countingSpawn(): SpawnHost & { stops: number } {
  const host = {
    stops: 0,
    run: () => Promise.reject(new Error('no subagents here')),
    background: () => {
      throw new Error('no subagents here')
    },
    stopAll: () => {
      host.stops += 1
    },
    setFacts: () => undefined,
    setAutoCompact: () => undefined,
    setContextLimit: () => undefined,
  }
  return host
}

/** Run turns until the provider has been asked for a summary, and say which turn that was. */
async function runUntilSummary(session: Session, provider: ScriptedProvider, most = 12): Promise<number> {
  for (let turn = 1; turn <= most; turn += 1) {
    await session.run(`task ${turn}`)
    if (provider.of('summary').length > 0) return turn
  }
  throw new Error(`no summary was asked for in ${most} turns`)
}

/** Every tool result follows the assistant message that asked for it. */
function balanced(messages: readonly ChatMessage[]): boolean {
  const asked = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant') for (const call of m.toolCalls ?? []) asked.add(call.id)
    if (m.role === 'tool' && !asked.has(m.toolCallId)) return false
  }
  return true
}

function isSummary(m: ChatMessage | undefined): boolean {
  return m?.role === 'user' && m.summary === true
}

function notesStartingWith(session: Session, start: string): string[] {
  return session.notes.map(n => n.text).filter(text => text.startsWith(start))
}

describe('automatic compaction', () => {
  it('asks for the summary on the request the session had already sent, then sends the summary in place of the history', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000))
    const { session, events } = await open(provider, SMALL)

    const turn = await runUntilSummary(session, provider)

    const index = provider.seen.findIndex(one => one.kind === 'summary')
    const summary = provider.seen[index] as Seen
    const before = provider.seen[index - 1] as Seen
    const after = provider.seen[index + 1] as Seen
    expect(provider.of('summary')).toHaveLength(1)
    expect(before.kind).toBe('turn')
    expect(after.kind).toBe('turn')

    // The summary request is the request the session was about to send, with
    // the instruction on the end. The one before it is a prefix of it, which is
    // what the provider has cached, and the tools and settings are the same,
    // so none of it is read again at the full rate.
    expect(summary.input.messages.slice(0, before.input.messages.length)).toEqual(before.input.messages)
    expect(summary.input.messages.at(-1)).toEqual({ role: 'user', content: SUMMARY_INSTRUCTION })
    expect(summary.input.tools).toEqual(before.input.tools)
    expect(summary.input.effort).toBe(before.input.effort)
    expect(summary.input.maxTokens).toBe(before.input.maxTokens)

    // The next request opens with the summary, carries none of what went
    // into it, and still pairs every tool result with its call.
    const folded = session.transcript.filter(m => m.compacted === 'compacted')
    expect(folded.length).toBeGreaterThan(0)
    expect(after.input.messages[0]).toEqual({ role: 'system', content: 'You are a test.' })
    expect(after.input.messages[1]).toEqual({ role: 'user', content: wrapSummary('summary 1'), summary: true })
    const sent = new Set(after.input.messages.map(m => m.content))
    for (const m of folded.filter(m => m.role === 'user')) expect(sent.has(m.content)).toBe(false)
    expect(balanced(after.input.messages)).toBe(true)
    expect(estimateOf(after.input)).toBeLessThan(estimateOf(before.input))

    const kinds = events.map(e => e.type)
    expect(kinds.indexOf('context.compacting')).toBeLessThan(kinds.indexOf('context.compacted'))
    const done = events.find(e => e.type === 'context.compacted')
    expect(done).toMatchObject({ reason: 'auto', compacted: folded.length, pruned: [], summary: 'summary 1' })
    expect(notesStartingWith(session, 'Compacted automatically:')).toHaveLength(1)

    // The transcript keeps every message the user saw, marked, and the
    // summary where it was made.
    const users = session.transcript.filter(m => m.role === 'user' && !isSummary(m)).map(m => m.content)
    expect(users).toEqual(Array.from({ length: turn }, (_, i) => `task ${i + 1}`))
    expect(session.transcript.filter(isSummary)).toEqual([{ role: 'user', content: 'summary 1', summary: true }])

    // The summary was paid for, and it is the harness's spend.
    expect(session.spentByHarness.input).toBe(summary.usage.input)
    expect(session.context.compactions).toHaveLength(1)
  })

  it('works against the user’s limit where that is under the window, and against the window once it is cleared', async () => {
    // The same 1,000 kept for the answer as SMALL, under a window of a million
    // with the user's limit at SMALL's size. It should compact on the same turn.
    const HUGE: ModelFacts = { context: 1_000_000, maxOutput: 1_000 }
    const small = new ScriptedProvider(worker(() => 2_000))
    const expected = await runUntilSummary((await open(small, SMALL)).session, small)
    const provider = new ScriptedProvider(worker(() => 2_000))
    const { session } = await open(provider, HUGE, { contextLimit: 4_000 })

    expect(session.context).toMatchObject({ window: 1_000_000, limit: 4_000, room: 4_000, usable: 3_000, threshold: 2_400 })
    expect(await runUntilSummary(session, provider)).toBe(expected)

    session.setContextLimit(undefined)
    expect(session.context).toMatchObject({ limit: null, room: 1_000_000, usable: 999_000, threshold: 799_200 })
    const summaries = provider.of('summary').length
    await session.run('one more')
    expect(provider.of('summary')).toHaveLength(summaries)
  })

  it('keeps the message a long turn started from, however many times the turn is compacted', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000, 8))
    const { session } = await open(provider, SMALL)

    await session.run('do eight things')

    // Eight outputs of about 500 tokens fill the window twice over. The second
    // summary is written with the first in front of it and takes its place.
    expect(provider.of('summary')).toHaveLength(2)
    const index = provider.seen.findLastIndex(one => one.kind === 'summary')
    const after = (provider.seen[index + 1] as Seen).input.messages
    expect(after.filter(isSummary)).toEqual([{ role: 'user', content: wrapSummary('summary 2'), summary: true }])
    expect(session.transcript.find(m => m.content === 'summary 1')?.compacted).toBe('compacted')
    // A subagent's whole life is one turn. Summarising the task would leave it
    // working from a paraphrase of its orders.
    expect(isSummary(after[1])).toBe(true)
    expect(after[2]).toEqual({ role: 'user', content: 'do eight things' })
    expect(after[3]?.role).toBe('assistant')
    expect(balanced(after)).toBe(true)
    expect(session.transcript.find(m => m.content === 'do eight things')?.compacted).toBeUndefined()
  })

  it('carries into a clone, which compacts without touching the parent', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000))
    const parent = await open(provider, SMALL)
    await runUntilSummary(parent.session, provider)

    const childProvider = new ScriptedProvider(worker(() => 2_000))
    const child = await open(childProvider, SMALL, { history: cloneHistory(parent.session.transcript) })
    // The clone sees exactly what the parent's model sees: the markers came
    // with the messages.
    expect(child.session.wireMessages()).toEqual(parent.session.wireMessages())

    // One turn of its own, so there is more behind the kept tail than the
    // parent's compaction left.
    const stored = JSON.stringify(parent.session.transcript)
    await child.session.run('carry on alone')
    const spend = await child.session.compact()

    expect(spend.compacted).toBe(true)
    expect(JSON.stringify(parent.session.transcript)).toBe(stored)
    expect(child.session.wireMessages()).not.toEqual(parent.session.wireMessages())
  })

  it('falls back to a summary made from the history as text when the model keeps calling tools instead', async () => {
    const work = worker(() => 2_000)
    const provider = new ScriptedProvider((kind, input) =>
      kind === 'summary' ? [{ kind: 'tool', tool: { id: 'no', name: 'blob', args: '{"size":1}' } }] : work(kind, input),
    )
    const { session } = await open(provider, SMALL)

    for (let turn = 1; provider.of('flat').length === 0; turn += 1) {
      if (turn > 12) throw new Error('no flat summary was asked for in 12 turns')
      await session.run(`task ${turn}`)
    }

    expect(provider.of('summary')).toHaveLength(2)
    const flat = provider.of('flat')
    expect(flat).toHaveLength(1)
    expect(flat[0]?.input.tools).toEqual([])
    expect(flat[0]?.input.messages).toHaveLength(2)
    // The history goes as text, newest first into the budget, so the last
    // message folded away is always in it.
    const folded = session.transcript.filter(m => m.compacted === 'compacted' && m.role === 'user')
    expect(flat[0]?.input.messages[1]?.content).toContain(`User:\n${folded.at(-1)?.content ?? 'nothing'}`)
    expect(session.transcript.filter(isSummary)).toEqual([{ role: 'user', content: 'flat summary', summary: true }])
    expect(session.wireMessages()[1]?.content).toBe(wrapSummary('flat summary'))
  })

  it('stops trying for the rest of the turn when a compaction leaves the context over the threshold', async () => {
    // 2,000 usable and the threshold at 1,600. After a small first turn, one
    // output of 7,000 characters is most of the window by itself. The summary
    // folds the first turn away and the context is still over. The second
    // output takes it past the usable space, where the check would prune and
    // then summarise flat, paying for a summary that frees next to nothing.
    const provider = new ScriptedProvider(worker(n => (n <= 2 ? 100 : 7_000), 2))
    const { session, events } = await open(provider, { context: 3_000, maxOutput: 1_000 })
    await session.run('a small task')
    await session.run('a large task')

    expect(provider.of('summary')).toHaveLength(1)
    expect(provider.of('flat')).toHaveLength(0)
    expect(session.context.tokens).toBeGreaterThan(session.context.usable ?? Infinity)
    expect(events.filter(e => e.type === 'session.finished')).toHaveLength(2)

    // The next turn tries again, since the user may have asked for less.
    await session.run('a third task')
    expect(provider.of('summary').length + provider.of('flat').length).toBeGreaterThan(1)
  })
})

describe('stopping a compaction', () => {
  it('ends the turn when Stop comes during an automatic summary, and sends nothing after it', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000, 8))
    const spawn = countingSpawn()
    const { session, events } = await open(provider, SMALL, { spawn })

    const release = provider.hold('summary')
    const turn = session.run('do eight things')
    await vi.waitFor(() => expect(provider.of('summary')).toHaveLength(1))
    const sent = provider.seen.length
    session.stop()
    release()
    await turn

    expect(provider.seen).toHaveLength(sent)
    expect(provider.of('flat')).toHaveLength(0)
    expect(session.transcript.some(isSummary)).toBe(false)
    expect(events.filter(e => e.type === 'context.compacted')).toHaveLength(0)
    expect(events.filter(e => e.type === 'session.stopped')).toHaveLength(1)
    // The turn's own stop says what happened; the compaction adds nothing to it.
    expect(notesStartingWith(session, 'The context could not be compacted')).toHaveLength(0)
    expect(notesStartingWith(session, 'Compaction stopped')).toHaveLength(0)
    expect(spawn.stops).toBe(1)
  })

  it('leaves the history as it was and the background subagents running when Stop comes during one by hand', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000))
    const spawn = countingSpawn()
    const { session, events } = await open(provider, SMALL, { autoCompact: false, spawn })
    for (const task of ['task 1', 'task 2', 'task 3']) await session.run(task)
    const before = session.wireMessages()

    const release = provider.hold('summary')
    const compaction = session.compact()
    await vi.waitFor(() => expect(provider.of('summary')).toHaveLength(1))
    session.stop()
    release()

    expect((await compaction).compacted).toBe(false)
    expect(provider.of('summary')).toHaveLength(1)
    expect(provider.of('flat')).toHaveLength(0)
    expect(session.wireMessages()).toEqual(before)
    expect(notesStartingWith(session, 'Compaction stopped.')).toHaveLength(1)
    expect(spawn.stops).toBe(0)

    // The stop belonged to the compaction, so the next turn runs as usual.
    await session.run('task 4')
    expect(events.filter(e => e.type === 'session.finished')).toHaveLength(4)
  })
})

describe('a request the provider refuses as too long', () => {
  /**
   * A server that will not take any request carrying an output longer than
   * 30,000 characters, and says so the way such servers do.
   */
  function refusing(always: boolean): ScriptedProvider {
    const work = worker(() => 40_000)
    return new ScriptedProvider((kind, input) => {
      const long = input.messages.some(m => m.content.length > 30_000)
      if (kind === 'turn' && (always ? input.messages.at(-1)?.role === 'tool' : long)) {
        return [{ kind: 'error', message: 'prompt is too long: 12000 tokens > 8000 maximum', status: 400 }]
      }
      return work(kind, input)
    })
  }

  it('shortens the long tool output and asks once more, keeping the whole output in the transcript', async () => {
    const provider = refusing(false)
    const { session, events } = await open(provider, undefined)

    await session.run('read the big file')

    const turns = provider.of('turn')
    expect(turns).toHaveLength(3)
    const retried = turns[2]?.input.messages.find(m => m.role === 'tool')
    expect(retried?.content).toContain('[harness: 34880 characters of this output were removed to save context]')
    expect(retried?.content.length).toBeLessThan(6_000)
    expect(events.find(e => e.type === 'context.compacted')).toMatchObject({ reason: 'overflow', compacted: 0, pruned: ['c1'] })

    const stored = session.transcript.find(m => m.role === 'tool')
    expect(stored?.content).toHaveLength(40_000)
    expect(stored?.compacted).toBe('pruned')
    expect(notesStartingWith(session, 'Compacted after the provider refused the request as too long:')).toHaveLength(1)
  })

  it('ends the turn on a second refusal, since what is left will not get any shorter', async () => {
    const provider = refusing(true)
    const { session, events } = await open(provider, undefined)

    await expect(session.run('read the big file')).rejects.toThrow(/too long/)

    expect(provider.of('turn')).toHaveLength(3)
    expect(events.filter(e => e.type === 'context.compacted')).toHaveLength(1)
    expect(events.filter(e => e.type === 'session.error')).toHaveLength(1)
  })

  it('is not answered at all with automatic compaction off', async () => {
    const provider = refusing(false)
    const { session, events } = await open(provider, undefined, { autoCompact: false })

    await expect(session.run('read the big file')).rejects.toThrow(/too long/)

    expect(provider.of('turn')).toHaveLength(2)
    expect(events.filter(e => e.type === 'context.compacting')).toHaveLength(0)
    expect(session.transcript.find(m => m.role === 'tool')?.compacted).toBeUndefined()
  })
})

describe('compacting by hand', () => {
  const PRICED: ModelFacts = { ...SMALL, input: 3, output: 15 }

  it('summarises between turns and reports what the summary cost', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000))
    const { session, events } = await open(provider, PRICED, { autoCompact: false })
    for (const task of ['task 1', 'task 2', 'task 3']) await session.run(task)

    const spend = await session.compact()

    const summary = provider.of('summary')
    expect(summary).toHaveLength(1)
    expect(spend.compacted).toBe(true)
    expect(spend.usage).toEqual(summary[0]?.usage)
    expect(spend.costUsd).toBe(costOf(summary[0]?.usage ?? emptyUsage(), PRICED))
    expect(events.find(e => e.type === 'context.compacted')).toMatchObject({ reason: 'manual' })
    expect(notesStartingWith(session, 'Compacted on request:')).toHaveLength(1)
  })

  it('says so when everything still fits in the part kept verbatim', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000))
    const { session } = await open(provider, SMALL)
    await session.run('task 1')

    const spend = await session.compact()

    expect(spend.compacted).toBe(false)
    expect(provider.of('summary')).toHaveLength(0)
    expect(notesStartingWith(session, 'There is nothing to compact yet')).toHaveLength(1)
  })

  it('does not run while a turn does, and a turn does not start while it runs', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000))
    const { session } = await open(provider, SMALL)
    for (const task of ['task 1', 'task 2', 'task 3']) await session.run(task)

    const releaseTurn = provider.hold('turn')
    const turn = session.run('task 4')
    await vi.waitFor(() => expect(provider.of('turn')).toHaveLength(7))
    expect((await session.compact()).compacted).toBe(false)
    expect(provider.of('summary')).toHaveLength(0)
    releaseTurn()
    await turn

    const releaseSummary = provider.hold('summary')
    const compaction = session.compact()
    await vi.waitFor(() => expect(provider.of('summary')).toHaveLength(1))
    await expect(session.run('task 5')).rejects.toThrow(/busy/)
    releaseSummary()
    expect((await compaction).compacted).toBe(true)
  })
})

describe('the summary on the Anthropic wire', () => {
  it('shares one user message with the message kept after it, summary first', async () => {
    const provider = new ScriptedProvider(worker(() => 2_000, 8))
    const { session } = await open(provider, SMALL)
    await session.run('do eight things')
    const index = provider.seen.findIndex(one => one.kind === 'summary')
    const request = (provider.seen[index + 1] as Seen).input

    const bodies: { messages: { role: string; content: { type: string; text?: string }[] }[] }[] = []
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as (typeof bodies)[number])
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n'))
          controller.close()
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    })
    const anthropic = createAnthropicProvider({ apiKey: 'k', baseURL: 'https://host/v1' })
    for await (const chunk of anthropic.stream(request)) void chunk

    const messages = bodies[0]?.messages ?? []
    for (let i = 1; i < messages.length; i += 1) expect(messages[i]?.role).not.toBe(messages[i - 1]?.role)
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content.map(block => block.text)).toEqual([wrapSummary('summary 1'), 'do eight things'])
  })
})
