// doc: docs/harness/secrets.md
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SecretVault } from '../core/secrets.js'
import { deleteKey, keyStoreAvailable, readKey, writeKey } from '../core/keyring.js'
import { userDataDir } from '../core/usage-log.js'
import type { StoredSecret } from '../core/secrets.js'

/**
 * Where a captured key lives between launches. The value goes to the OS
 * credential store, one entry per name, like the provider API keys. The names,
 * vendor hints and capture times go to `secrets.json`, which is what a launch
 * reads to know which entries to ask the store for.
 *
 * It has to survive a restart, because the placeholder in a stored transcript
 * does not mean anything without it: a session re-opened tomorrow would show
 * `{{secret:tavily_key}}` referring to a value that no longer exists, and the
 * next tool call would send that literal string to an API.
 *
 * A value the store will not take is held in memory for the life of the
 * process and left out of the index. A key in a plaintext file is worse than a
 * key the user has to paste again.
 */

export function secretsIndexPath(): string {
  return join(userDataDir(), 'secrets.json')
}

function account(name: string): string {
  return `secret:${name}`
}

/** One vault for the whole app: a name means the same key in every session. */
let vault: Promise<SecretVault> | null = null
/** Writes are serialised, so two captures in the same turn cannot interleave. */
let writing: Promise<void> = Promise.resolve()
/** What the store holds, name to value, as far as this process has seen. */
const persisted = new Map<string, string>()
/**
 * Index entries whose value the store could not be asked for at launch, most
 * likely because it was locked. They stay in the index, and their values stay
 * in the store, for a launch that can read them.
 */
const unread: IndexEntry[] = []

type IndexEntry = Omit<StoredSecret, 'value'>

function parseIndex(text: string): IndexEntry[] {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) return []
  const out: IndexEntry[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, hint, at } = entry as Record<string, unknown>
    if (typeof name !== 'string' || name === '') continue
    out.push({ name, hint: typeof hint === 'string' ? hint : 'secret', at: typeof at === 'number' ? at : Date.now() })
  }
  return out
}

async function read(): Promise<StoredSecret[]> {
  const text = await readFile(secretsIndexPath(), 'utf8').catch(() => null)
  if (text === null) return []
  let index: IndexEntry[]
  try {
    index = parseIndex(text)
  } catch {
    return []
  }
  const out: StoredSecret[] = []
  for (const entry of index) {
    let value: string | undefined
    try {
      value = await readKey(account(entry.name))
    } catch {
      unread.push(entry)
      continue
    }
    // Gone from the store (deleted by hand, or another OS user), so the name
    // is dropped at the next write and the user re-pastes the key.
    if (value === undefined || value === '') continue
    persisted.set(entry.name, value)
    out.push({ ...entry, value })
  }
  return out
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Bring the store and the index in line with the vault. Only a name the store
 * does not already hold under the same value is written, so a store that
 * refuses one write never costs a key that was already safe. The index is
 * written before anything is deleted: a delete that fails then leaves an entry
 * nothing lists, where the other order would bring a forgotten key back.
 */
async function write(secrets: readonly StoredSecret[]): Promise<void> {
  if (!(await keyStoreAvailable())) return
  for (const { name, value } of secrets) {
    if (persisted.get(name) === value) continue
    try {
      await writeKey(account(name), value)
      persisted.set(name, value)
    } catch (err) {
      process.stderr.write(`secrets: ${name} is held in memory only: ${reasonOf(err)}\n`)
    }
  }
  const held = new Set(secrets.map(s => s.name))
  const index: IndexEntry[] = [
    ...unread,
    ...secrets.filter(s => persisted.get(s.name) === s.value).map(({ name, hint, at }) => ({ name, hint, at })),
  ]
  if (index.length === 0) {
    await rm(secretsIndexPath(), { force: true })
  } else {
    await mkdir(userDataDir(), { recursive: true })
    await writeFile(secretsIndexPath(), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }
  for (const name of [...persisted.keys()]) {
    if (held.has(name)) continue
    try {
      await deleteKey(account(name))
      persisted.delete(name)
    } catch (err) {
      process.stderr.write(`secrets: ${name} was forgotten but is still in the credential store: ${reasonOf(err)}\n`)
    }
  }
}

/**
 * The vault, built once and shared. Every session gets this same object, so a
 * key pasted in one session is usable from another under the same name.
 */
export async function secretVault(): Promise<SecretVault> {
  // The promise is what is memoised, not the vault. Two callers that arrive
  // while the file is being read would otherwise both see `null`, both build,
  // and end up writing their keys into different objects, one of which is
  // then the one nobody holds.
  vault ??= (async () => {
    const built = new SecretVault(secrets => {
      writing = writing.then(() => write(secrets)).catch((err: unknown) => {
        process.stderr.write(`secrets: ${reasonOf(err)}\n`)
      })
    })
    built.restore(await read())
    built.reserve(unread.map(entry => entry.name))
    return built
  })()
  return vault
}

/** Names and vendors only. The value never crosses IPC, not even to settings. */
export async function secretList(): Promise<{ name: string; hint: string; at: number }[]> {
  const store = await secretVault()
  return store.list().map(({ name, hint, at }) => ({ name, hint, at }))
}

export async function forgetSecret(name: string): Promise<{ name: string; hint: string; at: number }[]> {
  ;(await secretVault()).remove(name)
  return secretList()
}

/** Flush any queued write. Quitting waits for this so a capture is not lost. */
export async function flushSecrets(): Promise<void> {
  await writing
}
