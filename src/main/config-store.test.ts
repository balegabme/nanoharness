import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoCompact, contextLimit, readStored, saveProvider, setAutoCompact, setContextLimit } from './config-store.js'
import type { ProviderSaveRequest } from '../ipc/contract.js'

/**
 * What a settings write tells main to do with the live sessions. A session
 * holds the record of whichever provider was active when it was built, so a
 * fetch of some other endpoint's model list must not end a turn that is running
 * somewhere else (docs/harness/providers.md, "Model facts").
 *
 * These run against a real config file in a scratch directory. The only thing
 * stood in for is the OS keyring, which this machine cannot provide in a test;
 * none of the cases here stores a key.
 */

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    decryptString: () => {
      throw new Error('no secret store')
    },
    encryptString: () => Buffer.alloc(0),
  },
}))

const originals = { APPDATA: process.env.APPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME }
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nh-config-'))
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

function provider(name: string, over: Partial<ProviderSaveRequest> = {}): ProviderSaveRequest {
  return { name, kind: 'openai', baseURL: `https://${name.toLowerCase()}.test/v1`, models: [], ...over }
}

async function idOf(name: string): Promise<string> {
  const found = (await readStored()).providers.find(p => p.name === name)
  if (found === undefined) throw new Error(`${name} was not stored`)
  return found.id
}

describe('a settings write against the live sessions', () => {
  it('retires for the first provider, which becomes active', async () => {
    expect(await saveProvider(provider('A', { models: ['m1'] }))).toBe(true)
    expect((await readStored()).active).toMatchObject({ providerId: await idOf('A'), model: 'm1' })
  })

  it('leaves them alone when a fetch changes another provider', async () => {
    await saveProvider(provider('A', { models: ['m1'] }))
    const first = await saveProvider(provider('B'))
    expect(first).toBe(false)

    // The same click again, now carrying the list and prices the fetch found.
    // A session is running on A, and nothing B says is part of it.
    const fetched = await saveProvider(provider('B', { id: await idOf('B'), models: ['b1', 'b2'], facts: { b1: { input: 1, output: 2 } } }))
    expect(fetched).toBe(false)
    expect((await readStored()).active).toMatchObject({ providerId: await idOf('A'), model: 'm1' })
    expect((await readStored()).providers.find(p => p.name === 'B')?.facts).toEqual({ b1: { input: 1, output: 2 } })
  })

  it('leaves them alone for prices and effort levels alone, and keeps only facts', async () => {
    await saveProvider(provider('A', { models: ['m1'] }))
    const a = await idOf('A')
    expect(await saveProvider(provider('A', { id: a, models: ['m1'], facts: { m1: { input: 1, output: 2, maxOutput: 0.5 } } }))).toBe(false)
    // The sub-token ceiling floors to zero, and zero is not a ceiling.
    expect((await readStored()).providers.find(p => p.id === a)?.facts?.m1).toEqual({ input: 1, output: 2 })
  })

  it('retires when the active provider moves, and its facts go with the old address', async () => {
    await saveProvider(provider('A', { models: ['m1'], facts: { m1: { input: 1, output: 2 } } }))
    expect(await saveProvider(provider('A', { id: await idOf('A'), baseURL: 'https://a.test/v2', models: ['m1'] }))).toBe(true)
    expect((await readStored()).providers[0]?.facts).toBeUndefined()
  })

  it('does not retire for another provider on a new wire, and still drops what the old one said', async () => {
    await saveProvider(provider('A', { models: ['m1'] }))
    await saveProvider(provider('B', { models: ['b1'], facts: { b1: { input: 1, output: 2 } } }))
    const b = await idOf('B')
    expect(await saveProvider(provider('B', { id: b, kind: 'anthropic', models: ['b1'] }))).toBe(false)
    expect((await readStored()).providers.find(p => p.id === b)?.facts).toBeUndefined()
  })

  it('retires when a save moves the selection to another provider', async () => {
    await saveProvider(provider('A', { models: ['m1'] }))
    await saveProvider(provider('B', { models: ['b1'] }))
    const b = await idOf('B')
    expect(await saveProvider(provider('B', { id: b, models: ['b1'], activeModel: 'b1' }))).toBe(true)
    expect((await readStored()).active).toMatchObject({ providerId: b, model: 'b1' })
  })

  it('does not retire for the same allowlist in another order', async () => {
    await saveProvider(provider('A', { models: ['m1', 'm2'] }))
    const a = await idOf('A')
    expect(await saveProvider(provider('A', { id: a, models: ['m2', 'm1'] }))).toBe(false)
    expect((await readStored()).active).toMatchObject({ providerId: a, model: 'm1' })
  })

  it('retires when an allowlist changes, a repeated id included', async () => {
    await saveProvider(provider('A', { models: ['m1', 'm2'] }))
    const a = await idOf('A')
    expect(await saveProvider(provider('A', { id: a, models: ['m1', 'm1'] }))).toBe(true)
  })

  it('retires when the active provider changes wire, and drops its facts', async () => {
    await saveProvider(provider('A', { models: ['m1'], facts: { m1: { input: 1, output: 2 } } }))
    const a = await idOf('A')
    expect(await saveProvider(provider('A', { id: a, kind: 'anthropic', models: ['m1'] }))).toBe(true)
    expect((await readStored()).providers.find(p => p.id === a)?.facts).toBeUndefined()
  })

  it('falls back to a model that is still ticked when the active one is not', async () => {
    await saveProvider(provider('A', { models: ['m1', 'm2'] }))
    const a = await idOf('A')
    expect(await saveProvider(provider('A', { id: a, models: ['m2'] }))).toBe(true)
    expect((await readStored()).active).toMatchObject({ providerId: a, model: 'm2' })
  })

  it('clears stored facts when a fetch reports none', async () => {
    await saveProvider(provider('A', { models: ['m1'], facts: { m1: { input: 1, output: 2 } } }))
    const a = await idOf('A')
    expect(await saveProvider(provider('A', { id: a, models: ['m1'], facts: {} }))).toBe(false)
    expect((await readStored()).providers.find(p => p.id === a)?.facts).toBeUndefined()
  })
})

describe('the context settings', () => {
  it('keeps the limit through a read and through a write of the other setting, and clears it on null', async () => {
    await setContextLimit(150_000)
    await setAutoCompact(false)
    expect(await contextLimit()).toBe(150_000)

    await setContextLimit(null)
    expect(await contextLimit()).toBeUndefined()
    expect(await autoCompact()).toBe(false)
  })

  it('refuses a limit that is not a whole number of tokens and keeps the one it had', async () => {
    await setContextLimit(80_000)
    for (const bad of [0, -5, 1.5, Number.NaN]) await expect(setContextLimit(bad)).rejects.toThrow('whole number of tokens')
    expect(await contextLimit()).toBe(80_000)
  })
})
