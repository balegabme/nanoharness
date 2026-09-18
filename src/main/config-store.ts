// doc: docs/harness/providers.md
import { safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ConfigError,
  hostOf,
  isUsableBaseURL,
  newProviderId,
  normalizeBaseURL,
  parseFacts,
  parseStored,
  clampEffort,
  resolveConfig,
  resolveFacts,
} from '../core/config.js'
import { listModelsFor } from '../providers/factory.js'
import { userDataDir } from '../core/usage-log.js'
import type { ActiveSetRequest, ConfigProbeRequest, ConfigProbeResult, ConfigStatus, ProviderSaveRequest } from '../ipc/contract.js'
import type { Effort, ModelFacts, ProviderConfig, ProviderRecord, StoredConfig } from '../core/config.js'

/**
 * Settings live in the OS user-data dir, never the repo, and split in two:
 * `config.json` holds the non-secret half and stays readable and diffable,
 * while the API keys go to `credentials.bin` encrypted by the OS (DPAPI on
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
  if (text === null) return { providers: [] }
  try {
    return parseStored(JSON.parse(text))
  } catch {
    return { providers: [] }
  }
}

async function writeStored(stored: StoredConfig): Promise<void> {
  await mkdir(userDataDir(), { recursive: true })
  await writeFile(configPath(), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
}

/**
 * One encrypted blob holding every key, indexed by provider id. A file written
 * by the single-provider version decrypts to a bare key string instead of a
 * map, so that shape is read back under the id its record was migrated to.
 */
export async function readSecrets(): Promise<Record<string, string>> {
  if (!safeStorage.isEncryptionAvailable()) return {}
  const blob = await readFile(credentialsPath()).catch(() => null)
  if (blob === null) return {}
  let plain: string
  try {
    plain = safeStorage.decryptString(blob)
  } catch {
    // A key encrypted for another OS user or machine cannot be read back.
    // Treat it as absent so settings can replace it.
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(plain)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === 'string' && key !== '') out[id] = key
    }
    return out
  } catch {
    return { legacy: plain }
  }
}

async function writeSecrets(secrets: Record<string, string>): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('this OS has no secret store, so an API key cannot be saved safely; install a keyring (libsecret) and try again')
  }
  const path = credentialsPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, safeStorage.encryptString(JSON.stringify(secrets)), { mode: 0o600 })
}

/**
 * Create or update one provider. An id that is already known is edited in
 * place; a new one is appended and, when it is the first, becomes active.
 *
 * Says whether a live session has to be rebuilt to honour the write. A session
 * holds the record of whichever provider was active when it was built, so a
 * change to that record — its address, wire kind, key, allowlist or active
 * model — means yes, and so does a move of the active selection itself. A write
 * to another provider's fields, or one carrying only prices and effort levels,
 * means no: **Fetch models** stores those without being asked, and a fetch
 * pressed during a turn must not be what ends it. A session already running
 * keeps what it was built with; the next one to be built reads the new file.
 */
export async function saveProvider(request: ProviderSaveRequest): Promise<boolean> {
  const baseURL = normalizeBaseURL(request.baseURL.trim())
  if (!isUsableBaseURL(baseURL)) throw new Error(`base URL must be an absolute http(s) URL, got "${request.baseURL}"`)

  const models = request.models.map(m => m.trim()).filter(m => m !== '')
  const stored = await readStored()
  const id = request.id ?? newProviderId()
  const previous = stored.providers.find(p => p.id === id)
  const record: ProviderRecord = {
    id,
    name: request.name.trim() === '' ? hostOf(baseURL) : request.name.trim(),
    kind: request.kind,
    baseURL,
    models,
  }
  // A request that names no facts at all keeps the stored ones, which is what a
  // caller with nothing to say about models needs. An empty map is a different
  // answer: it is what a fetch that described nothing returns, and it clears
  // what an earlier fetch of some other endpoint had left behind.
  //
  // Pointing the same provider at another address or another wire is the third
  // case. The prices and effort levels belonged to the endpoint that was there
  // before, and the same model id costs different money at two addresses of one
  // vendor, so both the fetched facts and the user's corrections go with what
  // used to answer there.
  const moved = previous !== undefined && (previous.baseURL !== baseURL || previous.kind !== request.kind)
  const facts = moved ? request.facts : (request.facts ?? previous?.facts)
  const overrides = applyOverrides(moved ? undefined : previous?.overrides, request.overrides)
  // Both maps arrived over IPC, so they are read the same way a file is before
  // anything is written: main is where a record stops being whatever the caller
  // sent and starts being a record.
  const clean = cleanFacts(facts)
  const cleanTyped = cleanFacts(overrides)
  if (clean !== undefined) record.facts = clean
  if (cleanTyped !== undefined) record.overrides = cleanTyped

  const index = stored.providers.findIndex(p => p.id === id)
  if (index === -1) stored.providers.push(record)
  else stored.providers[index] = record

  const key = request.apiKey?.trim()
  const rekeyed = key !== undefined && key !== ''
  if (rekeyed) {
    const secrets = await readSecrets()
    secrets[id] = key
    await writeSecrets(secrets)
  }

  const active = stored.active
  const wanted = request.activeModel?.trim()
  if (wanted !== undefined && wanted !== '') {
    if (models.length > 0 && !models.includes(wanted)) {
      throw new Error(`the active model must be one of the selected models; ${wanted} is not`)
    }
    stored.active = { providerId: id, model: wanted, effort: active?.effort ?? 'medium' }
  } else if (active === undefined || !stored.providers.some(p => p.id === active.providerId)) {
    // The first provider added is the one sessions will use. Later ones wait to
    // be picked, so adding a second endpoint never silently switches the model.
    const model = models[0]
    if (model !== undefined) stored.active = { providerId: id, model, effort: 'medium' }
  } else if (active.providerId === id && models.length > 0 && !models.includes(active.model)) {
    // The active model was just un-ticked. Fall back rather than leave a
    // selection the allowlist no longer permits.
    const model = models[0]
    if (model !== undefined) stored.active = { ...active, model }
  }

  // Whatever the branches above settled on, the level has to be one the model
  // takes. A fetch is how the harness finds out that it does not — the list
  // arrives with the answer — and every path out of here writes the file, so
  // the clamp belongs after them rather than inside each one.
  const picked = stored.active
  if (picked !== undefined && picked.providerId === id) {
    stored.active = { ...picked, effort: effortFor(record, picked.model, picked.effort) }
  }

  // A live session holds the record of whichever provider was active when it
  // was built, so only a move of the selection, or a write that touches the
  // active record, leaves it holding what the file no longer says. Another
  // provider's fields are not what a session was built from, and a fetch of one
  // must not end a turn running on a different endpoint. The effort level is
  // left out on purpose even on the active record: it is the one field a fetch
  // changes on its own — the model's list of levels arrives with the answer and
  // the level in force is clamped to it above — and ending a running turn over
  // that would be the fetch doing the damage the clamp is there to avoid. It
  // reaches the session the way a price does, on the next build.
  const activeRecord = previous !== undefined && (active?.providerId === id || picked?.providerId === id)
  const rebuild =
    active?.providerId !== picked?.providerId ||
    active?.model !== picked?.model ||
    (activeRecord &&
      (rekeyed ||
        previous?.baseURL !== baseURL ||
        previous?.kind !== request.kind ||
        !sameModels(previous?.models ?? [], models)))

  await writeStored(stored)
  return rebuild
}

/**
 * Whether two allowlists hold the same ids. A session does not care what order
 * the list was ticked in, and neither does the picker: a reorder is not a
 * change worth retiring a live session over.
 */
function sameModels(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort()
  const right = [...b].sort()
  return left.length === right.length && left.every((model, index) => model === right[index])
}

/**
 * The effort level to run a model at, given the one in force. A model that
 * names its levels and does not name this one gets the nearest it does name,
 * the same answer the window's picker arrives at; `setActive` refuses such a
 * level outright, and this path has no user to refuse to, so it clamps instead
 * of writing a level the next turn would be rejected for.
 */
function effortFor(record: ProviderRecord, model: string, wanted: Effort | undefined): Effort {
  const effort = wanted ?? 'medium'
  const efforts = resolveFacts(record, model).efforts
  return efforts === undefined || efforts.length === 0 ? effort : clampEffort(efforts, effort)
}

/** Every model's facts as this harness will store them, or undefined when none survive. */
function cleanFacts(map: Record<string, ModelFacts> | undefined): Record<string, ModelFacts> | undefined {
  if (map === undefined) return undefined
  const out: Record<string, ModelFacts> = {}
  for (const [model, facts] of Object.entries(map)) {
    const kept = parseFacts(facts)
    if (kept !== undefined) out[model] = kept
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Fold the form's corrections into the stored ones. A model mapped to `null`
 * was cleared by the user, which has to be told apart from a model the form did
 * not mention: clearing is how a wrong price typed yesterday goes back to
 * "nobody has said" and lets the endpoint's own answer show through again.
 */
function applyOverrides(
  stored: Record<string, ModelFacts> | undefined,
  incoming: Record<string, ModelFacts | null> | undefined,
): Record<string, ModelFacts> | undefined {
  if (incoming === undefined) return stored
  const merged: Record<string, ModelFacts> = { ...stored }
  for (const [model, facts] of Object.entries(incoming)) {
    if (facts === null) delete merged[model]
    else merged[model] = facts
  }
  return Object.keys(merged).length === 0 ? undefined : merged
}

export async function deleteProvider(id: string): Promise<void> {
  const stored = await readStored()
  stored.providers = stored.providers.filter(p => p.id !== id)
  if (stored.active?.providerId === id) {
    const next = stored.providers[0]
    const model = next?.models[0]
    if (next !== undefined && model !== undefined) stored.active = { providerId: next.id, model, effort: stored.active.effort }
    else delete stored.active
  }
  await writeStored(stored)

  const secrets = await readSecrets()
  if (id in secrets) {
    delete secrets[id]
    await writeSecrets(secrets)
  }
}

/** Switch provider, model or effort. This is what the header chips call. */
export async function setActive(request: ActiveSetRequest): Promise<void> {
  const stored = await readStored()
  const provider = stored.providers.find(p => p.id === request.providerId)
  if (provider === undefined) throw new Error('that provider is not configured any more')
  const model = request.model.trim()
  if (model === '') throw new Error('model must not be empty')
  if (provider.models.length > 0 && !provider.models.includes(model)) {
    throw new Error(`${model} is not one of the models selected for ${provider.name}`)
  }
  // The composer only offers levels the model takes, so this catches a stale
  // window rather than a normal pick. It is here because the window is not the
  // only caller and a rejected level is a 400 from the provider mid-turn.
  const efforts = resolveFacts(provider, model).efforts
  if (efforts !== undefined && !efforts.includes(request.effort)) {
    throw new Error(`${model} does not take ${request.effort} effort; it takes ${efforts.join(', ')}`)
  }
  stored.active = { providerId: provider.id, model, effort: request.effort }
  await writeStored(stored)
}

/** The saved settings, decrypted key included. Throws ConfigError when incomplete. */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  const [stored, secrets] = await Promise.all([readStored(), readSecrets()])
  return resolveConfig({ stored, secrets })
}

/** What the settings screen renders itself from. Never carries a key. */
export async function configStatus(): Promise<ConfigStatus> {
  const [stored, secrets] = await Promise.all([readStored(), readSecrets()])
  const status: ConfigStatus = {
    configured: false,
    providers: stored.providers.map(p => ({ ...p, hasKey: secrets[p.id] !== undefined })),
    keyStorage: safeStorage.isEncryptionAvailable() ? 'os' : 'unavailable',
  }
  if (stored.active !== undefined) status.active = stored.active
  try {
    const resolved = resolveConfig({ stored, secrets })
    return {
      ...status,
      configured: true,
      active: { providerId: resolved.provider.id, model: resolved.model, effort: resolved.effort },
    }
  } catch (err) {
    if (err instanceof ConfigError) return { ...status, problem: err.message }
    throw err
  }
}

/**
 * Ask an endpoint what it can run, before anything is saved. The same call is
 * the connection test: an answer proves the endpoint is reachable and the key
 * was accepted. Failures come back as a value, not a throw — a typo in a URL is
 * an expected outcome of a settings screen, not an exception.
 */
export async function probeProvider(request: ConfigProbeRequest): Promise<ConfigProbeResult> {
  const baseURL = normalizeBaseURL(request.baseURL.trim())
  if (!isUsableBaseURL(baseURL)) return { ok: false, error: `base URL must be an absolute http(s) URL, got "${request.baseURL}"` }

  // A blank key field means "keep the key already saved for this provider", so
  // re-testing a stored record works without retyping it.
  const typed = request.apiKey?.trim()
  let apiKey = typed !== undefined && typed !== '' ? typed : undefined
  if (apiKey === undefined && request.providerId !== undefined) {
    apiKey = (await readSecrets())[request.providerId]
  }
  if (apiKey === undefined || apiKey === '') return { ok: false, error: 'no API key to test with' }

  try {
    // Prices and effort levels come out of this one answer or not at all. The
    // endpoint is the only thing here that knows what it charges, and a model
    // it says nothing about stays unknown until the user fills it in.
    const offers = await listModelsFor({ kind: request.kind, baseURL, apiKey })
    return { ok: true, models: offers }
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
