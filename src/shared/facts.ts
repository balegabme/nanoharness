// doc: docs/harness/shared.md
import { promptTokens } from './usage.js'
import type { Effort, FactGap, ModelFacts, PriceKey, PriceTier, ProviderKind } from '../core/config.js'
import type { TurnUsage } from '../core/types.js'

/**
 * What the harness knows about a model, and the arithmetic done on it: which
 * wire and effort levels are real, which facts are missing, what a run of
 * tokens cost. The main process uses these to build a request and bill it, and
 * the window uses the same functions to fill the pickers and price the pills.
 * The types live in `core/config.ts` with the rest of the stored config.
 */

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'responses']

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)
}

/** The effort scale, low to high. */
export const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

/**
 * A list of levels in the order the scale runs, low to high. Endpoints answer
 * in whatever order they please, some of them alphabetical, and this list is
 * what orders the picker in the composer.
 */
export function sortEfforts(efforts: readonly Effort[]): Effort[] {
  return EFFORTS.filter(effort => efforts.includes(effort))
}

/**
 * The nearest level a model actually takes, when the one in hand is not one.
 * A level the provider does not know is a 400 mid-turn, so nothing sends an
 * unclamped one.
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

/** The priced halves of a model, in the order the settings screen shows them. */
export const PRICES: readonly PriceKey[] = ['input', 'output', 'cacheRead', 'cacheWrite']

export function factGaps(facts: ModelFacts | undefined): FactGap[] {
  const gaps: FactGap[] = []
  if (facts?.efforts === undefined || facts.efforts.length === 0) gaps.push('efforts')
  if (facts?.input === undefined || facts.output === undefined) gaps.push('cost')
  return gaps
}

/**
 * The two maps a model's facts come out of: what the endpoint reported, and
 * what the user typed. A saved provider has both, and so does the settings
 * form while it is being edited.
 */
export interface FactSources {
  facts?: Record<string, ModelFacts> | undefined
  overrides?: Record<string, ModelFacts> | undefined
}

/**
 * What to believe about a model. The endpoint's answer is the base and the
 * user's typing wins field by field, so correcting a wrong price by hand does
 * not throw away an effort list the endpoint got right, and a later fetch does
 * not throw away the correction.
 */
export function resolveFacts(provider: FactSources | undefined, model: string): ModelFacts {
  const reported = provider?.facts?.[model] ?? {}
  const typed = provider?.overrides?.[model] ?? {}
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
  const context = typed.context ?? reported.context
  if (context !== undefined) merged.context = context
  const vision = typed.vision ?? reported.vision
  if (vision !== undefined) merged.vision = vision
  const wire = typed.wire ?? reported.wire
  if (wire !== undefined) merged.wire = wire
  return merged
}

/** The highest tier this prompt reaches, or undefined when it reaches none. */
function tierFor(facts: ModelFacts, prompt: number): PriceTier | undefined {
  let best: PriceTier | undefined
  for (const tier of facts.tiers ?? []) {
    if (prompt > tier.over && (best === undefined || tier.over > best.over)) best = tier
  }
  return best
}

/**
 * What a run of tokens came to in US dollars, or null when nobody has priced
 * the model. `ModelFacts` quotes per million tokens, so the division happens
 * here and the caller deals in dollars.
 *
 * Reasoning tokens are left out of the sum. Every provider that reports them
 * counts them inside `output` as well, so adding them again would roughly
 * double the bill of a thinking model. A cache read or write is charged at its
 * own rate where the model publishes one, and at the input rate where it does
 * not, which is what a provider quoting a single input price is saying.
 */
export function costOf(usage: TurnUsage, facts: ModelFacts): number | null {
  if (facts.input === undefined || facts.output === undefined) return null
  // Everything the model was asked to read counts towards the tier, cached or
  // not: the endpoint sizes the whole request, and a cache hit is still context.
  const tier = tierFor(facts, promptTokens(usage))
  const input = tier?.input ?? facts.input
  const output = tier?.output ?? facts.output
  const read = tier?.cacheRead ?? facts.cacheRead ?? input
  const write = tier?.cacheWrite ?? facts.cacheWrite ?? input
  const total = usage.input * input + usage.output * output + usage.cacheRead * read + usage.cacheWrite * write
  return total / 1_000_000
}
