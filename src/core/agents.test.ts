import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, agentPrompt } from './agents.js'
import { EventBus } from './event-bus.js'
import { ReadIndex } from './read-index.js'
import { JobRegistry } from './jobs.js'
import type { JobState } from './jobs.js'
import { Session } from './session.js'
import { cloneHistory, createSpawnHost } from './spawn.js'
import { workspaceGate } from './scope.js'
import type { AccessGate } from './scope.js'
import { emptyUsage } from './types.js'
import { BASH_TOOL, GUARDED_BASH_TOOL } from '../tools/bash.js'
import { EDIT_TOOL } from '../tools/edit.js'
import { JOB_UPDATE_TOOL } from '../tools/job-update.js'
import { READ_TOOL } from '../tools/read.js'
import { SPAWN_TOOL } from '../tools/spawn.js'
import { WRITE_TOOL } from '../tools/write.js'
import type { Tool } from './session.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { SubagentRecord } from './spawn.js'
import type { AppEvent, ChatChunk, ChatMessage } from './types.js'

/**
 * A turn that delegates, end to end. The provider is the only fake: the session
 * loop, the tool boundary, the spawn host, the job registry and the real shell
 * are the code under test. What the tests read is what actually went on the
 * wire: the subagent's system prompt, its tool list and its effort, because
 * that is the whole of what a role and a spawn mode decide.
 */

const PARENT_PROMPT = 'You are the parent.'
/** The session's own effort setting, which every subagent it starts inherits. */
const PARENT_EFFORT = 'low'

/**
 * Answers from a script keyed by the conversation's last user message: the
 * parent's turn text for the parent, the task for a subagent. A background job
 * runs alongside the parent's turn, so answering by call order would be a race.
 */
class ScriptedProvider implements ChatProvider {
  readonly calls: ChatInput[] = []
  private readonly pending = new Map<string, ChatChunk[][]>()

  /**
   * Tasks the provider never answers. A subagent that is still waiting on its
   * request is the only state in which stopping one means anything, so a test
   * about stop needs a request that ends when the signal says so and not before.
   */
  constructor(
    private readonly script: Record<string, ChatChunk[][]>,
    private readonly held: readonly string[] = [],
  ) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    this.calls.push({ ...input, messages: [...input.messages], tools: [...input.tools] })
    const key = lastUser(input.messages)
    if (this.held.includes(key)) {
      const signal = input.signal
      if (signal === undefined) throw new Error('a held request needs a signal')
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new DOMException('aborted', 'AbortError')
    }
    if (!this.pending.has(key)) this.pending.set(key, [...(this.script[key] ?? [])])
    const step = this.pending.get(key)?.shift() ?? say(`nothing scripted for: ${key}`)
    for (const chunk of step) yield chunk
  }
}

function lastUser(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user') return message.content
  }
  return ''
}

function call(name: string, args: Record<string, unknown>, id = 'call-1'): ChatChunk[] {
  return [{ kind: 'tool', tool: { id, name, args: JSON.stringify(args) } }, { kind: 'done', usage: emptyUsage() }]
}

function say(text: string): ChatChunk[] {
  return [{ kind: 'text', text }, { kind: 'done', usage: emptyUsage() }]
}

const PARENT_TOOLS: Tool[] = [BASH_TOOL, READ_TOOL, WRITE_TOOL, EDIT_TOOL, SPAWN_TOOL]

interface Harness {
  session: Session
  provider: ScriptedProvider
  jobs: JobRegistry
  events: AppEvent[]
  /** How a job ended, from its `job.finished` event. The registry only holds what runs. */
  ended(id: string): { state: JobState; note: string } | undefined
  /** Every subagent transcript the host handed over, as the window would store it. */
  saved: { id: string; record: SubagentRecord }[]
}

/**
 * The wiring the app does in `src/main/index.ts`, cut down to what a test can
 * hold: one parent session with a spawn host whose `setup` builds a distinct
 * agent from its role, and a clone from the parent's own prompt and tools.
 */
function harness(
  script: Record<string, ChatChunk[][]>,
  cwd: string,
  held: readonly string[] = [],
  breakSave = false,
): Harness {
  const provider = new ScriptedProvider(script, held)
  const saved: { id: string; record: SubagentRecord }[] = []
  const bus = new EventBus()
  const events: AppEvent[] = []
  for (const type of ['job.started', 'job.update', 'job.finished'] as const) bus.on(type, event => void events.push(event))
  const jobs = new JobRegistry(bus)
  const access = workspaceGate(cwd)
  const env = { root: cwd, platform: process.platform, shell: 'bash', today: '2026-01-01' }

  const parent: { session?: Session } = {}
  const session = new Session(
    {
      sessionId: 'parent',
      cwd,
      model: 'test-model',
      systemPrompt: PARENT_PROMPT,
      effort: PARENT_EFFORT,
      access,
      spawn: createSpawnHost({
        sessionId: 'parent',
        role: 'builder',
        cwd,
        model: 'test-model',
        provider,
        access,
        jobs,
        save: (slot, record) => {
          if (breakSave) throw new Error('EACCES: permission denied')
          saved.push({ id: slot.id, record })
        },
        // What `src/main/index.ts` does: the failure goes where the user is
        // already looking, not to a stderr nobody has open.
        problem: text => {
          parent.session?.fault(text)
        },
        // Also what the app does: a background job's answer goes back into the
        // conversation that started it, as well as into the window.
        finished: (slot, outcome) => {
          parent.session?.deliver(
            `Background ${outcome.request.role} job ${slot.id} ${outcome.state}. It was asked: ${outcome.request.task}

What it answered:
${outcome.answer}`,
          )
        },
        setup: async (request, slot) => {
          if (request.mode === 'clone') {
            return {
              systemPrompt: PARENT_PROMPT,
              tools: PARENT_TOOLS,
              history: cloneHistory(parent.session?.transcript ?? []),
              effort: PARENT_EFFORT,
            }
          }
          const shell = AGENTS[request.role].bash === 'guarded' ? GUARDED_BASH_TOOL : BASH_TOOL
          const writes = AGENTS[request.role].tools.includes('write') ? [WRITE_TOOL, EDIT_TOOL] : []
          return {
            systemPrompt: agentPrompt(request.role, env),
            // Only a background child gets `job_update`: a foreground one is
            // being waited on, and its answer is its report.
            tools: [shell, READ_TOOL, ...writes, ...(slot.background ? [JOB_UPDATE_TOOL] : [])],
            effort: PARENT_EFFORT,
          }
        },
      }),
    },
    provider,
    PARENT_TOOLS,
    bus,
  )
  parent.session = session
  const ended = (id: string): { state: JobState; note: string } | undefined => {
    for (const event of events) {
      if (event.type === 'job.finished' && event.job.id === id) return { state: event.job.state, note: event.job.note }
    }
    return undefined
  }

  return { session, provider, jobs, events, ended, saved }
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nh-agents-'))
}

/** A gate that says yes to every path and command, for shell mechanics. */
function openGate(root: string): AccessGate {
  return {
    root,
    check: async target => ({ ok: true, path: target }),
    checkCommand: async () => ({ ok: true }),
  }
}

describe('spawn', () => {
  /**
   * A parent reads a spawn's result as the whole of what the subagent found, so
   * a review whose verdict is in its last paragraph has to arrive with that
   * paragraph. The only bound on an answer is the model's own output limit,
   * which is a real bound in the right place.
   */
  it('hands over a long answer whole', async () => {
    const cwd = await workspace()
    try {
      const long = `${'finding after finding. '.repeat(5000)}and the verdict is: ship it`
      const { session, ended, events } = harness(
        {
          'review it': [call('spawn', { role: 'planner', mode: 'distinct', task: 'review the change' }), say('done')],
          'review the change': [say(long)],
        },
        cwd,
      )

      await session.run('review it')

      expect(long.length).toBeGreaterThan(100_000)
      const handed = session.transcript.find(message => message.role === 'tool')
      expect(handed?.content).toContain('the verdict is: ship it')
      expect(handed?.content).not.toContain('…')

      // The job row is the one place a length limit is still right: it is a
      // label for the answer, not the answer.
      const started = events.find(event => event.type === 'job.started')
      const row = started?.type === 'job.started' ? ended(started.job.id) : undefined
      expect((row?.note ?? '').length).toBeLessThanOrEqual(200)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('runs a distinct subagent as the role it was asked for and hands its answer back', async () => {
    const cwd = await workspace()
    try {
      const { session, provider } = harness(
        {
          'what should we do first?': [
            call('spawn', { role: 'planner', mode: 'distinct', task: 'plan the migration' }),
            say('the planner says: start with the schema'),
          ],
          'plan the migration': [say('read the plan first, then start with the schema')],
        },
        cwd,
      )

      await session.run('what should we do first?')

      // Three requests: the parent's, the subagent's, and the parent's again.
      expect(provider.calls).toHaveLength(3)
      const child = provider.calls[1]
      expect(child?.messages[0]?.content).toContain('You are the planner')
      // A distinct subagent cannot spawn, so its prompt does not carry the
      // routing rule, which names the spawn tool.
      expect(child?.messages[0]?.content).not.toContain('harness-editor subagent')
      // A distinct agent starts from nothing: the parent's turn is not in it.
      expect(child?.messages).toHaveLength(2)
      // The planner cannot write, and the tool list is where that is enforced.
      expect(child?.tools.map(tool => tool.name)).toEqual(['bash', 'read'])
      // Effort is the session's setting, not the role's: the planner thinks as
      // hard as the person at the keyboard asked this session to think.
      expect(child?.effort).toBe(PARENT_EFFORT)

      const answer = session.transcript.find(message => message.role === 'tool')
      expect(answer?.content).toContain('start with the schema')
      // The parent is told what the delegation cost it.
      expect(answer?.content).toContain('[planner/distinct:')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('gives a clone the parent\'s prompt, tools and history, which is the point of the mode', async () => {
    const cwd = await workspace()
    try {
      const { session, provider } = harness(
        {
          'rename the helper everywhere': [
            call('spawn', { role: 'builder', mode: 'clone', task: 'rename the helper' }),
            say('renamed'),
          ],
          'rename the helper': [say('renamed it in four files')],
        },
        cwd,
      )

      await session.run('rename the helper everywhere')

      const first = provider.calls[0]
      const child = provider.calls[1]
      // Byte-identical prefix, or the provider's cache pays for none of it.
      expect(child?.messages[0]?.content).toBe(first?.messages[0]?.content)
      expect(child?.tools).toEqual(first?.tools)
      expect(child?.messages.some(message => message.role === 'user' && message.content === 'rename the helper everywhere')).toBe(true)
      // The parent is inside the `spawn` call while the clone runs, so its last
      // message is an assistant turn whose tool call has no result yet. Handing
      // that to a provider is a 400 ("an assistant message with 'tool_calls'
      // must be followed by tool messages"), so the in-flight turn is cut.
      const answers = new Set((child?.messages ?? []).flatMap(m => (m.role === 'tool' ? [m.toolCallId] : [])))
      const dangling = (child?.messages ?? []).flatMap(m => (m.role === 'assistant' ? (m.toolCalls ?? []) : [])).filter(c => !answers.has(c.id))
      expect(dangling).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('runs a clone asked for another role as a distinct agent of that role', async () => {
    const cwd = await workspace()
    try {
      const { session, provider } = harness(
        {
          'what breaks if we drop the cache?': [
            call('spawn', { role: 'planner', mode: 'clone', task: 'find what depends on the cache' }),
            say('the planner found three callers'),
          ],
          'find what depends on the cache': [say('three callers, all in core')],
        },
        cwd,
      )

      await session.run('what breaks if we drop the cache?')

      // A clone is the parent's prompt and the parent's tools, so a clone "as a
      // planner" would be a builder with a planner's name on the job. The mode
      // gives way to the role, and the cost line says which one actually ran.
      const child = provider.calls[1]
      expect(child?.messages[0]?.content).toContain('You are the planner')
      expect(child?.tools.map(tool => tool.name)).toEqual(['bash', 'read'])
      const answer = session.transcript.find(message => message.role === 'tool')
      expect(answer?.content).toContain('[planner/distinct:')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('refuses to let a subagent summon another one', async () => {
    const cwd = await workspace()
    try {
      const { session, provider } = harness(
        {
          go: [call('spawn', { role: 'builder', mode: 'clone', task: 'do the thing' }), say('done')],
          'do the thing': [
            call('spawn', { role: 'planner', mode: 'distinct', task: 'and another' }, 'call-2'),
            say('nobody to delegate to, so I did it myself'),
          ],
        },
        cwd,
      )

      await session.run('go')

      const refused = provider.calls
        .flatMap(input => input.messages)
        .filter(message => message.role === 'tool')
        .find(message => message.content.includes('spawn is not available here'))
      expect(refused).toBeDefined()
      // The model is told the call failed, not handed a plausible-looking answer.
      expect(refused?.failed).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('background jobs', () => {
  it('lets the turn finish at once and reports the job\'s progress and its answer', async () => {
    const cwd = await workspace()
    try {
      const { session, jobs, events, ended } = harness(
        {
          'update the docs while we talk': [
            call('spawn', { role: 'builder', mode: 'distinct', task: 'update the docs', background: true }),
            say('started it in the background'),
          ],
          'update the docs': [call('job_update', { note: 'read the ledger' }), say('docs updated')],
        },
        cwd,
      )

      await session.run('update the docs while we talk')

      // The turn came back with a job id and not the work.
      const started = jobs.list()[0]
      expect(started?.role).toBe('builder')
      const answer = session.transcript.find(message => message.role === 'tool')
      expect(answer?.content).toContain(`background job ${started?.id ?? ''}`)

      // How it ended is the `job.finished` event: the registry lists what is
      // running, and drops an entry once its transcript is on disk.
      await vi.waitFor(() => expect(ended(started?.id ?? '')?.state).toBe('done'))
      expect(ended(started?.id ?? '')?.note).toContain('docs updated')
      expect(jobs.list()).toEqual([])

      const types = events.map(event => event.type)
      expect(types).toEqual(['job.started', 'job.update', 'job.finished'])
      expect(events.some(event => event.type === 'job.update' && event.note === 'read the ledger')).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  /**
   * A background job's answer has to reach the model as well as the window: a
   * note carries the first line and nothing else, and the full answer sits
   * under the app's data directory, outside the workspace, where the agent may
   * not read it. "Start three of these and tell me what they found" only works
   * if each answer is folded into the conversation.
   */
  it('puts what the job answered into the conversation the model reads', async () => {
    const cwd = await workspace()
    try {
      const { session, events, ended } = harness(
        {
          'check both files while we talk': [
            call('spawn', { role: 'planner', mode: 'distinct', task: 'check the first file', background: true }),
            say('started it'),
          ],
          'check the first file': [say('the first file is fine, except line 40 is dead code')],
          'so what did it find?': [say('it found dead code on line 40')],
        },
        cwd,
      )

      await session.run('check both files while we talk')
      // The registry drops a job the moment it ends, and this one can end
      // before the parent's turn does, so the id comes from the event.
      const opened = events.find(event => event.type === 'job.started')
      const id = opened?.type === 'job.started' ? opened.job.id : ''
      await vi.waitFor(() => expect(ended(id)?.state).toBe('done'))

      // The turn is over, so there is no unanswered tool call to land in the
      // middle of and nothing to wait for: it is in the conversation already,
      // and in the transcript the window stores. Held in memory until the next
      // message it would be lost to a restart, or to saving settings, and the
      // next message may never come.
      await vi.waitFor(() =>
        expect(session.transcript.some(m => m.role === 'user' && m.content.includes('line 40 is dead code'))).toBe(true),
      )

      await session.run('so what did it find?')

      const delivered = session.transcript.filter(m => m.role === 'user').map(m => m.content)
      const carried = delivered.find(text => text.includes('What it answered:')) ?? ''
      expect(carried).toContain('line 40 is dead code')
      expect(carried).toContain('check the first file')
      // It arrives before the message the user sent after it, because that is
      // the order the two things happened in.
      expect(delivered.indexOf(carried)).toBeLessThan(delivered.indexOf('so what did it find?'))
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('subagent transcripts', () => {
  it('keeps the whole conversation and ties it to the result the parent was handed', async () => {
    const cwd = await workspace()
    try {
      const { session, saved } = harness(
        {
          'find the leak': [
            call('spawn', { role: 'planner', mode: 'distinct', task: 'work out where the leak is' }),
            say('the planner found it'),
          ],
          'work out where the leak is': [say('it is the cache, which is never evicted')],
        },
        cwd,
      )

      await session.run('find the leak')

      // What the parent keeps is a summary; what a person debugging the
      // subagent needs is the conversation the summary came out of.
      expect(saved).toHaveLength(1)
      const kept = saved[0]
      expect(kept?.record.state).toBe('done')
      expect(kept?.record.messages.some(message => message.role === 'user' && message.content === 'work out where the leak is')).toBe(true)
      expect(kept?.record.messages.some(message => message.content.includes('never evicted'))).toBe(true)

      // The marker in the tool result is the thread from the parent's
      // transcript to the child's file, which is what makes it findable.
      const answer = session.transcript.find(message => message.role === 'tool')
      expect(answer?.content).toContain(`[subagent:${kept?.id ?? ''}]`)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('says so in the parent when it could not be written, and still hands the answer back', async () => {
    const cwd = await workspace()
    try {
      const { session } = harness(
        {
          'find the leak': [
            call('spawn', { role: 'planner', mode: 'distinct', task: 'work out where the leak is' }),
            say('the planner found it'),
          ],
          'work out where the leak is': [say('it is the cache, which is never evicted')],
        },
        cwd,
        [],
        true,
      )

      await session.run('find the leak')

      // The work is not thrown away over a disk that would not take the file.
      const answer = session.transcript.find(message => message.role === 'tool')
      expect(answer?.content).toContain('never evicted')

      // And the failure is not thrown away either. That result offers to open a
      // conversation which is not there; without this the user finds that out
      // by clicking it, days later.
      const said = session.notes.map(entry => entry.text).join('\n')
      expect(said).toContain('could not be written')
      expect(said).toContain('permission denied')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('is kept for a subagent that was stopped, and the stop reaches it', async () => {
    const cwd = await workspace()
    try {
      const { session, jobs, ended, saved } = harness(
        {
          'start the long one': [
            call('spawn', { role: 'builder', mode: 'distinct', task: 'grind forever', background: true }),
            say('started it'),
          ],
        },
        cwd,
        ['grind forever'],
      )

      await session.run('start the long one')
      const job = jobs.list()[0]
      expect(jobs.get(job?.id ?? '')?.state).toBe('running')

      // The parent's own turn is over. The subagent is in the background, so
      // it is the only thing still spending. Stop has to reach it anyway.
      session.stop()

      await vi.waitFor(() => expect(ended(job?.id ?? '')?.state).toBe('stopped'))
      expect(saved[0]?.record.state).toBe('stopped')
      // Stopped is neither a result nor a fault, and whatever it had said is kept.
      expect(saved[0]?.record.note).toBe('Stopped.')
      expect(saved[0]?.record.messages.some(message => message.content === 'grind forever')).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('the planner\'s shell', () => {
  it('runs a command that reads and refuses the same command with a redirect', async () => {
    const cwd = await workspace()
    try {
      const ctx = { cwd, access: openGate(cwd), reads: new ReadIndex() }

      const read = await GUARDED_BASH_TOOL.run({ command: 'echo hello' }, ctx)
      expect(read.ok).toBe(true)
      expect(read.content).toContain('hello')

      const refused = await GUARDED_BASH_TOOL.run({ command: 'echo hello > note.txt' }, ctx)
      expect(refused.ok).toBe(false)
      expect(refused.summary).toContain('reads but does not write')
      await expect(readFile(join(cwd, 'note.txt'), 'utf8')).rejects.toThrow()

      // The builder's shell is the same shell without the screen in front of it.
      const allowed = await BASH_TOOL.run({ command: 'echo hello > note.txt' }, ctx)
      expect(allowed.ok).toBe(true)
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toContain('hello')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('a job the app outlives', () => {
  it('ends as stopped, so the window and the transcript can say the answer is gone', async () => {
    const cwd = await workspace()
    try {
      const { jobs, ended } = harness({}, cwd)
      const review = jobs.start({ sessionId: 'parent', role: 'builder', mode: 'distinct', task: 'review the scene', background: true })
      const lookup = jobs.start({ sessionId: 'parent', role: 'planner', mode: 'clone', task: 'find the config', background: false })

      const abandoned = jobs.abandon('the app closed while it was running')

      expect(abandoned.map(job => job.id).sort()).toEqual([review.id, lookup.id].sort())
      expect(ended(review.id)).toEqual({ state: 'stopped', note: 'the app closed while it was running' })
      expect(jobs.list()).toEqual([])
      // Nothing is left to abandon twice: a second pass at quit time is silent.
      expect(jobs.abandon('again')).toEqual([])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
