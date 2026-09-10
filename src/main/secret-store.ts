// doc: docs/harness/secrets.md
import { safeStorage } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SecretVault } from '../core/secrets.js'
import { userDataDir } from '../core/usage-log.js'
import type { StoredSecret } from '../core/secrets.js'

/**
 * Where a captured key lives between launches: `secrets.bin`, encrypted by the
 * OS through the same `safeStorage` that holds the provider API keys.
 *
 * It has to survive a restart, because the placeholder in a stored transcript
 * does not mean anything without it — a session re-opened tomorrow would show
 * `{{secret:tavily_key}}` referring to a value that no longer exists, and the
 * next tool call would send that literal string to an API.
 *
 * Where encryption is unavailable the value is held in memory for the life of
 * the process and never written. A key in a plaintext file is worse than a key
 * the user has to paste again.
 */

export function secretsPath(): string {
  return join(userDataDir(), 'secrets.bin')
}

/** One vault for the whole app: a name means the same key in every session. */
let vault: Promise<SecretVault> | null = null
/** Writes are serialised, so two captures in the same turn cannot interleave. */
let writing: Promise<void> = Promise.resolve()

function parse(plain: string): StoredSecret[] {
  const parsed: unknown = JSON.parse(plain)
  if (!Array.isArray(parsed)) return []
  const out: StoredSecret[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, value, hint, at } = entry as Record<string, unknown>
    if (typeof name !== 'string' || name === '') continue
    if (typeof value !== 'string' || value === '') continue
    out.push({ name, value, hint: typeof hint === 'string' ? hint : 'secret', at: typeof at === 'number' ? at : Date.now() })
  }
  return out
}

async function read(): Promise<StoredSecret[]> {
  if (!safeStorage.isEncryptionAvailable()) return []
  const blob = await readFile(secretsPath()).catch(() => null)
  if (blob === null) return []
  try {
    return parse(safeStorage.decryptString(blob))
  } catch {
    // Encrypted for another user or another machine, so it cannot be read back.
    // Absent is the honest answer; the user re-pastes the key.
    return []
  }
}

async function write(secrets: readonly StoredSecret[]): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return
  if (secrets.length === 0) {
    await rm(secretsPath(), { force: true })
    return
  }
  const path = secretsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 })
}

/**
 * The vault, built once and shared. Every session gets this same object, so a
 * key pasted in one session is usable from another under the same name.
 */
export async function secretVault(): Promise<SecretVault> {
  // The promise is what is memoised, not the vault. Two callers that arrive
  // while the file is being read would otherwise both see `null`, both build,
  // and end up writing their keys into different objects — one of which is
  // then the one nobody holds.
  vault ??= (async () => {
    const built = new SecretVault(secrets => {
      writing = writing.then(() => write(secrets)).catch((err: unknown) => {
        process.stderr.write(`secrets: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    })
    built.restore(await read())
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
