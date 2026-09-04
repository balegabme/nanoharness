// doc: docs/harness/providers.md
import { safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ConfigError, isUsableBaseURL, normalizeBaseURL, resolveConfig } from '../core/config.js'
import { listModels } from '../providers/openai.js'
import { userDataDir } from '../core/usage-log.js'
import type { ConfigProbeRequest, ConfigProbeResult, ConfigStatus } from '../ipc/contract.js'
import type { ProviderConfig, StoredConfig } from '../core/config.js'

/**
 * Settings live in the OS user-data dir, never the repo, and split in two:
 * `config.json` holds the non-secret half and stays readable and diffable,
 * while the API key goes to `credentials.bin` encrypted by the OS (DPAPI on
 * Windows, Keychain on macOS, libsecret on Linux) through Electron's
 * safeStorage. A plaintext key is never written anywhere.
 */
export function configPath(): string {
  return join(userDataDir(), 'config.json')
}

export function credentialsPath(): string {
  return join(userDataDir(), 'credentials.bin')
}

export async function readStored(): Promise<StoredConfig> {
  const text = await readFile(configPath(), 'utf8').catch(() => null)
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record = parsed as Record<string, unknown>
  const stored: StoredConfig = {}
  if (typeof record.baseURL === 'string') stored.baseURL = record.baseURL
  if (typeof record.model === 'string') stored.model = record.model
  if (Array.isArray(record.models)) stored.models = record.models.filter((m): m is string => typeof m === 'string')
  return stored
}

export async function readSecret(): Promise<string | undefined> {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  const blob = await readFile(credentialsPath()).catch(() => null)
  if (blob === null) return undefined
  try {
    return safeStorage.decryptString(blob)
  } catch {
    // A key encrypted for another OS user or machine cannot be read back.
    // Treat it as absent so setup can replace it.
    return undefined
  }
}

export interface Settings {
  baseURL: string
  model: string
  /** Omit to keep whatever key is already stored. */
  apiKey?: string
  /** The models the user selected. Omit to keep the saved selection. */
  models?: string[]
}

export async function writeSettings(settings: Settings): Promise<void> {
  const baseURL = normalizeBaseURL(settings.baseURL.trim())
  const model = settings.model.trim()
  if (!isUsableBaseURL(baseURL)) throw new Error(`base URL must be an absolute http(s) URL, got "${settings.baseURL}"`)
  if (model === '') throw new Error('model must not be empty')

  const models = settings.models?.map(m => m.trim()).filter(m => m !== '')
  if (models !== undefined && models.length > 0 && !models.includes(model)) {
    throw new Error(`the active model must be one of the selected models; ${model} is not`)
  }

  const dir = userDataDir()
  await mkdir(dir, { recursive: true })

  const key = settings.apiKey?.trim()
  if (key !== undefined && key !== '') {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('this OS has no secret store, so an API key cannot be saved safely; install a keyring (libsecret) and try again')
    }
    const path = credentialsPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, safeStorage.encryptString(key), { mode: 0o600 })
  }

  const previous = await readStored()
  const stored: StoredConfig = { baseURL, model }
  // Omitting the list means "keep what was chosen", so saving from a
  // settings screen that never fetched models does not wipe the selection.
  const selection = models ?? previous.models
  if (selection !== undefined && selection.length > 0) stored.models = selection
  await writeFile(configPath(), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
}

/** The saved settings, decrypted key included. Throws ConfigError when incomplete. */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  const [stored, secret] = await Promise.all([readStored(), readSecret()])
  return resolveConfig({ stored, secret })
}

/** What the setup screen needs to render itself. Never carries the key. */
export async function configStatus(): Promise<ConfigStatus> {
  const [stored, secret] = await Promise.all([readStored(), readSecret()])
  const status: ConfigStatus = {
    configured: false,
    baseURL: stored.baseURL ?? '',
    model: stored.model ?? '',
    hasKey: secret !== undefined,
    models: stored.models ?? [],
    keyStorage: safeStorage.isEncryptionAvailable() ? 'os' : 'unavailable',
  }
  try {
    const resolved = resolveConfig({ stored, secret })
    return { ...status, configured: true, baseURL: resolved.baseURL, model: resolved.model, hasKey: true }
  } catch (err) {
    if (err instanceof ConfigError) return { ...status, problem: err.message }
    throw err
  }
}

/**
 * Ask a provider what it can run, before anything is saved. The same call is
 * the connection test: an answer proves the endpoint is reachable and the key
 * was accepted. Failures come back as a value, not a throw — a typo in a URL is
 * an expected outcome of a settings screen, not an exception.
 */
export async function probeProvider(request: ConfigProbeRequest): Promise<ConfigProbeResult> {
  const baseURL = normalizeBaseURL(request.baseURL.trim())
  if (!isUsableBaseURL(baseURL)) return { ok: false, error: `base URL must be an absolute http(s) URL, got "${request.baseURL}"` }

  // A blank field in the settings screen means "keep the key I already saved",
  // so a re-test after reopening settings works without retyping it.
  const typed = request.apiKey?.trim()
  const apiKey = typed !== undefined && typed !== '' ? typed : await readSecret()
  if (apiKey === undefined || apiKey === '') return { ok: false, error: 'no API key to test with' }

  try {
    return { ok: true, models: await listModels({ baseURL, apiKey }) }
  } catch (err) {
    return { ok: false, error: describeFailure(baseURL, err) }
  }
}

/**
 * A dead port makes Node's fetch throw the word "fetch failed" and nothing
 * else; the reason sits in `cause`. Dig it out, because "fetch failed" tells a
 * user nothing about which address failed or why.
 */
function describeFailure(baseURL: string, err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.name === 'TimeoutError') return `${baseURL} did not answer in time`
  if (err.message !== 'fetch failed') return err.message

  const cause: unknown = err.cause
  const detail =
    cause instanceof Error
      ? ((cause as { code?: unknown }).code ?? cause.message)
      : undefined
  return `could not reach ${baseURL}${detail === undefined ? '' : `: ${String(detail)}`}`
}
