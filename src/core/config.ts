// doc: docs/harness/providers.md

/** Everything a session needs to reach a provider. All three are required. */
export interface ProviderConfig {
  baseURL: string
  model: string
  apiKey: string
}

/**
 * The part of the configuration that is safe to write to disk. There is no
 * `apiKey` field on purpose — secret-free by schema (plan §16), so the file
 * can be read, copied or diffed without leaking anything.
 */
export interface StoredConfig {
  baseURL?: string
  model?: string
  /**
   * The models the user picked out of the provider's list. Everything else the
   * server offers stays out of reach, so a session can only ever run a model
   * that was chosen on purpose. Empty means "no list; whatever `model` says".
   */
  models?: string[]
}

export type ConfigField = 'baseURL' | 'model' | 'apiKey'

const LABELS: Record<ConfigField, string> = {
  baseURL: 'base URL',
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
  /** The key, from the OS-encrypted store. Never read from a file in plaintext. */
  secret?: string | undefined
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Strip trailing slashes so `${baseURL}/v1/...` never doubles up. */
export function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/, '')
}

/** True for an absolute http(s) URL — the only thing the provider can call. */
export function isUsableBaseURL(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * Read the saved settings and demand a complete result. The settings screen is
 * the only way in: a provider has to be configured before anything can run, so
 * there is one place to do it rather than a screen and a set of environment
 * variables that quietly outrank it.
 */
export function resolveConfig(sources: ConfigSources = {}): ProviderConfig {
  const baseURL = text(sources.stored?.baseURL)
  const model = text(sources.stored?.model)
  const apiKey = text(sources.secret)

  const missing: ConfigField[] = []
  const reasons: string[] = []

  if (baseURL === undefined) {
    missing.push('baseURL')
    reasons.push('no provider base URL')
  } else if (!isUsableBaseURL(baseURL)) {
    missing.push('baseURL')
    reasons.push(`base URL ${baseURL} is not an absolute http(s) URL`)
  }
  if (model === undefined) {
    missing.push('model')
    reasons.push('no model')
  }
  if (apiKey === undefined) {
    missing.push('apiKey')
    reasons.push('no API key')
  }

  if (missing.length > 0 || baseURL === undefined || model === undefined || apiKey === undefined) {
    throw new ConfigError(missing, reasons)
  }
  return { baseURL: normalizeBaseURL(baseURL), model, apiKey }
}
