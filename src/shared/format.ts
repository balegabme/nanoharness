// doc: docs/harness/shared.md
import type { ToolStats } from '../core/types.js'

/**
 * Numbers as the harness writes them for a person to read: token counts,
 * rates, dollars. The window, `nh usage` and the notes the session leaves in a
 * transcript all use these, so the same count is spelled the same way in each.
 */

/** A full count with thousands separators: 12,345. */
export function countText(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/**
 * A token count short enough for a button: 950, 1.2k, 152k, 1.2M. One decimal
 * below ten of a unit, where it still says something, and none above it.
 */
export function shortTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens))
  if (n < 1000) return String(n)
  const [size, unit] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'M']
  // 999,950 rounds to 1000k, which is a million written the long way.
  if (unit === 'k' && size >= 999.5) return '1M'
  return `${size < 10 ? size.toFixed(1).replace(/\.0$/, '') : Math.round(size)}${unit}`
}

/** A count with its noun, which takes an s unless the count is one: 1 file, 3 files. */
export function plural(count: number, word: string, many = `${word}s`): string {
  return `${countText(count)} ${count === 1 ? word : many}`
}

/** A share as a whole percentage, or `n/a` for a share of nothing. */
export function percentText(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`
}

/** Tokens per second: one decimal below ten, where the decimal still says something. */
export function rateText(perSecond: number): string {
  return perSecond.toFixed(perSecond < 10 ? 1 : 0)
}

/**
 * A dollar figure short enough to sit in a pill. A turn that cost a fraction
 * of a cent still says so instead of rounding to zero, since zero reads as
 * free and a thousand of those turns is not.
 */
export function moneyText(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/**
 * What a subagent did to reach its answer: how many calls it made, how many
 * worked, how many came back an error. `docs/harness/agents.md` says why an
 * answer alone is not enough to go on. The model reads this line in the
 * `spawn` result and the window shows it on the job.
 */
export function toolsText(tools: ToolStats): string {
  if (tools.calls === 0) return 'no tool calls'
  const stopped = tools.prevented === 0 ? '' : `, ${tools.prevented} prevented`
  return `${plural(tools.calls, 'tool call')}, ${tools.ok} ok, ${tools.failed} failed${stopped}`
}

/** The lines of the usage log a report had to leave out. */
export function skippedText(skipped: number): string {
  return `${plural(skipped, 'line')} in the usage log this build cannot read: another schema version, or damaged`
}
