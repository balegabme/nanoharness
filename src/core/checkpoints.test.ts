import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compose } from '../shared/compose.js'
import { emptyUsage } from '../shared/usage.js'
import { CheckpointStore } from './checkpoints.js'
import { SUMMARY_INSTRUCTION } from './compaction.js'
import { Session } from './session.js'
import { EDIT_TOOL } from '../tools/edit.js'
import { READ_TOOL } from '../tools/read.js'
import { WRITE_TOOL } from '../tools/write.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { ChatChunk, ChatMessage } from './types.js'
import type { ModelFacts } from './config.js'

/**
 * Checkpoints and rewind, driven the way the window drives them: turns that
 * write real files through `edit` and `write`, then a rewind by the id the
 * turn index lists, held until the next message keeps it. What the tests read
 * is the disk, the transcript and the checkpoint list, since those are what
 * the user sees come back.
 */

/**
 * A model that plays one script per user message: round n of a turn answers
 * with the nth entry, and a turn past its script ends by saying so. A summary
 * request is answered with a summary, and the message `fail` is refused the
 * way an endpoint refuses a bad key.
 */
class Plays implements ChatProvider {
  constructor(private readonly plays: Record<string, ChatChunk[][]>) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    const at = input.messages.findLastIndex(m => m.role === 'user')
    const asked = input.messages[at]
    if (asked?.content === 'fail') throw new Error('401 unauthorized')
    if (asked?.content === SUMMARY_INSTRUCTION) {
      yield { kind: 'text', text: 'summary of the early turns' }
    } else {
      const round = input.messages.slice(at + 1).filter(m => m.role === 'assistant').length
      for (const chunk of this.plays[asked?.content ?? '']?.[round] ?? [{ kind: 'text', text: 'done' }]) yield chunk
    }
    yield { kind: 'done', usage: emptyUsage() }
  }
}

let calls = 0
function use(name: string, args: Record<string, unknown>): ChatChunk[] {
  calls += 1
  return [{ kind: 'tool', tool: { id: `call-${calls}`, name, args: JSON.stringify(args) } }]
}

const PLAYS: Record<string, ChatChunk[][]> = {
  'make b': [use('write', { path: 'b.txt', content: 'bee\n' })],
  'change both': [
    use('read', { path: 'a.txt' }),
    use('edit', { path: 'a.txt', old_string: 'one', new_string: 'two' }),
    use('write', { path: 'b.txt', content: 'bee two\n' }),
  ],
}

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Harness {
  session: Session
  store: CheckpointStore
  cwd: string
  data: string
}

interface Opening {
  facts?: ModelFacts
  /** A stored conversation, which makes the session a resumed one. */
  history?: ChatMessage[]
  /** Where the store keeps its checkpoints, given a fresh folder, when not that folder itself. */
  data?: (fresh: string) => Promise<string>
  saveHistory?: (session: Session) => Promise<void>
}

async function open(plays: Record<string, ChatChunk[][]> = PLAYS, { facts, history, data: at, saveHistory }: Opening = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-rewind-'))
  const fresh = await mkdtemp(join(tmpdir(), 'nh-checkpoints-'))
  cleanup.push(cwd, fresh)
  await writeFile(join(cwd, 'a.txt'), 'one\n')
  const data = at === undefined ? fresh : await at(fresh)
  const store = new CheckpointStore(data)
  const session: Session = new Session(
    {
      sessionId: 'test',
      cwd,
      model: 'test-model',
      systemPrompt: 'You are a test.',
      checkpoints: store,
      autoCompact: false,
      ...(facts === undefined ? {} : { facts }),
      ...(history === undefined ? {} : { history }),
      ...(saveHistory === undefined ? {} : { saveHistory: () => saveHistory(session) }),
    },
    new Plays(plays),
    [READ_TOOL, EDIT_TOOL, WRITE_TOOL],
  )
  return { session, store, cwd, data }
}

async function contents(cwd: string, name: string): Promise<string | null> {
  return readFile(join(cwd, name), 'utf8').catch(() => null)
}

/** The checkpoint a turn began, by the prompt the turn index shows for it. */
async function checkpointOf(store: CheckpointStore, prompt: string): Promise<string> {
  const found = (await store.list()).entries.find(entry => entry.prompt === prompt)
  if (found === undefined) throw new Error(`no checkpoint for "${prompt}"`)
  return found.id
}

async function prompts(store: CheckpointStore): Promise<string[]> {
  return (await store.list()).entries.map(entry => entry.prompt)
}

describe('rewinding the conversation and the code', () => {
  it('puts the files back at once and cuts the conversation when the next message keeps it', async () => {
    const { session, store, cwd } = await open()
    await session.run('make b')
    const afterFirst = session.transcript.length
    await session.run('change both')
    const whole = session.transcript.length
    expect(await contents(cwd, 'a.txt')).toBe('two\n')
    expect(await contents(cwd, 'b.txt')).toBe('bee two\n')

    const id = await checkpointOf(store, 'change both')
    const back = await session.rewind(id, 'both')

    expect(back.prompt).toBe('change both')
    expect(back.failed).toEqual([])
    expect(await contents(cwd, 'a.txt')).toBe('one\n')
    expect(await contents(cwd, 'b.txt')).toBe('bee\n')
    expect(session.transcript).toHaveLength(whole)
    expect((await store.list()).held).toEqual({ id, mode: 'both' })

    await session.run('next')

    // The cut conversation, then the message that kept the rewind and its answer.
    expect(session.transcript).toHaveLength(afterFirst + 2)
    expect(session.turnNumber).toBe(2)
    expect(await prompts(store)).toEqual(['make b', 'next'])
    expect((await store.list()).held).toBeNull()
    const note = session.notes.find(one => one.text.startsWith('Rewound'))
    expect(note?.text).toMatch(/^Rewound the conversation and the files to before turn 2\. Restored /)
    expect(note?.turn).toBe(1)
  })

  it('moves to another turn and back, and undoes to where it started', async () => {
    const { session, store, cwd } = await open()
    await session.run('make b')
    await session.run('change both')
    const whole = structuredClone(session.transcript)

    await session.rewind(await checkpointOf(store, 'change both'), 'both')
    const start = await session.rewind(await checkpointOf(store, 'make b'), 'both')

    expect(start.prompt).toBe('make b')
    expect(await contents(cwd, 'a.txt')).toBe('one\n')
    expect(await contents(cwd, 'b.txt')).toBeNull()

    // Moved a turn later again: b.txt comes back as the first turn left it, and
    // a.txt, already as it should be, is not written.
    const forward = await session.rewind(await checkpointOf(store, 'change both'), 'both')

    expect(forward.restored).toEqual([join(cwd, 'b.txt')])
    expect(await contents(cwd, 'b.txt')).toBe('bee\n')

    const undone = await session.rewind(null, 'both')

    expect(undone.prompt).toBeUndefined()
    expect(await contents(cwd, 'a.txt')).toBe('two\n')
    expect(await contents(cwd, 'b.txt')).toBe('bee two\n')
    expect(session.transcript).toEqual(whole)
    expect(await prompts(store)).toEqual(['make b', 'change both'])
    expect((await store.list()).held).toBeNull()
  })

  it('changes how far and which way it goes while held, and the next message keeps the last', async () => {
    const { session, store, cwd } = await open()
    await session.run('make b')
    const afterFirst = session.transcript.length
    await session.run('change both')

    await session.rewind(await checkpointOf(store, 'make b'), 'code')
    expect(await contents(cwd, 'a.txt')).toBe('one\n')
    expect(await contents(cwd, 'b.txt')).toBeNull()

    // The conversation alone covers no file, so every file the code rewind
    // moved goes back to how it found it.
    const back = await session.rewind(await checkpointOf(store, 'change both'), 'conversation')

    expect(back.prompt).toBe('change both')
    expect(await contents(cwd, 'a.txt')).toBe('two\n')
    expect(await contents(cwd, 'b.txt')).toBe('bee two\n')

    await session.run('next')

    expect(session.transcript).toHaveLength(afterFirst + 2)
    expect(await prompts(store)).toEqual(['make b', 'next'])
    expect(await contents(cwd, 'a.txt')).toBe('two\n')
  })

  it('stores the cut conversation before the turn that keeps it runs, so a turn that fails leaves it cut', async () => {
    const stored: ChatMessage[][] = []
    const { session, store } = await open(PLAYS, {
      saveHistory: async live => {
        stored.push(structuredClone(live.transcript))
      },
    })
    await session.run('make b')
    const afterFirst = session.transcript.length
    await session.run('change both')
    await session.rewind(await checkpointOf(store, 'change both'), 'both')

    await expect(session.run('fail')).rejects.toThrow(/401/)

    expect(stored).toHaveLength(1)
    expect(stored[0]).toHaveLength(afterFirst)
    expect(await prompts(store)).toEqual(['make b', 'fail'])
  })

  it('numbers the next turn where the rewound one was, and checkpoints it afresh', async () => {
    const { session, store } = await open()
    await session.run('make b')
    await session.run('change both')
    await session.rewind(await checkpointOf(store, 'change both'), 'both')

    await session.run('change both')

    expect(session.turnNumber).toBe(2)
    expect((await store.list()).entries.map(entry => [entry.turn, entry.prompt])).toEqual([
      [1, 'make b'],
      [2, 'change both'],
    ])
  })
})

describe('rewinding the code alone', () => {
  it('keeps the conversation and tells the model which files went back', async () => {
    const { session, store, cwd } = await open()
    await session.run('make b')
    await session.run('change both')
    const before = session.transcript.length

    const back = await session.rewind(await checkpointOf(store, 'make b'), 'code')

    expect(back.prompt).toBeUndefined()
    expect(await contents(cwd, 'a.txt')).toBe('one\n')
    expect(await contents(cwd, 'b.txt')).toBeNull()

    await session.run('next')

    const told = session.transcript[before]
    expect(told?.role).toBe('user')
    expect(told?.content).toMatch(/before turn 1: (a\.txt, b\.txt|b\.txt, a\.txt)\./)
    expect(session.transcript[before + 1]?.content).toBe('next')
    expect(await prompts(store)).toEqual(['make b', 'change both', 'next'])
  })

  it('leaves a later turn able to bring back what it put back', async () => {
    const { session, store, cwd } = await open({
      ...PLAYS,
      'change a': [use('read', { path: 'a.txt' }), use('edit', { path: 'a.txt', old_string: 'one', new_string: 'two' })],
    })
    await session.run('make b')
    await session.run('change a')
    await session.rewind(await checkpointOf(store, 'make b'), 'code')
    await session.run('next')
    expect(await contents(cwd, 'b.txt')).toBeNull()

    // b.txt was last changed in the first turn, and stood as that turn left it
    // when the second began.
    await session.rewind(await checkpointOf(store, 'change a'), 'code')

    expect(await contents(cwd, 'a.txt')).toBe('one\n')
    expect(await contents(cwd, 'b.txt')).toBe('bee\n')
  })

  it('leaves a file it cannot copy first as it is, so undoing has nothing to lose', async () => {
    const { session, store, cwd } = await open()
    await session.run('make b')
    await session.run('change both')
    // Grown past what the store copies, outside the app.
    const big = 'x'.repeat(17 * 1024 * 1024)
    await writeFile(join(cwd, 'b.txt'), big)

    const back = await session.rewind(await checkpointOf(store, 'make b'), 'code')

    expect(await contents(cwd, 'a.txt')).toBe('one\n')
    expect(await contents(cwd, 'b.txt')).toBe(big)
    expect(back.failed).toEqual([{ path: join(cwd, 'b.txt'), reason: expect.stringMatching(/^left as it is, because it could not be copied first: larger than 16 MB/) }])

    await session.rewind(null, 'code')

    expect(await contents(cwd, 'a.txt')).toBe('two\n')
    expect(await contents(cwd, 'b.txt')).toBe(big)
  })

  it('makes the model read a file again before it edits one that went back', async () => {
    const { session, store } = await open({
      ...PLAYS,
      'edit again': [use('edit', { path: 'a.txt', old_string: 'two', new_string: 'three' })],
    })
    await session.run('make b')
    await session.run('change both')
    await session.rewind(await checkpointOf(store, 'change both'), 'code')

    await session.run('edit again')

    const result = session.transcript.find(m => m.role === 'tool' && m.content.includes('changed on disk since it was read'))
    expect(result).toBeDefined()
  })
})

describe('rewinding the conversation alone', () => {
  it('leaves the files, and a later code rewind past it still puts them back', async () => {
    const { session, store, cwd } = await open()
    await session.run('make b')
    await session.run('change both')

    await session.rewind(await checkpointOf(store, 'change both'), 'conversation')
    await session.run('next')

    expect(await contents(cwd, 'a.txt')).toBe('two\n')
    expect(await contents(cwd, 'b.txt')).toBe('bee two\n')
    expect(await prompts(store)).toEqual(['make b', 'next'])
    // a.txt was first changed in the dropped turn, so its copy moved to the
    // turn before, which is the only one left to rewind to.
    expect((await store.list()).entries[0]?.files.sort()).toEqual([join(cwd, 'a.txt'), join(cwd, 'b.txt')].sort())

    await session.rewind(await checkpointOf(store, 'make b'), 'code')

    expect(await contents(cwd, 'a.txt')).toBe('one\n')
    expect(await contents(cwd, 'b.txt')).toBeNull()
  })

  it('lists a message sent with snippets by the user’s own words, and hands back only those', async () => {
    const { session, store } = await open()
    await session.run('make b')
    const sent = compose('look at the tests', ['Familiarize yourself with this project before we start.'], ['Read-only: do not change any file.'])
    await session.run(sent.text, [], sent.said)

    expect(await prompts(store)).toEqual(['make b', 'look at the tests'])
    const back = await session.rewind(await checkpointOf(store, 'look at the tests'), 'conversation')
    expect(back.prompt).toBe('look at the tests')
  })
})

describe('what the model may rewrite after a conversation rewind', () => {
  it('makes it read again a file it only read in a turn that was cut, in a resumed session too', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'done' },
    ]
    const { session, store, cwd } = await open(
      {
        look: [use('read', { path: 'a.txt' })],
        'edit a': [use('edit', { path: 'a.txt', old_string: 'one', new_string: 'two' })],
      },
      { history },
    )
    await session.run('look')

    await session.rewind(await checkpointOf(store, 'look'), 'conversation')
    await session.run('edit a')

    const refused = session.transcript.find(m => m.role === 'tool' && m.content.includes('read again since the conversation was rewound'))
    expect(refused).toBeDefined()
    expect(await contents(cwd, 'a.txt')).toBe('one\n')
  })
})

describe('a rewind past a compaction', () => {
  /** A 4,000-token window, which three long answers are enough to compact. */
  const SMALL: ModelFacts = { context: 4_000, maxOutput: 1_000 }
  const long = (n: number): ChatChunk[][] => [[{ kind: 'text', text: `answer ${n} `.repeat(250) }]]

  it('takes the summary away and puts back what it had folded', async () => {
    const plays = { 'task 1': long(1), 'task 2': long(2), 'task 3': long(3), 'task 4': long(4) }
    const { session, store } = await open(plays, { facts: SMALL })
    for (const task of ['task 1', 'task 2', 'task 3']) await session.run(task)
    expect((await session.compact()).compacted).toBe(true)
    await session.run('task 4')

    await session.rewind(await checkpointOf(store, 'task 4'), 'conversation')
    await session.run('again')

    expect(session.transcript.some(m => m.role === 'user' && m.summary === true)).toBe(true)
    expect(session.transcript.some(m => m.compacted === 'compacted')).toBe(true)
    expect(session.context.compactions).toHaveLength(1)

    await session.rewind(await checkpointOf(store, 'task 3'), 'conversation')
    await session.run('again')

    expect(session.transcript.some(m => m.role === 'user' && m.summary === true)).toBe(false)
    expect(session.transcript.some(m => m.compacted !== undefined)).toBe(false)
    expect(session.context.compactions).toHaveLength(0)
    expect(session.wireMessages().filter(m => m.role === 'user').map(m => m.content)).toEqual(['task 1', 'task 2', 'again'])
  })

  it('is kept by a compaction the user asks for, before it summarises', async () => {
    const plays = { 'task 1': long(1), 'task 2': long(2), 'task 3': long(3), 'task 4': long(4) }
    const { session, store } = await open(plays, { facts: SMALL })
    for (const task of ['task 1', 'task 2', 'task 3', 'task 4']) await session.run(task)

    await session.rewind(await checkpointOf(store, 'task 4'), 'conversation')
    await session.compact()

    expect(session.transcript.some(m => m.role === 'user' && m.content === 'task 4')).toBe(false)
    expect(await prompts(store)).toEqual(['task 1', 'task 2', 'task 3'])
  })
})

describe('a held rewind and /tldr', () => {
  it('is kept before the TL;DR, which shortens the last answer the user kept', async () => {
    const plays = { 'task 1': [[{ kind: 'text', text: 'first answer' }]], 'task 2': [[{ kind: 'text', text: 'second answer' }]] } satisfies Record<string, ChatChunk[][]>
    const { session, store } = await open(plays)
    for (const task of ['task 1', 'task 2']) await session.run(task)

    await session.rewind(await checkpointOf(store, 'task 2'), 'conversation')
    expect((await session.tldr()).written).toBe(true)

    expect(session.transcript.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['first answer'])
    expect(await prompts(store)).toEqual(['task 1'])
    expect(session.notes.some(note => note.kind === 'tldr')).toBe(true)
  })
})

describe('the checkpoints on disk', () => {
  it('are what a store opened later lists, the held rewind with them', async () => {
    const { session, store, data } = await open()
    await session.run('make b')
    await session.run('change both')
    await session.rewind(await checkpointOf(store, 'make b'), 'code')

    const later = await new CheckpointStore(data).list()

    expect(later).toEqual(await store.list())
    expect(later.held?.mode).toBe('code')
  })

  it('do not stop an edit when they cannot be written, and a rewind then leaves what it cannot copy', async () => {
    // A file where the folder should be, so nothing under it can be written.
    const blocked = async (fresh: string): Promise<string> => {
      await writeFile(join(fresh, 'taken'), '')
      return join(fresh, 'taken', 'checkpoints')
    }
    const { session, store, cwd } = await open(PLAYS, { data: blocked })

    await session.run('make b')

    expect(await contents(cwd, 'b.txt')).toBe('bee\n')
    expect(session.notes.filter(note => note.kind === 'error').map(note => note.text)).toEqual([
      expect.stringMatching(/^this turn's checkpoint could not be stored: /),
      expect.stringMatching(/^the checkpoint copy of b\.txt could not be saved: /),
    ])

    // Putting b.txt back means deleting it, and with no copy of it as it is
    // now, nothing could undo that.
    const back = await session.rewind(await checkpointOf(store, 'make b'), 'both')

    expect(await contents(cwd, 'b.txt')).toBe('bee\n')
    expect(back.failed).toEqual([{ path: join(cwd, 'b.txt'), reason: expect.stringMatching(/^left as it is, because it could not be copied first: /) }])
    expect(back.prompt).toBe('make b')
    expect(session.notes.some(note => note.kind === 'error' && note.text.startsWith('the checkpoint list could not be saved'))).toBe(true)
  })

  it('are refused while a turn is running', async () => {
    const { session, store } = await open()
    await session.run('make b')
    const id = await checkpointOf(store, 'make b')
    const turn = session.run('change both')

    await expect(session.rewind(id, 'both')).rejects.toThrow(/busy/)
    await turn
  })
})
