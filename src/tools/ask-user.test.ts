import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyUsage } from '../shared/usage.js'
import { Session } from '../core/session.js'
import { QuestionBroker } from '../main/questions.js'
import { ASK_USER_TOOL } from './ask-user.js'
import { TODO_TOOL } from './todo.js'
import type { QuestionAsk } from '../main/questions.js'
import type { AskUser, SessionOptions } from '../core/session.js'
import type { ChatInput, ChatProvider } from '../core/provider.js'
import type { AppEvent, ChatChunk, ToolResult } from '../core/types.js'

/**
 * A question put to the user in the middle of a turn, and the plan a turn
 * keeps. Each test runs a whole session turn against a scripted model, and the
 * questions go through the same broker the app uses, so what is checked is
 * what the model is sent back.
 */

class RoundProvider implements ChatProvider {
  readonly seen: ChatInput[] = []
  private rounds = 0

  constructor(private readonly steps: (round: number) => ChatChunk[]) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    this.seen.push({ ...input, messages: [...input.messages] })
    this.rounds += 1
    for (const chunk of this.steps(this.rounds)) yield chunk
  }
}

function call(name: string, args: Record<string, unknown>, id: string): ChatChunk[] {
  return [{ kind: 'tool', tool: { id, name, args: JSON.stringify(args) } }, { kind: 'done', usage: emptyUsage() }]
}

function say(text: string): ChatChunk[] {
  return [{ kind: 'text', text }, { kind: 'done', usage: emptyUsage() }]
}

const QUESTION = {
  header: 'Database',
  question: 'Which database should the new service store its jobs in?',
  options: [
    { label: 'Postgres (recommended)', description: 'The one the rest of the project already runs.' },
    { label: 'SQLite', description: 'A single file next to the service, nothing to run.' },
  ],
}

/** One turn: the model asks, then says something. Returns what the tool answered. */
async function turn(options: Partial<SessionOptions>, args: Record<string, unknown> = { questions: [QUESTION] }): Promise<{ result: ToolResult | undefined; session: Session }> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-ask-'))
  const provider = new RoundProvider(round => (round === 1 ? call('ask_user', args, 'q1') : say('noted')))
  const session = new Session({ sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', ...options }, provider, [ASK_USER_TOOL])
  let result: ToolResult | undefined
  session.bus.on('tool_result', (event: Extract<AppEvent, { type: 'tool_result' }>) => {
    result = event.result
  })
  await session.run('set up the job store')
  await rm(cwd, { recursive: true, force: true })
  return { result, session }
}

/** The app's broker, with a window that answers every question with `answer`. */
function windowAnswering(answer: (ask: QuestionAsk) => unknown): { ask: AskUser; shown: QuestionAsk[] } {
  const shown: QuestionAsk[] = []
  const broker: QuestionBroker = new QuestionBroker(ask => {
    shown.push(ask)
    setTimeout(() => broker.resolve(ask.id, answer(ask)), 10)
  })
  return { ask: (questions, signal) => broker.ask('test', questions, signal), shown }
}

describe('a question the model asks', () => {
  it('reaches the window, and the answer comes back to the model', async () => {
    const window = windowAnswering(() => [{ picked: ['SQLite'] }])
    const { result } = await turn({ ask: window.ask })

    expect(window.shown).toHaveLength(1)
    expect(window.shown[0]?.questions[0]?.options).toHaveLength(2)
    expect(result?.ok).toBe(true)
    expect(result?.content).toContain('Database: Which database')
    expect(result?.content).toContain('SQLite')
  })

  it('carries an answer in the user own words', async () => {
    const window = windowAnswering(() => [{ picked: [], other: ' Redis, it is already deployed ' }])
    const { result } = await turn({ ask: window.ask })

    expect(result?.content).toContain('Redis, it is already deployed')
  })

  it('drops a label the question never offered', async () => {
    // The answer crossed a process boundary, so a made-up option is not taken on trust.
    const window = windowAnswering(() => [{ picked: ['MongoDB', 'SQLite'] }])
    const { result } = await turn({ ask: window.ask })

    expect(result?.content).toContain('SQLite')
    expect(result?.content).not.toContain('MongoDB')
  })

  it('tells the model not to guess when the card is dismissed', async () => {
    const window = windowAnswering(() => null)
    const { result } = await turn({ ask: window.ask })

    expect(result?.ok).toBe(true)
    expect(result?.content).toContain('closed the question without answering')
    expect(result?.content).toContain('Do not pick an answer')
  })

  it('ends with the turn when the user stops it', async () => {
    const shown: QuestionAsk[] = []
    const broker = new QuestionBroker(ask => void shown.push(ask))
    const ask: AskUser = (questions, signal) => {
      // Nobody answers; the user presses stop instead.
      setTimeout(() => session.stop(), 20)
      return broker.ask('test', questions, signal)
    }
    const cwd = await mkdtemp(join(tmpdir(), 'nh-ask-'))
    const provider = new RoundProvider(round => (round === 1 ? call('ask_user', { questions: [QUESTION] }, 'q1') : say('noted')))
    const session = new Session({ sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', ask }, provider, [ASK_USER_TOOL])
    const stopped: AppEvent[] = []
    session.bus.on('session.stopped', event => void stopped.push(event))

    await session.run('set up the job store')

    expect(shown).toHaveLength(1)
    expect(stopped).toHaveLength(1)
    await rm(cwd, { recursive: true, force: true })
  })

  it('is turned back to a subagent, which has nobody to ask', async () => {
    const { result } = await turn({})

    expect(result?.ok).toBe(false)
    expect(result?.content).toContain('subagent')
    expect(result?.content).toContain('do not guess')
  })

  it('is refused when an option has no description', async () => {
    const window = windowAnswering(() => [{ picked: ['A'] }])
    const bare = { ...QUESTION, options: [{ label: 'A' }, { label: 'B', description: 'b' }] }
    const { result } = await turn({ ask: window.ask }, { questions: [bare] })

    expect(window.shown).toHaveLength(0)
    expect(result?.ok).toBe(false)
  })
})

describe('the plan a turn keeps', () => {
  it('is answered with its progress in one line, since the list is already in the call', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-plan-'))
    const todos = [
      { content: 'Read the config loader', status: 'completed' },
      { content: 'Add the timeout setting', status: 'in_progress' },
      { content: 'Document it', status: 'pending' },
    ]
    const provider = new RoundProvider(round => (round === 1 ? call('todo_write', { todos }, 'p1') : say('on it')))
    const session = new Session({ sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.' }, provider, [TODO_TOOL])
    let result: ToolResult | undefined
    session.bus.on('tool_result', event => {
      result = event.result
    })

    await session.run('add a timeout setting')

    expect(result?.content).toBe('Plan updated, 1 of 3 done. Now: Add the timeout setting')
    // The second round still carries every step, once, in the call the model made.
    const sent = JSON.stringify(provider.seen[1]?.messages)
    expect(sent.split('Read the config loader')).toHaveLength(2)
    expect(sent).toContain('Document it')
    await rm(cwd, { recursive: true, force: true })
  })

  it('takes an empty list as the plan cleared', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-plan-'))
    const provider = new RoundProvider(round => (round === 1 ? call('todo_write', { todos: [] }, 'p1') : say('dropped it')))
    const session = new Session({ sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.' }, provider, [TODO_TOOL])
    let result: ToolResult | undefined
    session.bus.on('tool_result', event => {
      result = event.result
    })

    await session.run('never mind the plan')

    expect(result?.ok).toBe(true)
    expect(result?.content).toBe('Plan cleared.')
    await rm(cwd, { recursive: true, force: true })
  })

  it('refuses a step with no status', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-plan-'))
    const provider = new RoundProvider(round => (round === 1 ? call('todo_write', { todos: [{ content: 'Do it' }] }, 'p1') : say('ok')))
    const session = new Session({ sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.' }, provider, [TODO_TOOL])
    let result: ToolResult | undefined
    session.bus.on('tool_result', event => {
      result = event.result
    })

    await session.run('do it')

    expect(result?.ok).toBe(false)
    expect(result?.content).toContain('status must be')
    await rm(cwd, { recursive: true, force: true })
  })
})
