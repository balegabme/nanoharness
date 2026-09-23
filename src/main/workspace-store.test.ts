import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../core/session.js'
import { emptyUsage } from '../core/types.js'
import { Throughput } from '../renderer/metrics.js'
import { addWorkspace, createSession, noteTurn, workspaceStatus } from './workspace-store.js'
import type { ChatInput, ChatProvider } from '../core/provider.js'
import type { ChatChunk } from '../core/types.js'
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
