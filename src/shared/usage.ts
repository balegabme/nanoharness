// doc: docs/harness/shared.md
import type { TurnUsage } from '../core/types.js'

/**
 * Token counts as the harness adds them up. The session keeps its running
 * totals with these, the usage report groups the log with them, and the window
 * and `nh usage` divide the same numbers, so a cache hit rate reads the same
 * wherever it is shown.
 */

/** Characters per token, the estimate used wherever no provider has counted: the context meter and a snippet's size in the composer. */
const CHARS_PER_TOKEN = 4

/** Characters as tokens, by that estimate. */
export function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function emptyUsage(): TurnUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** Add one usage report into a running total, in place. */
export function addUsage(target: TurnUsage, delta: TurnUsage): void {
  target.input += delta.input
  target.output += delta.output
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
  target.reasoning += delta.reasoning
}

/**
 * `total` with the named shares taken out, field by field. A field can go
 * negative when a share arrives ahead of the total it belongs to; `floorUsage`
 * is for the places that draw the result.
 */
export function subtractUsage(total: TurnUsage, ...shares: readonly TurnUsage[]): TurnUsage {
  const left = { ...total }
  for (const share of shares) {
    left.input -= share.input
    left.output -= share.output
    left.cacheRead -= share.cacheRead
    left.cacheWrite -= share.cacheWrite
    left.reasoning -= share.reasoning
  }
  return left
}

/** Every field clamped at zero. */
export function floorUsage(usage: TurnUsage): TurnUsage {
  return {
    input: Math.max(0, usage.input),
    output: Math.max(0, usage.output),
    cacheRead: Math.max(0, usage.cacheRead),
    cacheWrite: Math.max(0, usage.cacheWrite),
    reasoning: Math.max(0, usage.reasoning),
  }
}

/**
 * Everything the provider charged for reading a prompt: what it read in full,
 * what it served from cache, and what it wrote to cache.
 */
export function promptTokens(usage: TurnUsage): number {
  return usage.cacheRead + usage.input + usage.cacheWrite
}

/** Everything billed, read and written, as one count. */
export function totalTokens(usage: TurnUsage): number {
  return promptTokens(usage) + usage.output
}

/**
 * Cached input over all the input that went into the prompt. Cache writes count
 * in the denominator because the provider read them in full and charged a
 * premium: a turn that read 20k cached and wrote 5k new is four fifths cache,
 * not 99.9%. `null` is "no prompt yet", which is not the same as a 0% hit.
 */
export function cacheHitRate(usage: TurnUsage): number | null {
  const prompt = promptTokens(usage)
  return prompt === 0 ? null : usage.cacheRead / prompt
}

/** Output tokens per second over the time the model spent generating, or null for no time. */
export function tokensPerSecond(output: number, streamMs: number): number | null {
  return streamMs <= 0 ? null : output / (streamMs / 1000)
}
