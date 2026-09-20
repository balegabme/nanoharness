// doc: docs/harness/ui.md
import type { Effort, FactGap, ModelFacts, PriceKey } from '../core/config.js'
import type { TurnUsage } from '../core/types.js'
import type { ProviderView } from '../ipc/contract.js'

/** A saved provider, or the two maps the settings form is holding for one. */
type Described = Pick<ProviderView, 'facts' | 'overrides'>

/**
 * What the window knows about a model: which effort levels it takes and what it
 * charges, plus the wording for both.
 *
 * `EFFORTS`, `PRICES`, `resolveFacts`, `factGaps`, `clampEffort`, `costOf` and
 * `moneyText` are copies. src/core/config.ts and src/core/cost.ts hold the definitions, and the
 * main process uses those, but eslint.config.js forbids the renderer a runtime
 * import from core because the renderer is a separate bundle. Change one and
 * change the other; src/providers/model-facts.test.ts fails when they drift.
 */
export const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const PRICES: readonly PriceKey[] = ['input', 'output', 'cacheRead', 'cacheWrite']

/** What each priced half is called on the row where it is typed. */
export const PRICE_LABEL: Record<PriceKey, string> = {
  input: 'in',
  output: 'out',
  cacheRead: 'cached in',
  cacheWrite: 'cache write',
}

export function resolveFacts(provider: Described | undefined, model: string): ModelFacts {
  const reported = provider?.facts?.[model] ?? {}
  const typed = provider?.overrides?.[model] ?? {}
  const merged: ModelFacts = {}
  const efforts = typed.efforts ?? reported.efforts
  if (efforts !== undefined && efforts.length > 0) merged.efforts = [...efforts]
  for (const key of PRICES) {
    const value = typed[key] ?? reported[key]
    if (value !== undefined) merged[key] = value
  }
  const maxOutput = typed.maxOutput ?? reported.maxOutput
  if (maxOutput !== undefined) merged.maxOutput = maxOutput
  const vision = typed.vision ?? reported.vision
  if (vision !== undefined) merged.vision = vision
  return merged
}

export function factGaps(facts: ModelFacts | undefined): FactGap[] {
  const gaps: FactGap[] = []
  if (facts?.efforts === undefined || facts.efforts.length === 0) gaps.push('efforts')
  if (facts?.input === undefined || facts.output === undefined) gaps.push('cost')
  return gaps
}

/** The nearest level a model actually takes, when the one in hand is not one. */
export function clampEffort(offered: readonly Effort[], wanted: Effort): Effort {
  if (offered.includes(wanted)) return wanted
  const from = EFFORTS.indexOf(wanted)
  let best: Effort | undefined
  let nearest = Number.POSITIVE_INFINITY
  // The nearest level on the scale, so leaving a model for one with no `max`
  // lands on `high` rather than back at `none`. Walking only downwards would
  // strand `minimal` at the bottom on a model whose lowest level is `low`.
  for (const effort of EFFORTS) {
    if (!offered.includes(effort)) continue
    const distance = Math.abs(EFFORTS.indexOf(effort) - from)
    // Ties go to the quieter level, since EFFORTS is walked low to high and the
    // cheaper of two equally close levels is the safer thing to pick for
    // somebody who did not choose it.
    if (distance < nearest) {
      best = effort
      nearest = distance
    }
  }
  return best ?? wanted
}

/** What the effort chip calls each level. */
export const EFFORT_LABEL: Record<Effort, string> = {
  none: 'no thinking',
  minimal: 'minimal effort',
  low: 'low effort',
  medium: 'medium effort',
  high: 'high effort',
  xhigh: 'extra-high effort',
  max: 'max effort',
}

/**
 * The warning mark on a model nobody has described, and what it means. Most
 * endpoints answer `/v1/models` with an id and nothing else, so an unmarked
 * model is the exception rather than the rule and the mark has to say what to
 * do about it.
 */
export const WARN = '⚠'

export function gapText(gaps: readonly FactGap[]): string {
  if (gaps.length === 0) return ''
  const what = gaps.length === 2 ? 'effort levels or prices' : gaps[0] === 'efforts' ? 'which effort levels it takes' : 'its prices'
  return `${WARN} This endpoint did not say ${what}. Fill it in below, or leave it and every level stays on offer.`
}

/** A price as vendors quote it. Free is a real answer and says so. */
export function priceText(facts: ModelFacts): string {
  if (facts.input === undefined || facts.output === undefined) return ''
  if (facts.input === 0 && facts.output === 0) return 'free'
  return `$${money(facts.input)} in / $${money(facts.output)} out per Mtok`
}

function money(usd: number): string {
  if (usd === 0) return '0'
  const places = usd < 0.01 ? 4 : usd < 1 ? 3 : 2
  return usd.toFixed(places).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

/** What a run of tokens came to on this model, or null when it has no prices. */
export function costOf(usage: TurnUsage, facts: ModelFacts): number | null {
  if (facts.input === undefined || facts.output === undefined) return null
  const read = facts.cacheRead ?? facts.input
  const write = facts.cacheWrite ?? facts.input
  const total = usage.input * facts.input + usage.output * facts.output + usage.cacheRead * read + usage.cacheWrite * write
  return total / 1_000_000
}

export function moneyText(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
