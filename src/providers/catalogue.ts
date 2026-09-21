// doc: docs/harness/providers.md
import { isEffort, sortEfforts } from '../core/config.js'
import type { Effort, ModelFacts, ModelOffer, PriceTier, ProviderKind } from '../core/config.js'
import { USER_AGENT } from './headers.js'

/**
 * What an endpoint does not say about its own models, read from the public
 * catalogue at `models.dev`: prices, effort levels, output ceilings, whether a
 * model reads images, and the wire it answers on. Entries are keyed by the same
 * base URL the user pastes into settings.
 *
 * Fetched when the model list is asked for and kept nowhere. The request
 * carries no key, no address and no model id. `providers.md` has why it is read
 * live rather than written down here.
 */

const CATALOGUE_URL = 'https://models.dev/api.json'

/** How an entry names the SDK a model is reached with, and what that is in wires. */
const WIRES: Readonly<Record<string, ProviderKind>> = {
  '@ai-sdk/openai': 'responses',
  '@ai-sdk/openai-compatible': 'openai',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google-vertex/anthropic': 'anthropic',
}

interface CatalogueCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tiers?: { input?: number; output?: number; cache_read?: number; cache_write?: number; tier?: { size?: number } }[]
}

interface CatalogueModel {
  cost?: CatalogueCost
  limit?: { output?: number }
  modalities?: { input?: string[] }
  reasoning_options?: { type?: string; values?: (string | null)[] }[]
  provider?: { npm?: string }
}

interface CatalogueProvider {
  api?: string
  npm?: string
  models?: Record<string, CatalogueModel>
}

/** Everything the catalogue has on the models at one address, by id. */
export async function catalogueFor(baseURL: string, timeoutMs = 15_000): Promise<Record<string, ModelFacts>> {
  const res = await fetch(CATALOGUE_URL, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`the model catalogue answered ${res.status}`)
  return readCatalogue(await res.json(), baseURL)
}

/** The same reading, over a catalogue already in hand. */
export function readCatalogue(body: unknown, baseURL: string): Record<string, ModelFacts> {
  const address = addressOf(baseURL)
  if (address === undefined || !isObject(body)) return {}
  // Longest match wins. One host can front several endpoints that differ only
  // by path, and `https://opencode.ai/zen/v1` is a prefix of nothing under
  // `/zen/go/v1`, so the deeper address is the one that answers for itself.
  let best: CatalogueProvider | undefined
  let reach = 0
  for (const entry of Object.values(body)) {
    if (!isObject(entry)) continue
    const provider = entry as CatalogueProvider
    const listed = addressOf(provider.api ?? '')
    if (listed === undefined || !address.startsWith(listed) || listed.length <= reach) continue
    best = provider
    reach = listed.length
  }
  return best === undefined ? {} : readModels(best)
}

function readModels(provider: CatalogueProvider): Record<string, ModelFacts> {
  const facts: Record<string, ModelFacts> = {}
  for (const [id, model] of Object.entries(provider.models ?? {})) {
    const read = readModel(model, provider.npm)
    if (Object.keys(read).length > 0) facts[id] = read
  }
  return facts
}

function readModel(model: CatalogueModel, providerNpm: string | undefined): ModelFacts {
  const facts: ModelFacts = {}
  const cost = model.cost
  if (typeof cost?.input === 'number') facts.input = cost.input
  if (typeof cost?.output === 'number') facts.output = cost.output
  if (typeof cost?.cache_read === 'number') facts.cacheRead = cost.cache_read
  if (typeof cost?.cache_write === 'number') facts.cacheWrite = cost.cache_write
  const tiers = readTiers(cost?.tiers)
  if (tiers.length > 0) facts.tiers = tiers
  if (typeof model.limit?.output === 'number' && model.limit.output > 0) facts.maxOutput = Math.floor(model.limit.output)
  if (model.modalities?.input?.includes('image') === true) facts.vision = true
  const efforts = readEfforts(model.reasoning_options)
  if (efforts.length > 0) facts.efforts = efforts
  // A model reached with a different SDK than the rest of its provider is
  // reached on a different wire. The entry names the SDK; the table above says
  // which wire that is, and a name nobody has mapped leaves the record's wire
  // standing.
  const wire = WIRES[model.provider?.npm ?? providerNpm ?? '']
  if (wire !== undefined) facts.wire = wire
  return facts
}

function readTiers(tiers: CatalogueCost['tiers']): PriceTier[] {
  const read: PriceTier[] = []
  for (const tier of tiers ?? []) {
    const over = tier.tier?.size
    if (typeof over !== 'number' || over <= 0) continue
    const priced: PriceTier = { over }
    if (typeof tier.input === 'number') priced.input = tier.input
    if (typeof tier.output === 'number') priced.output = tier.output
    if (typeof tier.cache_read === 'number') priced.cacheRead = tier.cache_read
    if (typeof tier.cache_write === 'number') priced.cacheWrite = tier.cache_write
    if (Object.keys(priced).length > 1) read.push(priced)
  }
  return read.sort((a, b) => a.over - b.over)
}

/**
 * The effort levels a model takes, from the catalogue's named ones alone. It
 * also describes thinking as a toggle and as a token budget, neither of which
 * is a level this harness has a control for.
 */
function readEfforts(options: CatalogueModel['reasoning_options']): Effort[] {
  const levels = new Set<Effort>()
  for (const option of options ?? []) {
    if (option.type !== 'effort') continue
    for (const value of option.values ?? []) if (isEffort(value)) levels.add(value)
  }
  return sortEfforts([...levels])
}

/**
 * Fill in what an endpoint did not say about its own models. Reach comes from
 * the endpoint and description from the catalogue: a model the endpoint offers
 * is offered whether the catalogue has heard of it or not, a model only the
 * catalogue knows about is not conjured into the list, and anything the
 * endpoint stated is left as it stated it.
 */
export function describe(offers: readonly ModelOffer[], catalogue: Record<string, ModelFacts>): ModelOffer[] {
  return offers.map(offer => {
    const filled = catalogue[offer.id]
    return filled === undefined ? offer : { id: offer.id, facts: { ...filled, ...offer.facts } }
  })
}

/** Host and path together, since a catalogue entry is an endpoint and not a site. */
function addressOf(baseURL: string): string | undefined {
  try {
    const url = new URL(baseURL)
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
