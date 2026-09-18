// doc: docs/harness/providers.md
import type { ModelFacts } from './config.js'
import type { TurnUsage } from './types.js'

/**
 * What a turn's tokens came to in US dollars, or null when nobody has priced
 * the model. `ModelFacts` quotes per million tokens, so the division happens
 * here and the caller deals in dollars.
 *
 * Reasoning tokens are left out of the sum. Every provider that reports them
 * counts them inside `output` as well, so adding them again would roughly
 * double the bill of a thinking model. A cache read or write is charged at its
 * own rate where the model publishes one and at the input rate where it does
 * not, which is what a provider quoting a single input price is saying.
 */
export function costOf(usage: TurnUsage, facts: ModelFacts): number | null {
  if (facts.input === undefined || facts.output === undefined) return null
  const read = facts.cacheRead ?? facts.input
  const write = facts.cacheWrite ?? facts.input
  const total = usage.input * facts.input + usage.output * facts.output + usage.cacheRead * read + usage.cacheWrite * write
  return total / 1_000_000
}

/**
 * A dollar figure short enough to sit in a pill. A turn that cost a fraction of
 * a cent still says so rather than rounding to zero, because zero reads as free
 * and a thousand of those turns is not.
 */
export function moneyText(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
