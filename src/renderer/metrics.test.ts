import { describe, expect, it } from 'vitest'
import { Throughput } from './metrics.js'
import type { TurnUsage } from '../core/types.js'

/**
 * The tokens-per-second number in the corner of the window: the seconds it
 * divides by are the model's generating time, never the gap between two usage
 * events (which is mostly whatever tool ran in between), and a subagent's total
 * moves the counter without touching the clock. Both are arithmetic, so this is
 * where they are pinned.
 */

/** A running total, the way a session reports one. */
function spent(output: number): TurnUsage {
  return { input: 0, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

describe('the rate in the corner of the window', () => {
  it('counts the seconds the model generated for, not the seconds the turn took', () => {
    const rate = new Throughput()
    rate.startTurn()
    // Two rounds of 600 tokens, half a second of generating each. A 30-second
    // bash call between them lands in neither number.
    rate.note(spent(600), 500)
    rate.note(spent(1200), 500)
    expect(rate.value).toBeCloseTo(1200, 5)
  })

  it('absorbs a subagent total without letting it near the rate', () => {
    const withSpawn = new Throughput()
    withSpawn.startTurn()
    withSpawn.note(spent(600), 500)
    // A spawn reports 5000 tokens mid-turn and carries no time of its own.
    withSpawn.note(spent(5600))
    withSpawn.note(spent(6200), 500)

    const alone = new Throughput()
    alone.startTurn()
    alone.note(spent(600), 500)
    alone.note(spent(1200), 500)

    // The parent generated 1200 tokens in one second either way. The spawn's
    // 5000 are somebody else's, and they must not be charged to this clock nor
    // counted again as the next round's output.
    expect(withSpawn.value).toBeCloseTo(1200, 5)
    expect(withSpawn.value).toBe(alone.value)
  })

  it('says nothing until there is enough generating to divide by', () => {
    const rate = new Throughput()
    rate.startTurn()
    rate.note(spent(40), 100)
    expect(rate.value).toBeNull()
    rate.note(spent(200), 300)
    expect(rate.value).toBeCloseTo(500, 5)
  })

  it('starts over each turn, so a fast turn does not flatter a slow one', () => {
    const rate = new Throughput()
    rate.startTurn()
    rate.note(spent(1000), 500)
    expect(rate.value).toBeCloseTo(2000, 5)

    rate.startTurn()
    expect(rate.value).toBeNull()
    // The total is still cumulative across the session, so the second turn's
    // first round reports what it produced and not the whole history.
    rate.note(spent(1100), 500)
    expect(rate.value).toBeCloseTo(200, 5)
  })

  it('shows the stored rate of a session it is reading back, and none where nothing was stored', () => {
    const stored = new Throughput()
    stored.seed(9000, { output: 600, streamMs: 4000 })
    expect(stored.value).toBeCloseTo(150, 5)
    stored.seed(9000, { output: 5, streamMs: 100 })
    expect(stored.value).toBeNull()

    const rate = new Throughput()
    rate.seed(9000)
    expect(rate.value).toBeNull()
    // The next round produced 50, not 9050.
    rate.startTurn()
    rate.note(spent(9050), 500)
    expect(rate.value).toBeCloseTo(100, 5)
  })

  it('ignores a round that ended without producing anything', () => {
    const rate = new Throughput()
    rate.startTurn()
    rate.note(spent(500), 500)
    const settled = rate.value
    // A stopped turn reports the same total again, with whatever time it spent
    // before the abort. Dividing nothing by that time is not a rate of zero.
    rate.note(spent(500), 2000)
    expect(rate.value).toBe(settled)
  })
})
