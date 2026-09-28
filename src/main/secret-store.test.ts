import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A captured key across launches of the app. Each launch is a fresh import of
 * the store, reading what the last one left in a scratch user-data directory.
 * The OS credential store is a map here, one a test can lock or make refuse a
 * write, since a test must not put keys into the user's real one.
 */

const keyring = vi.hoisted(() => ({
  entries: new Map<string, Uint8Array>(),
  locked: false,
  refuseWrites: false,
}))

vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    private readonly id: string
    constructor(service: string, account: string) {
      this.id = `${service}/${account}`
    }
    getSecret(): Promise<Uint8Array | null> {
      if (keyring.locked) return Promise.reject(new Error('the keychain is locked'))
      return Promise.resolve(keyring.entries.get(this.id) ?? null)
    }
    setSecret(secret: Uint8Array): Promise<void> {
      if (keyring.locked || keyring.refuseWrites) return Promise.reject(new Error('refused'))
      keyring.entries.set(this.id, secret)
      return Promise.resolve()
    }
    deleteCredential(): Promise<boolean> {
      if (keyring.locked) return Promise.reject(new Error('the keychain is locked'))
      return Promise.resolve(keyring.entries.delete(this.id))
    }
  },
}))

const FIRST = 'tvly-aaaaaaaaaaaaaaaaaaaaaaaa'
const SECOND = 'tvly-bbbbbbbbbbbbbbbbbbbbbbbb'

const originals = { APPDATA: process.env.APPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HOME: process.env.HOME }
let dir = ''

beforeEach(async () => {
  keyring.entries.clear()
  keyring.locked = false
  keyring.refuseWrites = false
  dir = await mkdtemp(join(tmpdir(), 'nh-secrets-'))
  process.env.APPDATA = dir
  process.env.XDG_DATA_HOME = dir
  process.env.HOME = dir
})

afterEach(async () => {
  for (const [name, value] of Object.entries(originals)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(dir, { recursive: true, force: true })
})

/** Start the app again: every module-level cache goes, the files and the store stay. */
async function launch(): Promise<typeof import('./secret-store.js')> {
  vi.resetModules()
  return import('./secret-store.js')
}

/** Paste a key the way the composer does, and wait for it to be written down. */
async function paste(store: Awaited<ReturnType<typeof launch>>, key: string): Promise<string> {
  const { captured } = (await store.secretVault()).capture(`the key is ${key}`)
  await store.flushSecrets()
  const name = captured[0]
  if (name === undefined) throw new Error(`${key} was not captured`)
  return name
}

async function names(store: Awaited<ReturnType<typeof launch>>): Promise<string[]> {
  return (await store.secretList()).map(s => s.name)
}

describe('a captured key between launches', () => {
  it('comes back after a restart, keeps its value out of the index, and is gone for good once forgotten', async () => {
    let store = await launch()
    const name = await paste(store, FIRST)
    expect(await readFile(store.secretsIndexPath(), 'utf8')).not.toContain(FIRST)

    store = await launch()
    expect((await store.secretVault()).reveal(`{{secret:${name}}}`)).toBe(FIRST)

    await store.forgetSecret(name)
    await store.flushSecrets()
    expect(keyring.entries.size).toBe(0)
    store = await launch()
    expect(await names(store)).toEqual([])
  })

  it('costs only the new key when the store refuses a write', async () => {
    let store = await launch()
    const first = await paste(store, FIRST)
    keyring.refuseWrites = true
    const second = await paste(store, SECOND)
    // This launch still has both; the refused one is in memory only.
    expect((await store.secretVault()).reveal(`{{secret:${second}}}`)).toBe(SECOND)

    keyring.refuseWrites = false
    store = await launch()
    expect(await names(store)).toEqual([first])
    expect((await store.secretVault()).reveal(`{{secret:${first}}}`)).toBe(FIRST)
  })

  it('keeps a name the store was locked for at launch, for the next launch that can read it', async () => {
    let store = await launch()
    const first = await paste(store, FIRST)

    keyring.locked = true
    store = await launch()
    expect(await names(store)).toEqual([])
    // The keychain is unlocked mid-session and another key is pasted. The index
    // written now must still list the one this launch could not read.
    keyring.locked = false
    const second = await paste(store, SECOND)

    store = await launch()
    expect((await names(store)).sort()).toEqual([first, second].sort())
    expect((await store.secretVault()).reveal(`{{secret:${first}}}`)).toBe(FIRST)
  })
})
