// doc: docs/harness/providers.md
import { randomUUID } from 'node:crypto'
import { isPermissionMode } from './approval.js'
import type { ApprovalCandidate, ApprovalConfig, ApprovalRules, PermissionMode } from './approval.js'

/** The wire formats NanoHarness speaks. */
export type ProviderKind = 'openai' | 'anthropic' | 'responses'

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'responses']

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)
}

/**
 * How hard the model should think. One neutral scale across vendors: OpenAI
 * gets `reasoning_effort`, Anthropic gets a thinking budget, and a model that
 * supports neither ignores it (plan §11). Which of these a given model takes
 * varies by family and an unknown one is a 400, so the picker narrows the list
 * per model from `ModelFacts`.
 */
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

/**
 * A list of levels in the order the scale runs, low to high. Endpoints answer
 * in whatever order they please (Anthropic's block is alphabetical), and this
 * list is what orders the picker in the composer.
 */
export function sortEfforts(efforts: readonly Effort[]): Effort[] {
  return EFFORTS.filter(effort => efforts.includes(effort))
}

/**
 * The nearest level a model actually takes, when the one in hand is not one.
 * A level the provider does not know is a 400 mid-turn, so nothing sends an
 * unclamped one. src/renderer/facts.ts holds a copy for the window, which
 * cannot import this file; src/providers/model-facts.test.ts pins the two.
 */
export function clampEffort(offered: readonly Effort[], wanted: Effort): Effort {
  if (offered.includes(wanted)) return wanted
  const from = EFFORTS.indexOf(wanted)
  let best: Effort | undefined
  let nearest = Number.POSITIVE_INFINITY
  // The nearest level on the scale in either direction, so leaving a model for
  // one with no `max` lands on `high`, and `minimal` on a model whose lowest
  // level is `low` moves up to it.
  for (const effort of EFFORTS) {
    if (!offered.includes(effort)) continue
    const distance = Math.abs(EFFORTS.indexOf(effort) - from)
    // Ties go to the quieter level: EFFORTS is walked low to high and only a
    // strictly nearer level replaces the one already found.
    if (distance < nearest) {
      best = effort
      nearest = distance
    }
  }
  return best ?? wanted
}

/**
 * The rates a model charges once a prompt passes `over` tokens, replacing the
 * flat ones on `ModelFacts` above that size.
 *
 * Crossing the line is not a surcharge on the tokens past it: the whole
 * request is charged at the higher rate, which is how the endpoints publishing
 * these bill. So `costOf` picks one price list per request and never splits
 * one. A rate this list leaves out keeps the flat one.
 */
export interface PriceTier {
  /** Prompt tokens above which these rates apply. */
  over: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * What is known about one model: which effort levels it takes, and what it
 * charges. Every field is optional because most endpoints answer `/v1/models`
 * with an id, an owner and a timestamp and nothing else. Prices are US dollars
 * per million tokens, converted once in `readFacts`.
 */
export interface ModelFacts {
  efforts?: Effort[]
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /**
   * Higher rates for a long prompt, cheapest tier first. Most models have
   * none and are charged at one rate whatever the size. Pricing a tiered
   * model flat under-reports a long session by as much as three times.
   */
  tiers?: PriceTier[]
  /**
   * The wire this model has to be asked on, where that is not the one its
   * provider record names. A gateway fronts many upstreams and does not
   * translate between every pair of formats, so one model in a catalogue can be
   * reachable on one wire alone.
   */
  wire?: ProviderKind
  /**
   * The largest `max_tokens` the model accepts, where the endpoint publishes
   * it per model. Where nobody says, the request is built at full size and a
   * model that wants less says so in the error.
   */
  maxOutput?: number
  /**
   * Whether the model takes images alongside text. Absent means unanswered:
   * the endpoint did not publish it and the user has not typed it, which is
   * not the same as a no.
   */
  vision?: boolean
}

/** The priced halves of a model, in the order the settings screen shows them. */
export const PRICES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

export type PriceKey = (typeof PRICES)[number]

/** One model an endpoint offers, with whatever it said about it. */
export interface ModelOffer {
  id: string
  facts: ModelFacts
}

/** Which halves of a model's facts nobody has supplied. */
export type FactGap = 'efforts' | 'cost'

export function factGaps(facts: ModelFacts | undefined): FactGap[] {
  const gaps: FactGap[] = []
  if (facts?.efforts === undefined || facts.efforts.length === 0) gaps.push('efforts')
  if (facts?.input === undefined || facts.output === undefined) gaps.push('cost')
  return gaps
}

/**
 * What to believe about a model. The endpoint's answer is the base and the
 * user's typing wins field by field, so correcting a wrong price by hand does
 * not throw away an effort list the endpoint got right, and a later fetch does
 * not throw away the correction.
 */
export function resolveFacts(provider: ProviderRecord, model: string): ModelFacts {
  const reported = provider.facts?.[model] ?? {}
  const typed = provider.overrides?.[model] ?? {}
  const merged: ModelFacts = {}
  const efforts = typed.efforts ?? reported.efforts
  if (efforts !== undefined && efforts.length > 0) merged.efforts = [...efforts]
  for (const key of PRICES) {
    const value = typed[key] ?? reported[key]
    if (value !== undefined) merged[key] = value
  }
  // A price typed by hand is the price, not a base rate for something else to
  // scale. The form offers no way to edit a tier, so keeping the endpoint's
  // would double a number the user had just corrected.
  const tiers = typed.tiers ?? (typed.input === undefined && typed.output === undefined ? reported.tiers : undefined)
  if (tiers !== undefined && tiers.length > 0) merged.tiers = tiers.map(tier => ({ ...tier }))
  const maxOutput = typed.maxOutput ?? reported.maxOutput
  if (maxOutput !== undefined) merged.maxOutput = maxOutput
  const vision = typed.vision ?? reported.vision
  if (vision !== undefined) merged.vision = vision
  const wire = typed.wire ?? reported.wire
  if (wire !== undefined) merged.wire = wire
  return merged
}

/**
 * One configured endpoint. The key is absent by design: it lives in the
 * OS-encrypted store, keyed by `id`, so this record stays safe to read, copy or
 * paste into an issue (plan §16).
 */
export interface ProviderRecord {
  id: string
  /** Whatever the user calls it: a vendor's name, a gateway's, "local". */
  name: string
  kind: ProviderKind
  baseURL: string
  /**
   * The models the user ticked out of what the endpoint offers. Everything else
   * stays out of reach, so a session can only run something chosen on purpose.
   * Empty means "no list": whatever model id is selected is used as typed.
   */
  models: string[]
  /** What the last fetch learned about each model, by model id. */
  facts?: Record<string, ModelFacts>
  /** What the user typed for a model. Outranks `facts`, and survives a fetch. */
  overrides?: Record<string, ModelFacts>
  /**
   * The header this endpoint wants the session id under, where it wants one.
   * Endpoints that route or cache per conversation each named it differently
   * and most name nothing, so it is unset until someone says otherwise.
   */
  sessionHeader?: string
}

/** Which provider and model a new session starts with. */
export interface ActiveSelection {
  providerId: string
  model: string
  effort: Effort
}

/** The part of the configuration that is safe to write to disk. Never a key. */
export interface StoredConfig {
  providers: ProviderRecord[]
  active?: ActiveSelection
  /**
   * Which model auto mode asks, and any rules the user added. Safe to commit
   * for the same reason the rest of this file is: it names a provider by id and
   * the key for that id lives in the OS store.
   */
  approval?: ApprovalConfig
  /** The mode a new session starts in. `ask` when nobody has chosen. */
  permissionMode?: PermissionMode
}

/** Everything a session needs to reach a provider. */
export interface ProviderConfig {
  provider: ProviderRecord
  model: string
  effort: Effort
  apiKey: string
}

export type ConfigField = 'provider' | 'model' | 'apiKey'

const LABELS: Record<ConfigField, string> = {
  provider: 'provider',
  model: 'model',
  apiKey: 'API key',
}

export class ConfigError extends Error {
  readonly missing: readonly ConfigField[]

  constructor(missing: readonly ConfigField[], reasons: readonly string[]) {
    super(`Configuration incomplete: ${reasons.join('; ')}. Open settings and fill in the ${missing.map(f => LABELS[f]).join(', ')}.`)
    this.name = 'ConfigError'
    this.missing = missing
  }
}

export interface ConfigSources {
  stored?: StoredConfig | undefined
  /** Keys by provider id, from the OS-encrypted store. Never read in plaintext. */
  secrets?: Readonly<Record<string, string>> | undefined
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Strip trailing slashes so a joined `/v1/...` path never doubles up. */
export function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, '')
}

/** True for an absolute http(s) URL, the only thing a provider can call. */
export function isUsableBaseURL(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

export function newProviderId(): string {
  return randomUUID()
}

// A base URL that already names an API version: `.../v1`, `.../v1beta`,
// `.../api/paas/v4`. The two ecosystems disagree about who owns that segment.
// OpenAI clients take a base that ends in `/v1`, Anthropic clients take one
// without it and add `/v1` themselves, and people paste whichever their
// provider's page showed them.
const VERSIONED = /\/v\d+[a-z0-9]*$/i

/**
 * Join a base URL to an endpoint path, adding the version segment only when the
 * base does not already carry one. A base pasted as `https://host/api/paas/v4`
 * and one pasted as `https://host` therefore both reach `/chat/completions`,
 * and no URL ends up with `/v1/v1/`.
 */
export function endpointURL(baseURL: string, version: string, path: string): string {
  const base = normalizeBaseURL(baseURL)
  return VERSIONED.test(base) ? `${base}/${path}` : `${base}/${version}/${path}`
}

export function findProvider(stored: StoredConfig, id: string | undefined): ProviderRecord | undefined {
  if (id === undefined) return undefined
  return stored.providers.find(p => p.id === id)
}

/**
 * Read the saved settings and demand a usable result. The settings screen is
 * the only way in: a provider has to be configured before anything can run, so
 * there is one place to do it and no environment variable outranks it.
 */
export function resolveConfig(sources: ConfigSources = {}): ProviderConfig {
  const stored = sources.stored ?? { providers: [] }
  const secrets = sources.secrets ?? {}
  const provider = findProvider(stored, stored.active?.providerId) ?? stored.providers[0]

  const missing: ConfigField[] = []
  const reasons: string[] = []

  if (provider === undefined) {
    throw new ConfigError(['provider', 'model', 'apiKey'], ['no provider configured'])
  }
  if (!isUsableBaseURL(provider.baseURL)) {
    missing.push('provider')
    reasons.push(`base URL ${provider.baseURL} is not an absolute http(s) URL`)
  }

  const selected = stored.active?.providerId === provider.id ? text(stored.active.model) : undefined
  const model = selected ?? provider.models[0]
  if (model === undefined) {
    missing.push('model')
    reasons.push(`no model selected for ${provider.name}`)
  } else if (provider.models.length > 0 && !provider.models.includes(model)) {
    missing.push('model')
    reasons.push(`${model} is not one of the models selected for ${provider.name}`)
  }

  const apiKey = text(secrets[provider.id])
  if (apiKey === undefined) {
    missing.push('apiKey')
    reasons.push(`no API key stored for ${provider.name}`)
  }

  if (missing.length > 0 || model === undefined || apiKey === undefined) {
    throw new ConfigError(missing, reasons)
  }
  return {
    provider: { ...provider, baseURL: normalizeBaseURL(provider.baseURL) },
    model,
    effort: stored.active?.effort ?? 'medium',
    apiKey,
  }
}

/** The id a migrated single-provider install gets, so its key still matches. */
export const LEGACY_ID = 'legacy'

export function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host
  } catch {
    return baseURL
  }
}

/**
 * Read a settings file written by any earlier version. The single-provider
 * shape becomes one record, so an existing install keeps working without the
 * user retyping anything.
 */
export function parseStored(parsed: unknown): StoredConfig {
  if (typeof parsed !== 'object' || parsed === null) return { providers: [] }
  const record = parsed as Record<string, unknown>

  if (Array.isArray(record.providers)) {
    const providers = record.providers.map(parseProvider).filter((p): p is ProviderRecord => p !== null)
    const stored: StoredConfig = { providers }
    const active = parseActive(record.active, providers)
    if (active !== undefined) stored.active = active
    const approval = parseApproval(record.approval)
    if (approval !== undefined) stored.approval = approval
    if (isPermissionMode(record.permissionMode)) stored.permissionMode = record.permissionMode
    return stored
  }

  const baseURL = text(record.baseURL)
  if (baseURL === undefined) return { providers: [] }
  const models = Array.isArray(record.models) ? record.models.filter((m): m is string => typeof m === 'string') : []
  const provider: ProviderRecord = { id: LEGACY_ID, name: hostOf(baseURL), kind: 'openai', baseURL, models }
  const model = text(record.model)
  const stored: StoredConfig = { providers: [provider] }
  if (model !== undefined) stored.active = { providerId: provider.id, model, effort: 'medium' }
  return stored
}

function parseProvider(value: unknown): ProviderRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = text(record.id)
  const baseURL = text(record.baseURL)
  if (id === undefined || baseURL === undefined) return null
  const kind: ProviderKind = isProviderKind(record.kind) ? record.kind : 'openai'
  const models = Array.isArray(record.models) ? record.models.filter((m): m is string => typeof m === 'string') : []
  const provider: ProviderRecord = { id, name: text(record.name) ?? hostOf(baseURL), kind, baseURL, models }
  const facts = parseFactsMap(record.facts)
  const overrides = parseFactsMap(record.overrides)
  if (facts !== undefined) provider.facts = facts
  if (overrides !== undefined) provider.overrides = overrides
  const sessionHeader = parseHeaderName(record.sessionHeader)
  if (sessionHeader !== undefined) provider.sessionHeader = sessionHeader
  return provider
}

/**
 * A header name off disk or out of the window, or nothing. Anything `fetch`
 * would throw on is dropped before the request is built: a name is the token
 * RFC 9110 allows, and a record holding something else fails every turn with
 * an error about the wrong thing.
 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function parseHeaderName(value: unknown): string | undefined {
  const name = text(value)?.trim()
  return name !== undefined && HEADER_NAME.test(name) ? name : undefined
}

/** Read a `{ modelId: facts }` map back, dropping anything malformed. */
function parseFactsMap(value: unknown): Record<string, ModelFacts> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, ModelFacts> = {}
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    const facts = parseFacts(raw)
    if (facts !== undefined) out[model] = facts
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * One model's facts, with anything that is not a fact dropped: a negative
 * price, a level nobody has heard of, a ceiling of zero. It runs on the way in
 * from disk and on the way in from the window, because a record written to disk
 * should be one this harness can read back whatever wrote it.
 */
export function parseFacts(value: unknown): ModelFacts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const facts: ModelFacts = {}
  if (Array.isArray(record.efforts)) {
    const efforts = sortEfforts(record.efforts.filter(isEffort))
    if (efforts.length > 0) facts.efforts = efforts
  }
  for (const key of PRICES) {
    const price = record[key]
    // A negative price is not a price, and NaN through JSON.parse would read as
    // a number and then print as one.
    if (typeof price === 'number' && Number.isFinite(price) && price >= 0) facts[key] = price
  }
  const tiers = parseTiers(record.tiers)
  if (tiers !== undefined) facts.tiers = tiers
  if (isProviderKind(record.wire)) facts.wire = record.wire
  const published = record.maxOutput
  const ceiling = typeof published === 'number' && Number.isFinite(published) ? Math.floor(published) : 0
  if (ceiling > 0) facts.maxOutput = ceiling
  // A stored `false` is an answer and is kept. Anything that is not a boolean
  // is dropped, so a truthy string cannot read as a yes.
  if (typeof record.vision === 'boolean') facts.vision = record.vision
  return Object.keys(facts).length === 0 ? undefined : facts
}

/**
 * The higher rates a long prompt is charged at, cheapest first. A tier with no
 * threshold to cross, or no rate to charge, is not a tier and is dropped: it
 * would otherwise read as a free tier over every prompt.
 */
function parseTiers(value: unknown): PriceTier[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tiers: PriceTier[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const over = record.over
    if (typeof over !== 'number' || !Number.isFinite(over) || over <= 0) continue
    const tier: PriceTier = { over: Math.floor(over) }
    for (const key of PRICES) {
      const price = record[key]
      if (typeof price === 'number' && Number.isFinite(price) && price >= 0) tier[key] = price
    }
    if (Object.keys(tier).length > 1) tiers.push(tier)
  }
  return tiers.length === 0 ? undefined : tiers.sort((a, b) => a.over - b.over)
}

/**
 * Read auto mode's configuration back, dropping anything malformed. A
 * candidate naming a provider that is gone is kept: it may be re-added under
 * the same id, and `approvalProblem` reports the gap in words.
 */
export function parseApproval(value: unknown): ApprovalConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const candidates: ApprovalCandidate[] = []
  if (Array.isArray(record.candidates)) {
    for (const raw of record.candidates) {
      if (typeof raw !== 'object' || raw === null) continue
      const { providerId, model } = raw as Record<string, unknown>
      const id = text(providerId)
      const name = text(model)
      if (id === undefined || name === undefined) continue
      candidates.push({ providerId: id, model: name })
    }
  }
  const config: ApprovalConfig = { candidates }
  if (isEffort(record.effort)) config.effort = record.effort
  const rules = parseRules(record.rules)
  if (rules !== undefined) config.rules = rules
  return config
}

/**
 * The user's own rules. Every bucket is optional and an absent one is empty,
 * never a reason to discard the rest: a settings file with one bad section
 * should lose that section, not the never-allow list next to it.
 */
function parseRules(value: unknown): ApprovalRules | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const rules: ApprovalRules = { hardDeny: [], softDeny: [], allow: [], environment: [] }
  let any = false
  for (const key of ['hardDeny', 'softDeny', 'allow', 'environment'] as const) {
    const list = record[key]
    if (!Array.isArray(list)) continue
    const lines = list.map(text).filter((line): line is string => line !== undefined)
    if (lines.length > 0) any = true
    rules[key] = lines
  }
  return any ? rules : undefined
}

function parseActive(value: unknown, providers: readonly ProviderRecord[]): ActiveSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const providerId = text(record.providerId)
  const model = text(record.model)
  if (providerId === undefined || model === undefined) return undefined
  if (!providers.some(p => p.id === providerId)) return undefined
  return { providerId, model, effort: isEffort(record.effort) ? record.effort : 'medium' }
}
