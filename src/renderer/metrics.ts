// doc: docs/harness/ui.md
import { tokensPerSecond } from '../shared/usage.js'
import type { TurnRate, TurnUsage } from '../core/types.js'

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
    if (this.ms >= Throughput.FLOOR_MS) this.answer = tokensPerSecond(this.tokens, this.ms)
  }

  /** A new turn. The rate is per turn, so the old one does not carry over. */
  startTurn(): void {
    this.tokens = 0
    this.ms = 0
    this.answer = null
  }

  /**
   * What a session had already spent before this window saw it. The total is
   * remembered so the first round of the next turn reports what it produced
   * and not the whole history. `rate` is the last turn as the session stored
   * it, shown until the next turn starts, on the same floor as a live one.
   */
  seed(output: number, rate?: TurnRate): void {
    this.startTurn()
    this.lastOutput = output
    if (rate === undefined || rate.output <= 0 || rate.streamMs < Throughput.FLOOR_MS) return
    this.answer = tokensPerSecond(rate.output, rate.streamMs)
  }
}
