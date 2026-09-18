import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, defineTool } from './session.js'
import { emptyUsage } from './types.js'
import { BASH_TOOL } from '../tools/bash.js'
import { WRITE_TOOL } from '../tools/write.js'
import { READ_TOOL } from '../tools/read.js'
import type { Tool } from './session.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { AppEvent, ChatChunk, SessionNote, ToolResult } from './types.js'
import type { ModelFacts } from './config.js'

/**
 * How a turn ends. Every ending here is one a user has actually seen: a long
 * task that keeps going, a model asking for the same thing forever, and an
 * answer that arrives empty. What the tests read is the transcript and the
 * journal, because those are what the window draws and what the session file
 * keeps.
 */

/**
 * The journal minus the line every turn ends on. A test about how a turn ended
 * is about what the harness had to say, and every turn ends on a summary either
 * way.
 */
function said(session: Session): SessionNote[] {
  return session.notes.filter(note => note.kind !== 'summary')
}

/** Rounds in order, because these tests are about the loop, not about routing. */
class RoundProvider implements ChatProvider {
  rounds = 0
  readonly seen: ChatInput[] = []

  constructor(private readonly steps: (round: number) => ChatChunk[]) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    this.seen.push({ ...input, messages: [...input.messages] })
    this.rounds += 1
    for (const chunk of this.steps(this.rounds)) yield chunk
  }
}

function say(text: string): ChatChunk[] {
  return [{ kind: 'text', text }, { kind: 'done', usage: emptyUsage() }]
}

function call(name: string, args: Record<string, unknown>, id: string): ChatChunk[] {
  return [{ kind: 'tool', tool: { id, name, args: JSON.stringify(args) } }, { kind: 'done', usage: emptyUsage() }]
}

/** A tool that always works, so a failing round is never the reason a test ends. */
function counter(): { tool: Tool; runs: number } {
  const state = { runs: 0 }
  const tool: Tool = {
    input: { name: 'count', description: 'count one', inputSchema: { type: 'object', properties: {} } },
    async run(): Promise<ToolResult> {
      state.runs += 1
      return { ok: true, summary: `run ${state.runs}`, content: `run ${state.runs}` }
    },
  }
  return {
    tool,
    get runs() {
      return state.runs
    },
  }
}

async function session(provider: ChatProvider, tools: Tool[], facts?: ModelFacts): Promise<{ session: Session; events: AppEvent[]; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-session-'))
  const built = new Session(
    { sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', ...(facts === undefined ? {} : { facts }) },
    provider,
    tools,
  )
  const events: AppEvent[] = []
  for (const type of ['session.note', 'session.finished', 'tool_result'] as const) {
    built.bus.on(type, event => void events.push(event))
  }
  return { session: built, events, cwd }
}

describe('a turn that needs a lot of calls', () => {
  it('gets them: nothing cuts the loop off at a round count', async () => {
    const counting = counter()
    // Twenty rounds with the arguments differing every round, which is what a
    // real investigation looks like: nothing cuts the loop at a round count.
    const provider = new RoundProvider(round => (round <= 20 ? call('count', { step: round }, `c${round}`) : say('twenty files, all read')))
    const { session: s, events, cwd } = await session(provider, [counting.tool])

    await s.run('read everything')

    expect(counting.runs).toBe(20)
    expect(s.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'twenty files, all read' })
    expect(said(s)).toEqual([])
    expect(events.some(event => event.type === 'session.finished')).toBe(true)
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('a model asking for the same thing over and over', () => {
  it('is refused, told why, and the turn ends saying so', async () => {
    const counting = counter()
    const provider = new RoundProvider(round => call('count', { same: true }, `c${round}`))
    const { session: s, events, cwd } = await session(provider, [counting.tool])

    await s.run('look at that file')

    // Two identical calls run; from the third the harness answers instead of
    // the tool, so the model reads what it is doing rather than looping in
    // silence.
    expect(counting.runs).toBe(2)
    const results = events.filter(event => event.type === 'tool_result')
    expect(results.at(2)).toMatchObject({ result: { ok: false } })
    expect(results.at(2)?.type === 'tool_result' ? results.at(2)?.result.content : '').toContain('identical arguments')

    // And the turn stops rather than spinning: one note, on screen and in the
    // session file, that says this is what happened.
    const stuck = said(s).at(-1)
    expect(stuck?.kind).toBe('note')
    expect(stuck?.text).toContain('round in circles')
    expect(events.some(event => event.type === 'session.note')).toBe(true)
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('a provider whose usage report cannot be read', () => {
  it('keeps the answer and says once that the cost is unknown', async () => {
    const problem: ChatChunk = {
      kind: 'done',
      usage: emptyUsage(),
      usageProblem: 'usage arrived without prompt_tokens',
    }
    const provider = new RoundProvider(round => (round === 1 ? [{ kind: 'text', text: 'the answer' }, problem] : [problem]))
    const { session: s, cwd } = await session(provider, [])

    await s.run('first')
    await s.run('second')

    expect(s.transcript.some(message => message.role === 'assistant' && message.content === 'the answer')).toBe(true)
    // Once, not once per turn: the same provider does the same thing next time.
    const errors = s.notes.filter(note => note.kind === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.text).toContain('cost is unknown')
    await rm(cwd, { recursive: true, force: true })
  })

  it('leaves the cost off the turn line rather than printing a priced model as $0', async () => {
    const problem: ChatChunk = { kind: 'done', usage: emptyUsage(), usageProblem: 'usage arrived without prompt_tokens' }
    const provider = new RoundProvider(() => [{ kind: 'text', text: 'the answer' }, problem])
    const { session: s, cwd } = await session(provider, [], { input: 3, output: 15 })

    await s.run('first')

    // The turn already said the cost is unknown. A $0 on the same turn's line
    // would be the harness contradicting itself, and $0 reads as free.
    // The rest of the line is still there; the cost is the one part left off.
    const summary = s.notes.filter(note => note.kind === 'summary').at(-1)
    expect(summary?.text).toBe('no tool calls · <1s')
    expect(summary?.text).not.toContain('$')
    await rm(cwd, { recursive: true, force: true })
  })

  it('prices a turn whose report did arrive', async () => {
    const counted: ChatChunk = { kind: 'done', usage: { ...emptyUsage(), input: 1_000_000, output: 1_000_000 } }
    const provider = new RoundProvider(() => [{ kind: 'text', text: 'the answer' }, counted])
    const { session: s, cwd } = await session(provider, [], { input: 3, output: 15 })

    await s.run('first')

    expect(s.notes.filter(note => note.kind === 'summary').at(-1)?.text).toContain('$18.00')
    await rm(cwd, { recursive: true, force: true })
  })
})

/**
 * The ceiling the endpoint published travels with the model into every request,
 * because a model handed more than it will produce refuses the round.
 */
describe('a model with a published output ceiling', () => {
  it('builds the request inside it', async () => {
    const provider = new RoundProvider(() => say('the answer'))
    const { session: s, cwd } = await session(provider, [], { input: 3, output: 15, maxOutput: 64_000 })

    await s.run('first')

    expect(provider.seen[0]?.maxTokens).toBe(64_000)
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('a turn that comes back with nothing', () => {
  it('says so instead of ending on a blank window', async () => {
    const provider = new RoundProvider(() => [{ kind: 'done', usage: emptyUsage() }])
    const { session: s, cwd } = await session(provider, [BASH_TOOL])

    await s.run('what changed?')

    expect(said(s)).toHaveLength(1)
    expect(said(s)[0]?.text).toContain('ended without an answer')
    // Nothing empty is written down: a blank assistant message is a block some
    // providers refuse to be sent back.
    expect(s.transcript.filter(message => message.role === 'assistant')).toEqual([])
    await rm(cwd, { recursive: true, force: true })
  })
})

/**
 * Several calls in one assistant message. A tool that declared itself read-only
 * runs beside its siblings, because the model already paid for the round trip
 * once; a tool that said nothing is still exclusive, so a write never overlaps
 * the call after it. The result order is the model's own, which is what the
 * transcript needs to answer the calls in the order they were asked.
 */
describe('a message that asks for several tool calls', () => {
  function tracker(parallel: boolean): { tool: Tool; mostActive: () => number } {
    let active = 0
    let most = 0
    const tool = defineTool<{ path: string }>({
      ...(parallel ? { parallel: true } : {}),
      input: { name: 'peek', description: 'read one', inputSchema: { type: 'object', properties: {} } },
      parse: raw => (typeof raw.path === 'string' ? { ok: true, args: { path: raw.path } } : { ok: false, error: 'path must be a string' }),
      async run(args): Promise<ToolResult> {
        active += 1
        most = Math.max(most, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active -= 1
        return { ok: true, summary: `peeked at ${args.path}`, content: `peeked at ${args.path}` }
      },
    })
    return { tool, mostActive: () => most }
  }

  function batch(chunks: ChatChunk[]): ChatChunk[] {
    return [...chunks, { kind: 'done', usage: emptyUsage() }]
  }

  it('runs read-only calls together, and answers them in order', async () => {
    // The contract the whole mechanism exists for: `read` opted in.
    expect(READ_TOOL.parallel).toBe(true)
    const peeks = tracker(true)
    const provider = new RoundProvider(round =>
      round === 1
        ? batch([
            { kind: 'tool', tool: { id: 'a', name: 'peek', args: '{"path":"a.txt"}' } },
            { kind: 'tool', tool: { id: 'b', name: 'peek', args: '{"path":"b.txt"}' } },
          ])
        : say('both read'),
    )
    const { session: s, events, cwd } = await session(provider, [peeks.tool])

    await s.run('read both')

    expect(peeks.mostActive()).toBe(2)
    const answers = events.filter(event => event.type === 'tool_result').map(event => event.result.summary)
    expect(answers).toEqual(['peeked at a.txt', 'peeked at b.txt'])
    await rm(cwd, { recursive: true, force: true })
  })

  it('runs a tool that did not opt in on its own', async () => {
    // Same shape, no `parallel`: the calls must not overlap.
    const serial = tracker(false)
    const provider = new RoundProvider(round =>
      round === 1
        ? batch([
            { kind: 'tool', tool: { id: 'a', name: 'peek', args: '{"path":"a.txt"}' } },
            { kind: 'tool', tool: { id: 'b', name: 'peek', args: '{"path":"b.txt"}' } },
          ])
        : say('both read'),
    )
    const { session: s, cwd } = await session(provider, [serial.tool])

    await s.run('read both')

    expect(serial.mostActive()).toBe(1)
    await rm(cwd, { recursive: true, force: true })
  })

  it('turns a thrown tool into a result, so its siblings still answer', async () => {
    // A tool that throws is not an exception the turn is allowed to die on:
    // the calls beside it in the same message would be left without an answer,
    // and a provider refuses a conversation that ends on an unanswered call.
    const boom: Tool = {
      parallel: true,
      input: { name: 'boom', description: 'fail', inputSchema: { type: 'object', properties: {} } },
      async run(): Promise<ToolResult> {
        throw new Error('EISDIR: illegal operation on a directory')
      },
    }
    const peeks = tracker(true)
    const provider = new RoundProvider(round =>
      round === 1
        ? batch([
            { kind: 'tool', tool: { id: 'a', name: 'boom', args: '{}' } },
            { kind: 'tool', tool: { id: 'b', name: 'peek', args: '{"path":"b.txt"}' } },
          ])
        : say('recovered'),
    )
    const { session: s, events, cwd } = await session(provider, [boom, peeks.tool])

    await s.run('try both')

    const answers = events.filter(event => event.type === 'tool_result')
    expect(answers).toHaveLength(2)
    expect(answers[0]).toMatchObject({ result: { ok: false } })
    expect(answers[0]?.type === 'tool_result' ? answers[0].result.summary : '').toContain('boom failed')
    expect(answers[1]?.type === 'tool_result' ? answers[1].result.summary : '').toBe('peeked at b.txt')
    expect(s.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'recovered' })
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('the line a turn ends on', () => {
  it('says what the turn cost: its calls, the files it changed, and how long it ran', async () => {
    const provider = new RoundProvider(round => {
      if (round === 1) {
        return [
          { kind: 'tool', tool: { id: 'w1', name: 'write', args: JSON.stringify({ path: 'notes/one.txt', content: 'one' }) } },
          { kind: 'tool', tool: { id: 'w2', name: 'write', args: JSON.stringify({ path: 'notes/two.txt', content: 'two' }) } },
          { kind: 'done', usage: emptyUsage() },
        ]
      }
      // A write outside the session's folder is refused, so the turn has a
      // failure in it and nothing is added to the list of files it changed.
      if (round === 2) return call('write', { path: '../escape.txt', content: 'nope' }, 'w3')
      return say('both files written')
    })
    const { session: s, cwd } = await session(provider, [WRITE_TOOL])

    await s.run('write two files')

    const summary = s.notes.at(-1)
    expect(summary?.kind).toBe('summary')
    expect(summary?.text).toContain('3 tool calls, 2 ok, 1 failed')
    expect(summary?.text).toContain('2 files changed: notes/one.txt, notes/two.txt')
    // A mock provider answers in under a tick, which is the one duration that
    // has to read as a time rather than as a stopped clock.
    expect(summary?.text.endsWith('· <1s')).toBe(true)
    // The summary sits after everything the turn wrote, so a re-opened session
    // draws it under the answer rather than in the middle of the turn.
    expect(summary?.after).toBe(s.transcript.length)

    // The next turn counts itself, not the one before it.
    await s.run('and now say nothing')
    expect(s.notes.at(-1)?.text).toContain('no tool calls')
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('the notes a session keeps', () => {
  it('come back where they happened when the session is re-opened', async () => {
    const provider = new RoundProvider(round => (round === 1 ? call('count', { step: 1 }, 'c1') : say('done')))
    const counting = counter()
    const { session: s, cwd } = await session(provider, [counting.tool])
    await s.run('do a thing')
    s.note('Background builder finished: wrote two files')

    const note = s.notes.at(-1)
    expect(note?.after).toBe(s.transcript.length)

    // A rebuilt session is handed its stored notes and reports them again, so
    // the re-opened window shows what the first one did.
    const rebuilt = new Session(
      { sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', history: s.transcript },
      provider,
      [counting.tool],
    )
    rebuilt.restoreNotes(s.notes)
    expect(rebuilt.notes).toEqual(s.notes)
    await rm(cwd, { recursive: true, force: true })
  })
})

/**
 * How long the model spent generating, which is what the window divides output
 * tokens by. The session measures it rather than the renderer, because by the
 * time an event reaches the window the gap since the last one is mostly
 * whatever tool ran in between. `src/renderer/metrics.test.ts` has the arithmetic
 * on the other side of it.
 */
describe('how long the model spent generating', () => {
  it('measures the stream itself, so a round reports the time its chunks took', async () => {
    const provider: ChatProvider = {
      async *stream(): AsyncGenerator<ChatChunk> {
        yield { kind: 'text', text: 'thinking' }
        await new Promise(resolve => setTimeout(resolve, 60))
        yield { kind: 'text', text: ' about it' }
        yield { kind: 'done', usage: { input: 0, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }
      },
    }
    const { session: built, cwd } = await session(provider, [])
    const stamps: (number | undefined)[] = []
    built.bus.on('usage', event => void stamps.push(event.streamMs))

    await built.run('go')

    expect(stamps).toHaveLength(1)
    expect(stamps[0]).toBeGreaterThanOrEqual(50)
    await rm(cwd, { recursive: true, force: true })
  })

  it("sends no generation time with a subagent's tokens, which came off a stream it never timed", async () => {
    // A spawn reports back mid-turn, which is the only way this happens: the
    // child's bus is live while the parent is inside a round.
    const holder: { session: Session | null } = { session: null }
    const spawn: Tool = {
      input: { name: 'spawn', description: 'start one', inputSchema: { type: 'object', properties: {} } },
      async run(): Promise<ToolResult> {
        holder.session?.addSubagentUsage({ input: 0, output: 900, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
        return { ok: true, summary: 'the child answered' }
      },
    }
    const provider = new RoundProvider(round => (round === 1 ? call('spawn', {}, 'c1') : say('done')))
    const { session: built, cwd } = await session(provider, [spawn])
    holder.session = built
    const stamps: (number | undefined)[] = []
    built.bus.on('usage', event => void stamps.push(event.streamMs))

    await built.run('go')

    // Round one, then the spawn's total, then round two.
    expect(stamps).toHaveLength(3)
    expect(stamps[1]).toBeUndefined()
    expect(stamps[0]).toBeTypeOf('number')
    expect(stamps[2]).toBeTypeOf('number')
    // The spawn's tokens are still in the total the window counts.
    expect(built.spent.output).toBe(900)
    await rm(cwd, { recursive: true, force: true })
  })
})
