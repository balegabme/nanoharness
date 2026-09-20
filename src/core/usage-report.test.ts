import { describe, expect, it } from 'vitest'
import { buildReport } from './usage-report.js'
import type { UsageRecord } from './usage-log.js'

/**
 * The spend view and `nh usage` are two drawings of this one report, so what
 * is pinned here is the arithmetic both of them quote: the money adds up, an
 * unpriced turn is told apart from a free one, and a row whose session has
 * been deleted still carries what it spent.
 */

const nothing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }

/** Noon, so a day's rows cannot drift into the day before or after. */
function at(day: number, hour = 12): number {
  return new Date(2026, 8, day, hour, 0, 0, 0).getTime()
}

const NOW = at(19)

function turn(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    v: 3,
    at: NOW,
    sessionId: 'session-a',
    workspaceId: 'folder-a',
    turn: 1,
    role: 'builder',
    model: 'model-a',
    usage: { input: 1000, output: 200, cacheRead: 4000, cacheWrite: 0, reasoning: 0 },
    subagent: nothing,
    harness: nothing,
    costUsd: 0.02,
    subagentCostUsd: 0,
    harnessCostUsd: 0,
    streamMs: 1000,
    ...over,
  }
}

describe('what a window of turns came to', () => {
  it('adds up the money and names the turns nobody could price', () => {
    const report = buildReport([turn(), turn({ costUsd: null, harnessCostUsd: 0 })], { now: NOW })

    expect(report.totals.turns).toBe(2)
    expect(report.totals.costUsd).toBeCloseTo(0.02)
    expect(report.totals.unpriced).toBe(1)
  })

  it('counts the approval check on an unpriced turn, which was priced at its own model', () => {
    const report = buildReport([turn({ costUsd: null, harness: { ...nothing, input: 300 }, harnessCostUsd: 0.001 })], { now: NOW })

    expect(report.totals.costUsd).toBeCloseTo(0.001)
    expect(report.totals.unpriced).toBe(1)
  })

  it('leaves out a turn older than the window, and says how many it left out', () => {
    const report = buildReport([turn(), turn({ at: at(1) })], { days: 7, now: NOW })

    expect(report.totals.turns).toBe(1)
    expect(report.outside).toBe(1)
  })

  it('gives every day in the window a row, including the ones nothing ran on', () => {
    const report = buildReport([turn({ at: at(19) }), turn({ at: at(17) })], { days: 7, now: NOW })

    expect(report.byDay).toHaveLength(7)
    expect(report.byDay.map(row => row.turns)).toEqual([0, 0, 0, 0, 1, 0, 1])
    expect(report.byDay.at(-1)?.id).toBe('2026-09-19')
  })

  it('runs an all-time window from the first turn recorded', () => {
    const report = buildReport([turn({ at: at(17) })], { days: null, now: NOW })

    expect(report.byDay).toHaveLength(3)
    expect(report.byDay[0]?.id).toBe('2026-09-17')
  })
})

describe('who spent it', () => {
  it('splits a turn into the conversation, its subagents and the approval model', () => {
    const report = buildReport(
      [
        turn({
          usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          subagent: { input: 400, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          harness: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          costUsd: 0.05,
          subagentCostUsd: 0.03,
          harnessCostUsd: 0.005,
        }),
      ],
      { now: NOW },
    )

    const byId = new Map(report.byPhase.map(row => [row.id, row]))
    expect(byId.get('conversation')?.usage.output).toBe(180)
    expect(byId.get('conversation')?.costUsd).toBeCloseTo(0.015)
    expect(byId.get('subagents')?.costUsd).toBeCloseTo(0.03)
    expect(byId.get('approval')?.costUsd).toBeCloseTo(0.005)
    // The three phases are the whole turn, not most of it.
    expect(report.byPhase.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(report.totals.costUsd)
  })

  it('leaves out a phase that did nothing', () => {
    const report = buildReport([turn()], { now: NOW })

    expect(report.byPhase.map(row => row.id)).toEqual(['conversation'])
  })

  it('groups by folder, session, model and agent, dearest first', () => {
    const report = buildReport(
      [
        turn({ sessionId: 'cheap', model: 'model-a', role: 'planner', costUsd: 0.01 }),
        turn({ sessionId: 'dear', model: 'model-b', role: 'builder', costUsd: 0.4 }),
      ],
      { now: NOW, names: { sessions: { cheap: 'A quick question', dear: 'The long one' }, folders: { 'folder-a': 'nanoharness' } } },
    )

    expect(report.bySession.map(row => row.label)).toEqual(['The long one', 'A quick question'])
    expect(report.byModel.map(row => row.id)).toEqual(['model-b', 'model-a'])
    expect(report.byAgent.map(row => row.label)).toEqual(['Builder', 'Planner'])
    expect(report.byFolder[0]?.label).toBe('nanoharness')
    expect(report.byFolder[0]?.costUsd).toBeCloseTo(0.41)
  })
})

describe('a row whose session is gone', () => {
  it('keeps the spend and says the session was deleted', () => {
    const report = buildReport([turn({ sessionId: 'deleted-one' })], { now: NOW, names: { sessions: {} } })

    expect(report.bySession[0]?.gone).toBe(true)
    expect(report.bySession[0]?.label).toContain('deleted session')
    expect(report.bySession[0]?.costUsd).toBeCloseTo(0.02)
  })

  it('reports lines the read could not use, so an empty view is never a lie', () => {
    const report = buildReport([], { now: NOW, skipped: 4 })

    expect(report.totals.turns).toBe(0)
    expect(report.skipped).toBe(4)
  })
})
