import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, agentPrompt } from './agents.js'
import { EventBus } from './event-bus.js'
import { JobRegistry } from './jobs.js'
import { Session } from './session.js'
import { createSpawnHost } from './spawn.js'
import { workspaceGate } from './scope.js'
import { emptyUsage } from './types.js'
import { BASH_TOOL, GUARDED_BASH_TOOL } from '../tools/bash.js'
import { JOB_UPDATE_TOOL } from '../tools/job-update.js'
import { READ_TOOL } from '../tools/read.js'
import { SPAWN_TOOL } from '../tools/spawn.js'
import { WRITE_TOOL } from '../tools/write.js'
import type { Tool } from './session.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { AppEvent, ChatChunk, ChatMessage } from './types.js'

/**
 * A turn that delegates, end to end. The provider is the only fake: the session
 * loop, the tool boundary, the spawn host, the job registry and the real shell
 * are the code under test. What the tests read is what actually went on the
 * wire — the subagent's system prompt, its tool list, its effort — because that
 * is the whole of what a role and a spawn mode decide.
 */

const PARENT_PROMPT = 'You are the parent.'

/**
 * Answers from a script keyed by the conversation's last user message: the
 * parent's turn text for the parent, the task for a subagent. A background job
 * runs alongside the parent's turn, so answering by call order would be a race.
 */
class ScriptedProvider implements ChatProvider {
  readonly calls: ChatInput[] = []
  private readonly pending = new Map<string, ChatChunk[][]>()

  constructor(private readonly script: Record<string, ChatChunk[][]>) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    this.calls.push({ ...input, messages: [...input.messages], tools: [...input.tools] })
    const key = lastUser(input.messages)
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

const PARENT_TOOLS: Tool[] = [BASH_TOOL, READ_TOOL, WRITE_TOOL, SPAWN_TOOL]

interface Harness {
  session: Session
  provider: ScriptedProvider
  jobs: JobRegistry
  events: AppEvent[]
}

/**
 * The wiring the app does in `src/main/index.ts`, cut down to what a test can
 * hold: one parent session with a spawn host whose `setup` builds a distinct
 * agent from its role, and a clone from the parent's own prompt and tools.
 */
function harness(script: Record<string, ChatChunk[][]>, cwd: string): Harness {
  const provider = new ScriptedProvider(script)
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
      maxToolRounds: 4,
      access,
      spawn: createSpawnHost({
        sessionId: 'parent',
        cwd,
        model: 'test-model',
        provider,
        access,
        jobs,
        maxToolRounds: 4,
        setup: async (request, jobId) => {
          if (request.mode === 'clone') {
            return { systemPrompt: PARENT_PROMPT, tools: PARENT_TOOLS, history: parent.session?.transcript ?? [] }
          }
          const shell = AGENTS[request.role].bash === 'guarded' ? GUARDED_BASH_TOOL : BASH_TOOL
          const writes = AGENTS[request.role].tools.includes('write') ? [WRITE_TOOL] : []
          return {
            systemPrompt: agentPrompt(request.role, env),
            tools: [shell, READ_TOOL, ...writes, ...(jobId === null ? [] : [JOB_UPDATE_TOOL])],
            effort: AGENTS[request.role].defaultEffort,
          }
        },
      }),
    },
    provider,
    PARENT_TOOLS,
    bus,
  )
  parent.session = session
  return { session, provider, jobs, events }
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nh-agents-'))
}

describe('spawn', () => {
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
      // A distinct agent starts from nothing: the parent's turn is not in it.
      expect(child?.messages).toHaveLength(2)
      // The planner cannot write, and the tool list is where that is enforced.
      expect(child?.tools.map(tool => tool.name)).toEqual(['bash', 'read'])
      expect(child?.effort).toBe(AGENTS.planner.defaultEffort)

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
      const { session, jobs, events } = harness(
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

      // The turn came back with a job id rather than the work.
      const started = jobs.list()[0]
      expect(started?.role).toBe('builder')
      const answer = session.transcript.find(message => message.role === 'tool')
      expect(answer?.content).toContain(`background job ${started?.id ?? ''}`)

      await vi.waitFor(() => expect(jobs.get(started?.id ?? '')?.state).toBe('done'))
      expect(jobs.get(started?.id ?? '')?.note).toContain('docs updated')

      const types = events.map(event => event.type)
      expect(types).toEqual(['job.started', 'job.update', 'job.finished'])
      expect(events.some(event => event.type === 'job.update' && event.note === 'read the ledger')).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('the planner\'s shell', () => {
  it('runs a command that reads and refuses the same command with a redirect', async () => {
    const cwd = await workspace()
    try {
      const ctx = { cwd, access: workspaceGate(cwd) }

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
