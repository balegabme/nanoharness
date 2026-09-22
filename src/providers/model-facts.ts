// doc: docs/harness/providers.md
import { isEffort, sortEfforts } from '../core/config.js'
import type { Effort, ModelFacts, ModelOffer } from '../core/config.js'

/**
 * The `data` array of a `/models` answer, turned into one offer per model. Every
 * endpoint puts an id on each entry and disagrees about everything else, so both
 * wires share this and `readFacts` sorts out the rest.
 */
export function readOffers(data: readonly unknown[]): ModelOffer[] {
  const byId = new Map<string, ModelOffer>()
  for (const entry of data) {
    const record = object(entry)
    if (record === undefined) continue
    const id = record.id
    if (typeof id !== 'string' || id.trim() === '') continue
    if (!byId.has(id)) byId.set(id, { id, facts: readFacts(record) })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * What an endpoint said about one model, read out of its `/models` entry.
 *
 * There is no standard for this. The two documented answers carry an id, an
 * owner, a timestamp and sometimes a display name, and nothing about price or
 * thinking. Servers that do answer those questions each picked their own field
 * names, so every spelling anyone has been seen to use is read here, and a
 * server that uses none of them leaves a model with no facts at all. That is
 * what puts the warning mark on it in settings and hands the question to the
 * user.
 *
 * Prices go in as dollars per token on every wire that carries them and come
 * out as dollars per million, because that is the unit vendors publish and the
 * one the settings screen shows.
 */
export function readFacts(entry: Record<string, unknown>): ModelFacts {
  const facts: ModelFacts = {}
  const efforts = readEfforts(entry)
  if (efforts.length > 0) facts.efforts = efforts

  const published = entry.max_tokens
  const ceiling = typeof published === 'number' && Number.isFinite(published) ? Math.floor(published) : 0
  if (ceiling > 0) facts.maxOutput = ceiling

  const input = firstPrice(entry, ['prompt', 'input'], ['input_cost_per_token', 'prompt_cost_per_token'])
  const output = firstPrice(entry, ['completion', 'output'], ['output_cost_per_token', 'completion_cost_per_token'])
  const cacheRead = firstPrice(entry, ['input_cache_read', 'cache_read'], ['cache_read_input_token_cost'])
  const cacheWrite = firstPrice(entry, ['input_cache_write', 'cache_write'], ['cache_creation_input_token_cost'])
  if (input !== undefined) facts.input = input
  if (output !== undefined) facts.output = output
  if (cacheRead !== undefined) facts.cacheRead = cacheRead
  if (cacheWrite !== undefined) facts.cacheWrite = cacheWrite

  const vision = readVision(entry)
  if (vision !== undefined) facts.vision = vision
  return facts
}

/**
 * Whether the model takes images, in the spellings endpoints have been seen to
 * use: a list of input modalities, a capabilities block or array, and the flag
 * gateways set beside their prices.
 *
 * A `false` is an answer and is kept as one. An endpoint that names none of
 * these has said nothing, so undefined reaches the settings screen as a
 * question and not as a no.
 */
function readVision(entry: Record<string, unknown>): boolean | undefined {
  const architecture = object(entry.architecture)
  const modalities = architecture?.input_modalities ?? entry.input_modalities
  if (Array.isArray(modalities)) return modalities.some(one => one === 'image')
  // `text+image->text`, the older spelling of the same list.
  const modality = architecture?.modality
  if (typeof modality === 'string') return modality.split('->')[0]?.split('+').includes('image') === true

  const capabilities = entry.capabilities
  if (Array.isArray(capabilities)) return capabilities.some(one => one === 'vision')
  const declared = object(capabilities)?.vision
  if (typeof declared === 'boolean') return declared
  const supported = object(declared)?.supported
  if (typeof supported === 'boolean') return supported

  const flag = entry.supports_vision ?? object(entry.model_info)?.supports_vision
  return typeof flag === 'boolean' ? flag : undefined
}

const PER_MILLION = 1_000_000

/**
 * Where an effort list can be. A `capabilities` block is read first, because
 * it is the only spelling that states the levels outright; every other one
 * leaves them to be inferred. After that come `metadata.reasoning` and the
 * top-level names other servers use for the same list.
 *
 * A field that only says whether a model takes reasoning at all is skipped, as
 * `supported_parameters` is: turning "takes reasoning" into a list of seven
 * levels would be inventing the answer.
 */
function readEfforts(entry: Record<string, unknown>): Effort[] {
  const declared = readCapabilities(entry)
  if (declared !== undefined) return declared
  const reasoning = object(object(entry.metadata)?.reasoning)
  const lists = [
    reasoning?.supported_efforts,
    entry.supported_reasoning_efforts,
    entry.supported_efforts,
    object(entry.reasoning)?.supported_efforts,
  ]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    const efforts = sortEfforts(list.filter(isEffort))
    if (efforts.length > 0) return efforts
  }
  return []
}

/**
 * The first price any of these fields carries, in dollars per million tokens.
 * `nested` names are looked for inside a `pricing` block, where the numbers can
 * arrive as strings; `flat` names are looked for at the top level and inside
 * `model_info`.
 */
function firstPrice(entry: Record<string, unknown>, nested: readonly string[], flat: readonly string[]): number | undefined {
  const pricing = object(entry.pricing)
  const info = object(entry.model_info)
  for (const key of nested) {
    const value = price(pricing?.[key])
    if (value !== undefined) return value * PER_MILLION
  }
  for (const key of flat) {
    const value = price(entry[key]) ?? price(info?.[key])
    if (value !== undefined) return value * PER_MILLION
  }
  return undefined
}

/**
 * A `capabilities` block, which names the effort levels a model takes:
 * `capabilities.effort.<level>.supported`, alongside `thinking.supported` for
 * whether it thinks at all.
 *
 * `none` is added to whatever it names, because that level is the thinking
 * block left out of the request and no model needs permission for that.
 * `minimal` is not added: it is a small fixed budget that an endpoint will
 * take without listing, so the user puts it back by hand and nothing here
 * invents it.
 *
 * A model that says it does not think takes `none` and nothing else. A model
 * with no `effort` block and no `thinking: false` has said nothing, so it comes
 * back undefined and the other shapes below get their turn.
 */
function readCapabilities(entry: Record<string, unknown>): Effort[] | undefined {
  const capabilities = object(entry.capabilities)
  if (capabilities === undefined) return undefined
  if (object(capabilities.thinking)?.supported === false) return ['none']
  const effort = object(capabilities.effort)
  if (effort === undefined || effort.supported === false) return undefined
  const named = Object.entries(effort)
    .filter(([name, value]) => isEffort(name) && object(value)?.supported === true)
    .map(([name]) => name)
    .filter(isEffort)
  // These arrive in whatever order the endpoint wrote them, often alphabetical,
  // so the scale is put back in order here, and the picker never gets
  // `high, low, max, medium`.
  return named.length === 0 ? undefined : sortEfforts(['none', ...named])
}

/**
 * A price off the wire. Some endpoints send `"0.0000003"` and some send the
 * number, and a free model sends zero, which is a real answer and must not read
 * as a missing one.
 */
function price(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
