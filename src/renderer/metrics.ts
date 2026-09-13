// doc: docs/harness/ui.md
import type { TurnUsage } from '../core/types.js'

/**
 * The two numbers in the corner of the window, kept in one place where they can
 * be tested.
 *
 * The cache hit rate lives here rather than in `chat.ts` for a second reason:
 * it is a copy. `cacheHitRate` in src/core/types.ts is the definition, and the
 * CLI and the main process use that one, but eslint.config.js forbids the
 * renderer a runtime import from core because the renderer is a separate
 * bundle. The formula exists twice on purpose, and the two copies are pinned
 * against each other in src/providers/usage.test.ts.
 */

/**
 * Everything the provider charged for reading a prompt: what it read in full,
 * what it served from cache, and what it wrote to cache. The pills show all
 * three, so the percentage can be checked against the numbers beside it.
 */
export function promptTokens(usage: TurnUsage): number {
  return usage.cacheRead + usage.input + usage.cacheWrite
}

/** The cached share of the prompt, or `null` when nothing was sent. */
export function hitRate(usage: TurnUsage): number | null {
  const prompt = promptTokens(usage)
  return prompt === 0 ? null : usage.cacheRead / prompt
}

/** The same, as the pill says it. */
export function hitText(usage: TurnUsage): string {
  const rate = hitRate(usage)
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(0)}%`
}

/**
 * Tokens per second for the turn on screen.
 *
 * The session emits a running total, so the tokens a round produced are the
 * difference between two totals. The seconds arrive with the event, because
 * only the session knows how much of the gap between two of them was the model
 * generating and how much was a tool running; the gap itself would charge a
 * slow bash call to the model.
 *
 * It lives away from `chat.ts` so the arithmetic can be tested on its own.
 */
export class Throughput {
  private tokens = 0
  private ms = 0
  private lastOutput = 0
  private answer: number | null = null

  /**
   * Under about this long the division is mostly measurement noise, so a turn
   * shows no rate at all until it has generated for long enough to have one
   * worth reading.
   */
  static readonly FLOOR_MS = 400

  /** Output tokens per second, or `null` when there is nothing worth showing. */
  get value(): number | null {
    return this.answer
  }

  /**
   * A usage event. `streamMs` is absent on a subagent's total: those tokens
   * came off a stream this window never timed, and the spawn was very likely
   * generating while its parent was, so there is no interval the two of them
   * share. Such an event still moves the running total, so the tokens it
   * carries are absorbed and never counted against a later round.
   */
  note(usage: TurnUsage, streamMs?: number): void {
    const produced = usage.output - this.lastOutput
    this.lastOutput = usage.output
    if (streamMs === undefined || produced <= 0) return
    this.tokens += produced
    this.ms += streamMs
    if (this.ms >= Throughput.FLOOR_MS) this.answer = this.tokens / (this.ms / 1000)
  }

  /** A new turn. The rate is per turn, so the old one does not carry over. */
  startTurn(): void {
    this.tokens = 0
    this.ms = 0
    this.answer = null
  }

  /**
   * What a session had already spent before this window saw it. Nothing here
   * was timed, so there is no rate; the total is remembered only so the first
   * round of the next turn reports what it produced rather than the whole
   * history.
   */
  seed(output: number): void {
    this.startTurn()
    this.lastOutput = output
  }
}
