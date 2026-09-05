// doc: docs/harness/providers.md
import { randomUUID } from 'node:crypto'

/** The two wire formats NanoHarness speaks. */
export type ProviderKind = 'openai' | 'anthropic'

/**
 * How hard the model should think. One neutral scale across vendors: OpenAI
 * gets `reasoning_effort`, Anthropic gets a thinking budget, and a model that
 * supports neither ignores it (plan §11).
 */
export type Effort = 'none' | 'low' | 'medium' | 'high'

export const EFFORTS: readonly Effort[] = ['none', 'low', 'medium', 'high']

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

/**
 * One configured endpoint. The key is not here on purpose — it lives in the
 * OS-encrypted store, keyed by `id`, so this record stays safe to read, copy or
 * paste into an issue (plan §16).
 */
export interface ProviderRecord {
  id: string
  /** What the user calls it: "z.ai", "opencode", "local vLLM". */
  name: string
  kind: ProviderKind
  baseURL: string
  /**
   * The models the user ticked out of what the endpoint offers. Everything else
   * stays out of reach, so a session can only run something chosen on purpose.
   * Empty means "no list" — whatever model id is selected is used as typed.
   */
  models: string[]
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

/** True for an absolute http(s) URL — the only thing a provider can call. */
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
// `.../api/paas/v4`. The two ecosystems disagree about who owns that segment -
// OpenAI clients take a base that ends in `/v1`, Anthropic clients take one
// without it and add `/v1` themselves - and people paste whichever their
// provider's page showed them.
const VERSIONED = /\/v\d+[a-z0-9]*$/i

/**
 * Join a base URL to an endpoint path, adding the version segment only when the
 * base does not already carry one. `https://api.z.ai/api/paas/v4` and
 * `https://api.deepseek.com` therefore both reach `/chat/completions`, and no
 * URL ends up with `/v1/v1/`.
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
 * there is one place to do it rather than a screen and a set of environment
 * variables that quietly outrank it.
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
  const kind: ProviderKind = record.kind === 'anthropic' ? 'anthropic' : 'openai'
  const models = Array.isArray(record.models) ? record.models.filter((m): m is string => typeof m === 'string') : []
  return { id, name: text(record.name) ?? hostOf(baseURL), kind, baseURL, models }
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
