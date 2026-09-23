import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Session } from '../core/session.js'
import { emptyUsage } from '../core/types.js'
import { warmShell } from '../env/shell.js'
import { hookPaths, parseHooks, readHookFile } from './config.js'
import { Hooks } from './hooks.js'
import { HookTrust } from './trust.js'
import type { Tool } from '../core/session.js'
import type { ChatInput, ChatProvider } from '../core/provider.js'
import type { AppEvent, ChatChunk, ToolResult } from '../core/types.js'

/**
 * Hooks as a session runs them: real bash scripts from a hooks file, around a
 * turn a scripted model plays out. What the tests read is what the model is
 * sent and what the window is told, because a hook exists to change both.
 */

// Every hook is a shell of its own. With the login PATH read first, each one
// starts without sourcing a profile.
beforeAll(() => warmShell())

// Retried because a process a hook started can still be running, or still be
// dying, when the test ends, and Windows will not remove a folder a process is
// working in.
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

/** Rounds in order, each one scripted from the round number. */
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

/** A tool that writes the file it is given, and counts how often it ran. */
function toucher(cwd: string): { tool: Tool; runs: string[] } {
  const runs: string[] = []
  const tool: Tool = {
    input: {
      name: 'touch',
      description: 'create a file',
      inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
    },
    async run(args): Promise<ToolResult> {
      const file = String(args.file)
      runs.push(file)
      await writeFile(join(cwd, file), '')
      return { ok: true, summary: `made ${file}`, content: `made ${file}` }
    },
  }
  return { tool, runs }
}

async function setup(
  file: Record<string, unknown>,
  steps: (round: number) => ChatChunk[],
): Promise<{ session: Session; provider: RoundProvider; events: AppEvent[]; runs: string[] }> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-hooks-'))
  dirs.push(cwd)
  const { hooks: specs, problems } = parseHooks(JSON.stringify(file), 'hooks.json')
  expect(problems).toEqual([])
  const provider = new RoundProvider(steps)
  const touch = toucher(cwd)
  const session = new Session(
    { sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', hooks: new Hooks(specs, cwd) },
    provider,
    [touch.tool],
  )
  const events: AppEvent[] = []
  for (const type of ['session.note', 'tool_result'] as const) session.bus.on(type, event => void events.push(event))
  return { session, provider, events, runs: touch.runs }
}

function results(events: AppEvent[]): ToolResult[] {
  return events.flatMap(event => (event.type === 'tool_result' ? [event.result] : []))
}

function notes(events: AppEvent[]): string[] {
  return events.flatMap(event => (event.type === 'session.note' ? [event.text] : []))
}

describe('a PreToolUse hook', () => {
  it('refuses the call it reads as dangerous, and lets the next one through', async () => {
    const { session, events, runs } = await setup(
      {
        PreToolUse: [
          { match: 'touch', command: `if grep -q '"file":"secret.txt"'; then echo 'secret.txt is off limits' >&2; exit 2; fi` },
          { match: 'other', command: 'exit 2' },
        ],
      },
      round => (round === 1 ? call('touch', { file: 'secret.txt' }, 'c1') : round === 2 ? call('touch', { file: 'notes.txt' }, 'c2') : say('done')),
    )

    await session.run('make two files')

    // The refused call never reached the tool. The hook matched on another
    // tool's name never ran, or the second call would have been refused too.
    expect(runs).toEqual(['notes.txt'])
    const [refused, allowed] = results(events)
    expect(refused).toMatchObject({ ok: false, prevented: true })
    expect(refused?.content).toContain('secret.txt is off limits')
    expect(allowed).toMatchObject({ ok: true, content: 'made notes.txt' })
  })
})

describe('a PostToolUse hook', () => {
  it('adds what it printed to the result the model reads', async () => {
    const { session, provider } = await setup(
      { PostToolUse: [{ command: `grep -q '"ok":true' && echo "checked $(ls | wc -l | tr -d ' ') file(s)"` }] },
      round => (round === 1 ? call('touch', { file: 'a.txt' }, 'c1') : say('done')),
    )

    await session.run('make a file')

    const sent = provider.seen[1]?.messages.at(-1)
    expect(sent).toMatchObject({ role: 'tool', toolCallId: 'c1' })
    expect(sent?.content).toBe('made a.txt\n\n[PostToolUse hook]\nchecked 1 file(s)')
  })
})

describe('a Stop hook', () => {
  it('sends the model back to work until the check passes', async () => {
    const { session, provider, events } = await setup(
      { Stop: [{ command: `if [ ! -f done.txt ]; then echo 'done.txt is missing' >&2; exit 2; fi` }] },
      round => (round === 1 ? say('all done') : round === 2 ? call('touch', { file: 'done.txt' }, 'c1') : say('now it is')),
    )

    await session.run('finish the job')

    expect(provider.rounds).toBe(3)
    // The refusal reaches the model as a message of its own. The transcript
    // marks it as the hook's, and the window shows it as a note.
    expect(provider.seen[1]?.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(provider.seen[1]?.messages.at(-1)?.content).toContain('done.txt is missing')
    expect(session.transcript.filter(message => message.role === 'user' && message.hook === true)).toHaveLength(1)
    expect(notes(events).some(text => text.includes('done.txt is missing'))).toBe(true)
    expect(session.transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'now it is' })
  })

  it('lets the turn end after three refusals, and says so', async () => {
    const { session, provider, events } = await setup({ Stop: [{ command: `echo 'not yet' >&2; exit 2` }] }, () => say('all done'))

    await session.run('finish the job')

    // One answer, three sent back, and the fourth let through.
    expect(provider.rounds).toBe(4)
    expect(notes(events).at(-1)).toContain('The turn ends here anyway')
  })
})

describe('a hook that goes wrong', () => {
  it('is stopped at its timeout and reported, and the turn goes on', async () => {
    const { session, events, runs } = await setup(
      { PreToolUse: [{ command: 'sleep 30', timeout: 0.5 }] },
      round => (round === 1 ? call('touch', { file: 'a.txt' }, 'c1') : say('done')),
    )

    await session.run('make a file')

    expect(runs).toEqual(['a.txt'])
    expect(notes(events).some(text => text.includes('ran out of time after 0.5s'))).toBe(true)
  })

  it('is stopped with the turn, and the call it held up never runs', async () => {
    const { session, runs } = await setup(
      { PreToolUse: [{ command: 'sleep 30' }] },
      round => (round === 1 ? call('touch', { file: 'a.txt' }, 'c1') : say('done')),
    )

    const started = Date.now()
    const turn = session.run('make a file')
    setTimeout(() => session.stop(), 500)
    await turn

    expect(Date.now() - started).toBeLessThan(10_000)
    expect(session.interrupted).toBe(true)
    expect(runs).toEqual([])
  })

  it('is done when it exits, though a process it started is still running', async () => {
    const { session, provider } = await setup(
      { PostToolUse: [{ command: 'sleep 4 & echo started' }] },
      round => (round === 1 ? call('touch', { file: 'a.txt' }, 'c1') : say('done')),
    )

    const started = Date.now()
    await session.run('make a file')

    expect(Date.now() - started).toBeLessThan(3_500)
    expect(provider.seen[1]?.messages.at(-1)?.content).toBe('made a.txt\n\n[PostToolUse hook]\nstarted')
  })
})

describe('a project hooks file', () => {
  it('stays approved until its text changes, and a refusal lasts one run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nh-trust-'))
    dirs.push(dir)
    const root = join(dir, 'project')
    const other = join(dir, 'other')
    const store = join(dir, 'hook-trust.json')
    const path = hookPaths(root).project
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ Stop: [{ command: 'true' }] }))
    const first = await readHookFile(path)
    const trust = new HookTrust(store)

    expect(await trust.approved(root, first.hash)).toBe(false)
    // Two approvals written at once both reach the file.
    await Promise.all([trust.approve(root, first.hash), trust.approve(other, first.hash)])

    // The next launch reads them back.
    const later = new HookTrust(store)
    expect(await later.approved(root, first.hash)).toBe(true)
    expect(await later.approved(other, first.hash)).toBe(true)

    await writeFile(path, JSON.stringify({ Stop: [{ command: 'exit 2' }] }))
    const edited = await readHookFile(path)
    expect(await later.approved(root, edited.hash)).toBe(false)

    later.refuse(root, edited.hash)
    expect(later.refusedThisRun(root, edited.hash)).toBe(true)
    expect(new HookTrust(store).refusedThisRun(root, edited.hash)).toBe(false)
  })
})

describe('a hooks file with a mistake in it', () => {
  it('loads the entries that are right and names the ones that are not', () => {
    const text = JSON.stringify({
      Stop: [{ command: 'true' }, { command: 'true', match: 'bash' }],
      PreTool: [{ command: 'true' }],
      PostToolUse: [{ command: 'true', match: '(' }, { command: 'true', timeout: 601 }, { match: 'bash' }, { command: `echo ${'x'.repeat(8_000)}` }],
    })

    const { hooks, problems } = parseHooks(text, 'hooks.json')

    expect(hooks.map(hook => hook.event)).toEqual(['Stop'])
    expect(problems).toHaveLength(6)
    expect(problems[0]).toContain('Stop[1] has a "match", which only PreToolUse and PostToolUse take')
    expect(problems[1]).toContain('"PreTool" is not an event')
    expect(problems[5]).toContain('PostToolUse[3] has a "command" over 8000 bytes')
  })
})
