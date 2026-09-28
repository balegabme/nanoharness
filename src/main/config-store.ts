// doc: docs/harness/providers.md
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clampEffort, isProviderKind, resolveFacts } from '../shared/facts.js'
import { ConfigError, selectedProvider, hostOf, isUsableBaseURL, newProviderId, normalizeBaseURL, parseApproval, parseFacts, parseStored, resolveConfig, parseHeaderName, SWITCH_NAMES } from '../core/config.js'
import { approvalProblem } from '../core/approval.js'
import { causeCode } from '../core/provider.js'
import { deleteKey, keyStoreAvailable, readKey, writeKey } from '../core/keyring.js'
import { createProvider, listModelsFor } from '../providers/factory.js'
import { KNOWN_PROVIDERS } from '../providers/profiles.js'
import { userDataDir } from '../core/usage-log.js'
import type { ApprovalConfig, JudgeEndpoint, PermissionMode } from '../core/approval.js'
import type { ActiveSetRequest, ConfigProbeRequest, ConfigProbeResult, ConfigStatus, ProviderSaveRequest } from '../ipc/contract.js'
import type { Effort, ModelFacts, ProviderConfig, ProviderRecord, StoredConfig, SwitchName } from '../core/config.js'

/**
 * Settings live in the OS user-data dir, never the repo, and split in two:
 * `config.json` holds the non-secret half and stays readable and diffable,
 * while each API key goes to the OS credential store under its provider's id
 * (`src/core/keyring.ts`). A plaintext key is never written anywhere.
 */
export function configPath(): string {
  return join(userDataDir(), 'config.json')
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

function keyAccount(providerId: string): string {
  return `provider:${providerId}`
}

/**
 * The stored key of each provider asked for, indexed by provider id. Only the
 * ones a caller needs are read, since on macOS each read by a new program can
 * raise a keychain prompt. A provider with no key, or one the store cannot
 * reach right now, is left out; `configStatus` says which of the two it is.
 */
async function readKeys(providerIds: readonly string[]): Promise<Record<string, string>> {
  const keys: Record<string, string> = {}
  await Promise.all(
    providerIds.map(async id => {
      const key = await readKey(keyAccount(id)).catch(() => undefined)
      if (key !== undefined && key !== '') keys[id] = key
    }),
  )
  return keys
}

async function saveKey(providerId: string, key: string): Promise<void> {
  try {
    await writeKey(keyAccount(providerId), key)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const hint = process.platform === 'linux' ? '; install a Secret Service keyring such as GNOME Keyring and try again' : ''
    throw new Error(`the OS credential store would not take the API key (${reason})${hint}`)
  }
}

/**
 * Create or update one provider. An id that is already known is edited in
 * place; a new one is appended and, when it is the first, becomes active.
 *
 * Says whether a live session has to be rebuilt to honour the write. A session
 * holds the record of whichever provider was active when it was built, so a
 * change to that record, or a move of the selection itself, means yes. Another
 * provider's fields, or a write carrying only prices and effort levels, means
 * no: **Fetch models** stores those without being asked.
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
  // A request that names no facts keeps the stored ones. An empty map is a
  // different answer: it is what a fetch that described nothing returns, and it
  // clears what an earlier fetch had left behind.
  //
  // Pointing the same provider at another address or wire is the third case.
  // The same model id costs different money at two addresses of one vendor, so
  // the facts go with the endpoint that used to answer there.
  const moved = previous !== undefined && (previous.baseURL !== baseURL || previous.kind !== request.kind)
  const facts = moved ? request.facts : (request.facts ?? previous?.facts)
  const overrides = applyOverrides(moved ? undefined : previous?.overrides, request.overrides)
  // Both maps arrived over IPC, so they are read the same way a file is before
  // anything is written.
  const clean = cleanFacts(facts)
  const cleanTyped = cleanFacts(overrides)
  if (clean !== undefined) record.facts = clean
  if (cleanTyped !== undefined) record.overrides = cleanTyped
  // Omitted means keep, which is what every save from the window means: no
  // screen offers this field, so a value put here by hand has to survive one.
  // An empty string is the other answer and clears it. Either way the name is
  // read the way it is read off disk, so one the file would have refused cannot
  // arrive over IPC instead.
  const sessionHeader = request.sessionHeader === undefined ? previous?.sessionHeader : parseHeaderName(request.sessionHeader)
  if (sessionHeader !== undefined) record.sessionHeader = sessionHeader

  const index = stored.providers.findIndex(p => p.id === id)
  if (index === -1) stored.providers.push(record)
  else stored.providers[index] = record

  const key = request.apiKey?.trim()
  const rekeyed = key !== undefined && key !== ''

  const active = stored.active
  const wanted = request.activeModel?.trim()
  if (wanted !== undefined && wanted !== '') {
    if (models.length > 0 && !models.includes(wanted)) {
      throw new Error(`the active model must be one of the selected models; ${wanted} is not`)
    }
    stored.active = { providerId: id, model: wanted, effort: active?.effort ?? 'medium' }
  } else if (active === undefined || !stored.providers.some(p => p.id === active.providerId)) {
    // The first provider added is the one sessions will use. Later ones wait
    // to be picked.
    const model = models[0]
    if (model !== undefined) stored.active = { providerId: id, model, effort: 'medium' }
  } else if (active.providerId === id && models.length > 0 && !models.includes(active.model)) {
    // The active model was just un-ticked. Fall back, and leave no selection
    // the allowlist has stopped permitting.
    const model = models[0]
    if (model !== undefined) stored.active = { ...active, model }
  }

  // Whatever the branches above settled on, the level has to be one the model
  // takes. A fetch is how the harness finds out that it does not, since the
  // list arrives with the answer, and every path out of here writes the file.
  const picked = stored.active
  if (picked !== undefined && picked.providerId === id) {
    stored.active = { ...picked, effort: effortFor(record, picked.model, picked.effort) }
  }

  // Only a move of the selection, or a write that touches the active record,
  // leaves a live session holding what the file no longer says. The effort
  // level is left out even on the active record: it is the one field a fetch
  // changes on its own, and it reaches the session the way a price does, on
  // the next build.
  const activeRecord = previous !== undefined && (active?.providerId === id || picked?.providerId === id)
  const rebuild =
    active?.providerId !== picked?.providerId ||
    active?.model !== picked?.model ||
    (activeRecord &&
      (rekeyed ||
        previous?.baseURL !== baseURL ||
        previous?.kind !== request.kind ||
        !sameModels(previous?.models ?? [], models)))

  // The key is written last before the settings, once nothing above can throw,
  // so a refused save leaves no entry in the store that no record points at.
  if (rekeyed) await saveKey(id, key)
  await writeStored(stored)
  return rebuild
}

/**
 * Whether two allowlists hold the same ids. Order is not compared: neither a
 * session nor the picker depends on it.
 */
function sameModels(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort()
  const right = [...b].sort()
  return left.length === right.length && left.every((model, index) => model === right[index])
}

/**
 * The effort level to run a model at, given the one in force. A model that
 * names its levels and not this one gets the nearest it does name. `setActive`
 * refuses such a level outright; this path has no user to refuse to, so it
 * clamps.
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
 * was cleared by the user and is not the same as a model the form did not
 * mention: a cleared model goes back to "nobody has said" and lets the
 * endpoint's own answer show through again.
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
  // The key goes first. A store that refuses the delete leaves the provider in
  // place for another try, where the other order would strand a key nothing
  // points at. A store that does not answer at all is skipped, or a machine
  // without one could never delete a provider.
  if (await keyStoreAvailable()) await deleteKey(keyAccount(id))
  const stored = await readStored()
  stored.providers = stored.providers.filter(p => p.id !== id)
  if (stored.active?.providerId === id) {
    const next = stored.providers[0]
    const model = next?.models[0]
    if (next !== undefined && model !== undefined) stored.active = { providerId: next.id, model, effort: stored.active.effort }
    else delete stored.active
  }
  await writeStored(stored)
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
  // window and not a normal pick. The window is not the only caller, and a
  // rejected level is a 400 from the provider mid-turn.
  const efforts = resolveFacts(provider, model).efforts
  if (efforts !== undefined && !efforts.includes(request.effort)) {
    throw new Error(`${model} does not take ${request.effort} effort; it takes ${efforts.join(', ')}`)
  }
  stored.active = { providerId: provider.id, model, effort: request.effort }
  await writeStored(stored)
}

/** The saved settings, key included. Throws ConfigError when incomplete. */
export async function loadProviderConfig(): Promise<ProviderConfig> {
  const stored = await readStored()
  const provider = selectedProvider(stored)
  return resolveConfig({ stored, secrets: provider === undefined ? {} : await readKeys([provider.id]) })
}

/** What `nh run` was told to run on, over what the settings say. */
export interface RunChoice {
  /** `provider/model`, where the provider is a saved one's id or name, or a model id for the selected provider. */
  model?: string
  effort?: Effort
}

/**
 * The settings `nh run` runs on. The saved ones by default, so a script meets
 * the model the window would use. `NH_BASE_URL` replaces them with an endpoint
 * described wholly by the environment (`NH_API_KIND`, `NH_API_KEY`, `NH_MODEL`),
 * which is how a machine with no settings and no credential store, such as a
 * container, runs at all. `NH_API_KEY` also stands in for a saved provider's
 * key when the store holds none for it. Throws ConfigError when incomplete.
 */
export async function loadRunConfig(choice: RunChoice, env: NodeJS.ProcessEnv = process.env): Promise<ProviderConfig> {
  const envKey = trimmed(env.NH_API_KEY)
  const baseURL = trimmed(env.NH_BASE_URL)
  let stored: StoredConfig
  if (baseURL !== undefined) {
    const kind = trimmed(env.NH_API_KIND) ?? 'openai'
    if (!isProviderKind(kind)) throw new Error(`NH_API_KIND must be openai, anthropic or responses, not ${kind}`)
    const provider: ProviderRecord = { id: 'environment', name: 'NH_BASE_URL', kind, baseURL, models: [] }
    const model = trimmed(choice.model) ?? trimmed(env.NH_MODEL)
    stored = { providers: [provider], ...(model === undefined ? {} : { active: { providerId: provider.id, model, effort: choice.effort ?? 'medium' } }) }
    return checkEffort(resolveConfig({ stored, secrets: envKey === undefined ? {} : { [provider.id]: envKey } }), choice.effort)
  }
  stored = await readStored()
  if (choice.model !== undefined) stored = choose(stored, choice.model)
  const provider = selectedProvider(stored)
  const keys = provider === undefined ? {} : await readKeys([provider.id])
  if (provider !== undefined && keys[provider.id] === undefined && envKey !== undefined) keys[provider.id] = envKey
  return checkEffort(resolveConfig({ stored, secrets: keys }), choice.effort)
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text === undefined || text === '' ? undefined : text
}

/**
 * The settings with `wanted` selected. A model id can hold a slash of its own,
 * so the part before the first slash names a provider only when a saved one
 * answers to it; otherwise the whole string is a model on the selected one.
 */
function choose(stored: StoredConfig, wanted: string): StoredConfig {
  const slash = wanted.indexOf('/')
  const named = slash < 0 ? undefined : wanted.slice(0, slash).toLowerCase()
  const match = named === undefined ? undefined : stored.providers.find(p => p.id.toLowerCase() === named || p.name.toLowerCase() === named)
  const provider = match ?? selectedProvider(stored)
  if (provider === undefined) return stored
  const model = match === undefined ? wanted : wanted.slice(slash + 1)
  const effort = stored.active?.effort ?? 'medium'
  return { ...stored, active: { providerId: provider.id, model, effort } }
}

/** The config at the effort asked for, refused when the model is known not to take it. */
function checkEffort(config: ProviderConfig, effort: Effort | undefined): ProviderConfig {
  if (effort === undefined) return config
  const efforts = resolveFacts(config.provider, config.model).efforts
  if (efforts !== undefined && !efforts.includes(effort)) {
    throw new Error(`${config.model} does not take ${effort} effort; it takes ${efforts.join(', ')}`)
  }
  return { ...config, effort }
}

/** What the settings screen renders itself from. Never carries a key. */
export async function configStatus(): Promise<ConfigStatus> {
  const stored = await readStored()
  const [secrets, canStore] = await Promise.all([readKeys(stored.providers.map(p => p.id)), keyStoreAvailable()])
  const status: ConfigStatus = {
    configured: false,
    providers: stored.providers.map(p => ({ ...p, hasKey: secrets[p.id] !== undefined })),
    keyStorage: canStore ? 'os' : 'unavailable',
    knownProviders: KNOWN_PROVIDERS,
    autoCompact: autoCompactOf(stored),
    contextLimit: stored.context?.limit ?? null,
    hooks: switchOf(stored, 'hooks'),
    downscaleImages: switchOf(stored, 'downscaleImages'),
  }
  if (stored.active !== undefined) status.active = stored.active
  if (stored.approval !== undefined) status.approval = stored.approval
  const gap = approvalProblem(stored.approval, stored.providers)
  if (gap !== undefined) status.approvalProblem = gap
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
 * was accepted. Failures come back as a value and not as a throw: a typo in a
 * URL is an expected outcome of a settings screen, not an exception.
 */
export async function probeProvider(request: ConfigProbeRequest): Promise<ConfigProbeResult> {
  const baseURL = normalizeBaseURL(request.baseURL.trim())
  if (!isUsableBaseURL(baseURL)) return { ok: false, error: `base URL must be an absolute http(s) URL, got "${request.baseURL}"` }

  // A blank key field means "keep the key already saved for this provider", so
  // re-testing a stored record works without retyping it.
  const typed = request.apiKey?.trim()
  let apiKey = typed !== undefined && typed !== '' ? typed : undefined
  if (apiKey === undefined && request.providerId !== undefined) {
    apiKey = await readKey(keyAccount(request.providerId)).catch(() => undefined)
  }
  if (apiKey === undefined || apiKey === '') return { ok: false, error: 'no API key to test with' }

  try {
    // Prices and effort levels come out of this one answer or not at all. A
    // model it says nothing about stays unknown until the user fills it in.
    const offers = await listModelsFor({ kind: request.kind, baseURL, apiKey })
    return { ok: true, models: offers }
  } catch (err) {
    return { ok: false, error: describeFailure(baseURL, err) }
  }
}

/**
 * A dead port makes Node's fetch throw the word "fetch failed" and nothing
 * else; the reason sits down in `cause`. Dig it out and name the address.
 */
function describeFailure(baseURL: string, err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.name === 'TimeoutError') return `${baseURL} did not answer in time`
  const code = causeCode(err)
  if (code === undefined) return err.message
  return `could not reach ${baseURL}: ${code}`
}

/**
 * Set which models auto mode may ask, in the order it should try them. A
 * candidate naming a provider that is not configured is refused and never
 * stored.
 */
export async function saveApproval(approval: ApprovalConfig): Promise<void> {
  // It came over IPC, so it is read the way the settings file is.
  const read = parseApproval(approval)
  if (read === undefined) throw new Error('the approval settings are not an object')
  const stored = await readStored()
  for (const candidate of read.candidates) {
    const provider = stored.providers.find(p => p.id === candidate.providerId)
    if (provider === undefined) throw new Error(`no provider with id ${candidate.providerId} is configured`)
    if (provider.models.length > 0 && !provider.models.includes(candidate.model)) {
      throw new Error(`${candidate.model} is not one of the models selected for ${provider.name}`)
    }
  }
  stored.approval = read
  await writeStored(stored)
}

/**
 * The mode a new session starts in, and where a change to it is remembered.
 * Stored on disk and not held in memory, so it survives a restart.
 */
export async function setDefaultMode(mode: PermissionMode): Promise<void> {
  const stored = await readStored()
  stored.permissionMode = mode
  await writeStored(stored)
}

export async function defaultMode(): Promise<PermissionMode> {
  return (await readStored()).permissionMode ?? 'ask'
}

/**
 * Whether sessions compact on their own. One setting for every session, on
 * until someone turns it off, because a session that fills its window with
 * it off stops with an error instead.
 */
export async function setAutoCompact(on: boolean): Promise<void> {
  const stored = await readStored()
  stored.context = { ...stored.context, auto: on }
  await writeStored(stored)
}

export async function autoCompact(): Promise<boolean> {
  return autoCompactOf(await readStored())
}

function autoCompactOf(stored: StoredConfig): boolean {
  return stored.context?.auto ?? true
}

/**
 * The most any context may grow to, for every session. Null clears it, and
 * compaction goes back to working against the model's window.
 */
export async function setContextLimit(limit: number | null): Promise<void> {
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('the context limit must be a whole number of tokens, above nought')
  }
  const stored = await readStored()
  const context = { ...stored.context }
  if (limit === null) delete context.limit
  else context.limit = limit
  stored.context = context
  await writeStored(stored)
}

export async function contextLimit(): Promise<number | undefined> {
  return (await readStored()).context?.limit
}

/**
 * One of the settings that is a single switch. A session reads it when it is
 * built, so turning hooks off reaches a live session once it is rebuilt.
 */
export async function setSwitch(name: SwitchName, on: boolean): Promise<void> {
  // The name picks a key in the settings file, so one from the window is
  // checked before it can write over some other setting.
  if (!SWITCH_NAMES.includes(name) || typeof on !== 'boolean') throw new Error(`not a switch: ${String(name)}`)
  const stored = await readStored()
  stored[name] = on
  await writeStored(stored)
}

export async function switchOn(name: SwitchName): Promise<boolean> {
  return switchOf(await readStored(), name)
}

function switchOf(stored: StoredConfig, name: SwitchName): boolean {
  return stored[name] ?? true
}

/** The approval ladder as clients, newest settings each time it is asked for. */
export async function approvalEndpoints(): Promise<JudgeEndpoint[]> {
  const stored = await readStored()
  const candidates = stored.approval?.candidates ?? []
  const secrets = await readKeys([...new Set(candidates.map(c => c.providerId))])
  const endpoints: JudgeEndpoint[] = []
  for (const candidate of candidates) {
    const record = stored.providers.find(p => p.id === candidate.providerId)
    if (record === undefined) continue
    const apiKey = secrets[record.id]
    // A rung with no key is skipped here and reported by the ladder when
    // every rung is gone.
    if (apiKey === undefined) continue
    const { wire } = resolveFacts(record, candidate.model)
    endpoints.push({
      providerId: record.id,
      model: candidate.model,
      record,
      provider: createProvider({
        kind: record.kind,
        baseURL: normalizeBaseURL(record.baseURL),
        apiKey,
        ...(wire === undefined ? {} : { wire }),
        ...(record.sessionHeader === undefined ? {} : { sessionHeader: record.sessionHeader }),
      }),
    })
  }
  return endpoints
}
