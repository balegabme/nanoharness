// doc: docs/harness/providers.md
import { AsyncEntry } from '@napi-rs/keyring'
import type { EntryOptions } from '@napi-rs/keyring'

/**
 * The OS credential store: Credential Manager on Windows, the login keychain on
 * macOS, the Secret Service (GNOME Keyring, KWallet) on Linux. Provider API
 * keys and captured secrets are kept here under the service name `nanoharness`.
 * Nothing in this module imports Electron, so a process without a window can
 * read the keys the window saved, and no key is ever written to a file.
 *
 * Each key is its own entry. Windows caps one credential at 2560 bytes, which a
 * few keys packed into a single blob would pass. Values go in as UTF-8 bytes
 * and not as a password string, because Windows stores a password as UTF-16 and
 * that halves the room.
 */
const SERVICE = 'nanoharness'

/**
 * On Linux the Secret Service is required. Without the pin the library falls
 * back to the kernel keyring, which forgets every key at logout, so a key
 * would vanish without a word. A machine with no Secret Service reports the
 * store as unavailable instead.
 */
const OPTIONS: EntryOptions = { linux: { store: 'secret-service' } }

function entry(account: string): AsyncEntry {
  return new AsyncEntry(SERVICE, account, OPTIONS)
}

/**
 * The value stored under one account, or undefined when there is none. Throws
 * when the store cannot be read (locked, missing, or access denied), so a
 * caller can tell a key that is gone from one it cannot reach right now.
 */
export async function readKey(account: string): Promise<string | undefined> {
  // The binding answers null for an account with nothing stored, though its
  // types say undefined.
  const bytes: Uint8Array | undefined | null = await entry(account).getSecret()
  return bytes === undefined || bytes === null ? undefined : Buffer.from(bytes).toString('utf8')
}

/** Throws when the store refuses the write, so a key is never reported saved when it was not. */
export async function writeKey(account: string, value: string): Promise<void> {
  await entry(account).setSecret(Buffer.from(value, 'utf8'))
}

/** Removing an account that holds nothing is not an error. */
export async function deleteKey(account: string): Promise<void> {
  await entry(account).deleteCredential()
}

let available = false

/**
 * Whether this machine has a store to keep keys in, found by reading an account
 * nobody writes: a working store answers "nothing there", and a missing or
 * locked one throws. Only a yes is remembered. A Secret Service that was not up
 * yet, or a keychain the user has since unlocked, answers yes on the next ask.
 */
export async function keyStoreAvailable(): Promise<boolean> {
  if (available) return true
  try {
    await entry('probe').getSecret()
    available = true
  } catch {
    // A store the platform does not have can throw from the constructor as
    // well as from the read; both mean no.
  }
  return available
}
