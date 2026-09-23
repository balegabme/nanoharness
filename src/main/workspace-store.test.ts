import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Session } from '../core/session.js'
import { emptyUsage } from '../core/types.js'
import { Throughput } from '../renderer/metrics.js'
import {
  acceptImages,
  addWorkspace,
  createSession,
  loadTranscript,
  noteTurn,
  saveTranscript,
  toTranscriptView,
  transcriptPath,
  workspaceStatus,
} from './workspace-store.js'
import type { ChatInput, ChatProvider } from '../core/provider.js'
import type { ChatChunk, ChatMessage } from '../core/types.js'
import type { SessionState } from './workspace-store.js'

/**
 * What a session looks like after the app is closed and opened again. A real
 * turn runs against a provider that takes its time, what main stores after the
 * turn goes to a real index file in a scratch directory, and the session is
 * read back the way the window reads it when it is picked from the list.
 */

const originals = { APPDATA: process.env.APPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME }
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nh-store-'))
  process.env.APPDATA = dir
  process.env.XDG_DATA_HOME = dir
  // macOS resolves through `homedir()`, which reads neither of the other two.
  process.env.HOME = dir
})

afterEach(async () => {
  if (originals.APPDATA === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originals.APPDATA
  if (originals.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = originals.XDG_DATA_HOME
  if (originals.HOME === undefined) delete process.env.HOME
  else process.env.HOME = originals.HOME
  await rm(dir, { recursive: true, force: true })
})

/**
 * Answers in two pieces half a second apart, past the 0.4s the topbar needs
 * before it shows a rate. After `silent` is set it answers with nothing at all.
 */
class SlowProvider implements ChatProvider {
  silent = false

  async *stream(_input: ChatInput): AsyncGenerator<ChatChunk> {
    if (this.silent) {
      yield { kind: 'done', usage: { ...emptyUsage(), input: 130 } }
      return
    }
    yield { kind: 'text', text: 'Half of the answer, ' }
    await new Promise(resolve => setTimeout(resolve, 500))
    yield { kind: 'text', text: 'and the other half.' }
    yield { kind: 'done', usage: { ...emptyUsage(), input: 130, output: 90 } }
  }
}

function stateOf(session: Session): SessionState {
  const rate = session.lastRate
  return {
    spend: { total: session.spent, subagents: emptyUsage(), harness: emptyUsage(), harnessCostUsd: 0 },
    context: session.context,
    ...(rate === undefined ? {} : { rate }),
  }
}

describe('a session read back after a restart', () => {
  it('shows the rate of its last turn, and a turn that generated nothing leaves it alone', async () => {
    const space = await addWorkspace(dir)
    const view = await createSession(space.id)
    const provider = new SlowProvider()
    const session = new Session(
      { sessionId: view.id, cwd: dir, model: 'test-model', systemPrompt: 'You are a test.', facts: { context: 100_000 } },
      provider,
      [],
    )
    await session.run('answer slowly')
    await noteTurn(view.id, 'answer slowly', stateOf(session))

    const reopened = (await workspaceStatus()).sessions.find(s => s.id === view.id)
    const rate = reopened?.rate
    if (rate === undefined) throw new Error('the rate was not read back')
    expect(rate.output).toBe(90)
    expect(rate.streamMs).toBeGreaterThanOrEqual(400)
    const shown = new Throughput()
    shown.seed(reopened?.usage?.output ?? 0, rate)
    expect(shown.value).toBeCloseTo(90 / (rate.streamMs / 1000), 5)

    // A turn that generated nothing has no rate of its own, so the stored one stays.
    provider.silent = true
    await session.run('say nothing')
    await noteTurn(view.id, 'say nothing', stateOf(session))
    expect((await workspaceStatus()).sessions.find(s => s.id === view.id)?.rate).toEqual(rate)
  })
})

/** Keeps what each request carried, and answers with one line. */
class RecordingProvider implements ChatProvider {
  sent: ChatMessage[][] = []

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    this.sent.push(input.messages)
    yield { kind: 'text', text: 'A red dot.' }
    yield { kind: 'done', usage: { ...emptyUsage(), input: 200, output: 4 } }
  }
}

/** A real one-pixel PNG, so the bytes that go to disk are a picture any viewer opens. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('a picture sent with a message', () => {
  it('goes to the model, is stored beside the transcript, and comes back when the session is reopened', async () => {
    const space = await addWorkspace(dir)
    const view = await createSession(space.id)
    const provider = new RecordingProvider()
    const session = new Session(
      { sessionId: view.id, cwd: dir, model: 'test-model', systemPrompt: 'You are a test.', facts: { context: 100_000 } },
      provider,
      [],
    )
    const images = acceptImages([{ mediaType: 'image/png', width: 1, height: 1, data: PIXEL }])
    await session.run('what is this?', images)

    const asked = provider.sent[0]?.find(m => m.role === 'user')
    expect(asked?.role === 'user' && asked.images?.map(image => image.data)).toEqual([PIXEL])

    await saveTranscript(view.id, session.transcript, session.notes)
    // The transcript names the picture and leaves its bytes to a file of their own.
    const file = await readFile(transcriptPath(view.id), 'utf8')
    expect(file).not.toContain(PIXEL)
    const folder = join(dirname(transcriptPath(view.id)), view.id, 'images')
    const stored = await readdir(folder)
    expect(stored).toEqual([`${images[0]?.id}.png`])
    expect((await readFile(join(folder, stored[0] ?? ''))).toString('base64')).toBe(PIXEL)

    const reopened = await loadTranscript(view.id)
    const shown = toTranscriptView(reopened).find(m => m.role === 'user')
    expect(shown?.images).toEqual([{ src: `data:image/png;base64,${PIXEL}`, width: 1, height: 1 }])

    // A picture whose file has gone is dropped, and the words it came with stay.
    await rm(folder, { recursive: true })
    const without = toTranscriptView(await loadTranscript(view.id)).find(m => m.role === 'user')
    expect(without).toEqual({ role: 'user', text: 'what is this?' })
  })

  it('is refused by a model known not to read pictures, before anything is sent', async () => {
    const provider = new RecordingProvider()
    const session = new Session(
      { sessionId: 'blind', cwd: dir, model: 'text-only', systemPrompt: 'You are a test.', facts: { context: 100_000, vision: false } },
      provider,
      [],
    )
    const images = acceptImages([{ mediaType: 'image/png', width: 1, height: 1, data: PIXEL }])
    await expect(session.run('what is this?', images)).rejects.toThrow('text-only does not take images')
    expect(provider.sent).toEqual([])
    expect(session.transcript.filter(m => m.role === 'user')).toEqual([])
  })

  it('is refused at the door when it is not a picture the window could have sent', () => {
    const upload = { mediaType: 'image/png', width: 1, height: 1, data: PIXEL }
    expect(() => acceptImages([{ ...upload, mediaType: 'image/svg+xml' }])).toThrow('type or size')
    expect(() => acceptImages([{ ...upload, width: 0 }])).toThrow('type or size')
    expect(() => acceptImages([{ ...upload, data: 'not base64!' }])).toThrow('base64')
    expect(() => acceptImages(Array.from({ length: 21 }, () => upload))).toThrow('20 images at most')
    expect(() => acceptImages('a picture')).toThrow('as a list')
  })
})
