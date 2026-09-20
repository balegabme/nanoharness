// doc: docs/harness/cost.md
import { AGENTS } from './agents.js'
import { emptyUsage } from './types.js'
import type { AgentRole } from './agents.js'
import type { TurnUsage } from './types.js'
import type { UsageRecord } from './usage-log.js'

/**
 * The usage log, grouped every way the question "what did this cost me?" gets
 * asked: by day, by folder, by session, by model, by agent, and by which part
 * of the harness spent it.
 *
 * The arithmetic is here rather than in the window because the window is a
 * separate bundle that cannot import this file at runtime, and a second copy
 * of it would be a second set of numbers to keep true. The main process builds
 * the report and sends it over IPC; `nh usage` builds the same one and prints
 * it.
 */

/** What a group of turns came to. */
export interface SpendTotals {
  turns: number
  usage: TurnUsage
  /** Dollars this build can account for. See `unpriced`. */
  costUsd: number
  /**
   * Turns whose model carried no prices. Their tokens are in `usage` and their
   * money is not in `costUsd`, so a report with any of these is a floor rather
   * than a bill.
   */
  unpriced: number
  /** Generating time, first chunk to last, with no tool time in it. */
  streamMs: number
}

/** One row of a breakdown: a folder, a session, a model, an agent, a day. */
export interface SpendRow extends SpendTotals {
  id: string
  label: string
  /** The most recent turn counted in this row. */
  at: number
  /** The id names nothing any more: a deleted session, a folder that was removed. */
  gone?: boolean
}

/** Which part of the harness spent it. The three add up to the total. */
export type Phase = 'conversation' | 'subagents' | 'approval'

export interface UsageReport {
  /** How many days back the window runs, or null for everything recorded. */
  days: number | null
  /** The window itself: `from` is the start of its first day. */
  from: number
  to: number
  totals: SpendTotals
  /** Every day in the window, oldest first, including the ones nothing ran on. */
  byDay: SpendRow[]
  byFolder: SpendRow[]
  bySession: SpendRow[]
  byModel: SpendRow[]
  byAgent: SpendRow[]
  byPhase: SpendRow[]
  /** Turns recorded outside the window, which the rows above leave out. */
  outside: number
  /** Lines the read skipped: another schema version, or unreadable. */
  skipped: number
}

/** What the folders and sessions are called right now, by id. */
export interface UsageNames {
  folders?: Readonly<Record<string, string>>
  sessions?: Readonly<Record<string, string>>
}

export interface ReportOptions {
  /** How far back to count. Null is everything the log holds. */
  days?: number | null
  names?: UsageNames
  /** The clock, so a test can pick the day it is. */
  now?: number
  /** Lines the read of the log could not use, carried through to the report. */
  skipped?: number
}

const DAY_MS = 24 * 60 * 60 * 1000
// Thirty-six hours past midnight is the next day at noon, and still the next
// day on the two mornings a year that are an hour short or an hour long.
const NEXT_DAY = 36 * 60 * 60 * 1000

export function buildReport(records: readonly UsageRecord[], options: ReportOptions = {}): UsageReport {
  const now = options.now ?? Date.now()
  const days = options.days ?? null
  const names = options.names ?? {}

  // Whole days, in the timezone the machine is in: a day of spend is a day the
  // person had, not a UTC window that cuts their evening in half.
  const to = endOfDay(now)
  const counted = records.filter(record => record.at <= to && (days === null || record.at >= startOfDay(now - (days - 1) * DAY_MS)))
  const earliest = counted.reduce((min, record) => Math.min(min, record.at), now)
  const from = days === null ? startOfDay(earliest) : startOfDay(now - (days - 1) * DAY_MS)

  return {
    days,
    from,
    to,
    totals: totalsOf(counted),
    byDay: fillDays(group(counted, record => dayKey(record.at), key => key), from, to),
    byFolder: group(counted, record => record.workspaceId, key => names.folders?.[key], 'folder'),
    bySession: group(counted, record => record.sessionId, key => names.sessions?.[key], 'session'),
    byModel: group(counted, record => record.model, key => key),
    byAgent: group(counted, record => record.role, key => AGENTS[key as AgentRole].name),
    byPhase: phaseRows(counted),
    outside: records.length - counted.length,
    skipped: options.skipped ?? 0,
  }
}

function totalsOf(records: readonly UsageRecord[]): SpendTotals {
  const totals: SpendTotals = { turns: 0, usage: emptyUsage(), costUsd: 0, unpriced: 0, streamMs: 0 }
  for (const record of records) addTurn(totals, record)
  return totals
}

function addTurn(totals: SpendTotals, record: UsageRecord): void {
  totals.turns += 1
  addInto(totals.usage, record.usage)
  // An unpriced turn still ran the approval model, which is priced at its own
  // rate: that dollar was spent and is named here. The rest of the turn is not
  // guessed at, and `unpriced` is what says the figure is short.
  totals.costUsd += record.costUsd ?? record.harnessCostUsd
  if (record.costUsd === null) totals.unpriced += 1
  totals.streamMs += record.streamMs
}

/**
 * One row per distinct key. `label` falls back to the id's first characters
 * with a word for what happened to it, because a session deleted last week
 * still spent money and hiding the row would make the total not add up.
 */
function group(
  records: readonly UsageRecord[],
  keyOf: (record: UsageRecord) => string,
  labelOf: (key: string) => string | undefined,
  kind?: string,
): SpendRow[] {
  const rows = new Map<string, SpendRow>()
  for (const record of records) {
    const id = keyOf(record)
    const row = rows.get(id) ?? { id, label: id, at: 0, turns: 0, usage: emptyUsage(), costUsd: 0, unpriced: 0, streamMs: 0 }
    addTurn(row, record)
    row.at = Math.max(row.at, record.at)
    rows.set(id, row)
  }
  for (const row of rows.values()) {
    const label = labelOf(row.id)
    if (label !== undefined) row.label = label
    else if (kind !== undefined) {
      row.label = `${row.id.slice(0, 8)} · deleted ${kind}`
      row.gone = true
    }
  }
  return [...rows.values()].sort(bySpend)
}

/** Dearest first; a tie on money is broken by tokens, then by which ran last. */
function bySpend(a: SpendRow, b: SpendRow): number {
  if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd
  const tokens = promptAndOutput(b.usage) - promptAndOutput(a.usage)
  return tokens !== 0 ? tokens : b.at - a.at
}

function promptAndOutput(usage: TurnUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite + usage.output
}

/**
 * The three spenders inside a turn. `conversation` is what is left when the
 * other two are taken out of the total, so a phase table always adds up to the
 * report's total rather than to something near it.
 */
function phaseRows(records: readonly UsageRecord[]): SpendRow[] {
  const labels: Record<Phase, string> = { conversation: 'Conversation', subagents: 'Subagents', approval: 'Approval checks' }
  const rows: Record<Phase, SpendRow> = {
    conversation: blankRow('conversation', labels.conversation),
    subagents: blankRow('subagents', labels.subagents),
    approval: blankRow('approval', labels.approval),
  }

  for (const record of records) {
    const conversation = subtract(record.usage, record.subagent, record.harness)
    // What the session's own model charged, which is the turn less the two
    // shares that were priced elsewhere. Zero on an unpriced turn, where
    // `unpriced` on the row is what says the column is short.
    const spent = record.costUsd === null ? 0 : record.costUsd - record.subagentCostUsd - record.harnessCostUsd
    // Turns are counted where the phase did something, so "3 turns" under
    // Subagents means three turns delegated rather than three turns existed.
    note(rows.conversation, conversation, spent, record)
    note(rows.subagents, record.subagent, record.subagentCostUsd, record)
    note(rows.approval, record.harness, record.harnessCostUsd, record)
  }

  return [rows.conversation, rows.subagents, rows.approval].filter(row => row.turns > 0)
}

function blankRow(id: string, label: string): SpendRow {
  return { id, label, at: 0, turns: 0, usage: emptyUsage(), costUsd: 0, unpriced: 0, streamMs: 0 }
}

function note(row: SpendRow, usage: TurnUsage, costUsd: number, record: UsageRecord): void {
  if (promptAndOutput(usage) === 0 && costUsd === 0) return
  row.turns += 1
  addInto(row.usage, usage)
  row.costUsd += costUsd
  if (record.costUsd === null) row.unpriced += 1
  row.at = Math.max(row.at, record.at)
}

/**
 * Every day between the two ends, so a chart has a bar for the days nothing
 * ran on. A gap drawn as an empty day reads as a quiet Sunday; the same gap
 * closed up reads as a week of steady work.
 */
function fillDays(rows: readonly SpendRow[], from: number, to: number): SpendRow[] {
  const byKey = new Map(rows.map(row => [row.id, row]))
  const filled: SpendRow[] = []
  for (let at = startOfDay(from); at <= to; at = startOfDay(at + NEXT_DAY)) {
    const key = dayKey(at)
    filled.push(byKey.get(key) ?? { ...blankRow(key, key), at })
  }
  return filled
}

/** The local calendar day, as `YYYY-MM-DD`. */
export function dayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function endOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/** `total` with the named shares taken out, field by field. */
function subtract(total: TurnUsage, ...shares: TurnUsage[]): TurnUsage {
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

function addInto(target: TurnUsage, delta: TurnUsage): void {
  target.input += delta.input
  target.output += delta.output
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
  target.reasoning += delta.reasoning
}
