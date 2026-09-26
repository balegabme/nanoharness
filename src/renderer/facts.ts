// doc: docs/harness/ui.md
import type { Effort, FactGap, ModelFacts, PriceKey } from '../core/config.js'

/**
 * What the window says about a model's facts: the labels on the effort chip and
 * the price fields, and the warning on a model nobody has described. The facts
 * themselves and the arithmetic on them are in `shared/facts.ts`.
 */

/** What each priced half is called on the row where it is typed. */
export const PRICE_LABEL: Record<PriceKey, string> = {
  input: 'in',
  output: 'out',
  cacheRead: 'cached in',
  cacheWrite: 'cache write',
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
 * model is the exception, not the rule, and the mark has to say what to do
 * about it.
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
