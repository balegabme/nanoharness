// doc: docs/harness/cli.md
import { moneyText } from '../core/cost.js'
import { cacheHitRate } from '../core/types.js'
import type { SpendRow, SpendTotals, UsageReport } from '../core/usage-report.js'

/**
 * `nh usage` is the spend view in a terminal: the same report the window
 * draws, printed. The grouping is `core/usage-report.ts` and this file is only
 * how it reads.
 */

/** How many rows of a breakdown are worth printing before the tail is summed up. */
const ROWS = 8

export function formatReport(report: UsageReport, logPath: string): string {
  const lines = [`usage log: ${logPath}`]
  if (report.totals.turns === 0) {
    lines.push(report.skipped > 0 ? `no turns this build can read (${skippedText(report.skipped)})` : 'no turns recorded yet')
    return lines.join('\n')
  }

  const window = report.days === null ? 'all time' : `last ${report.days} days`
  lines.push(`${report.totals.turns} turn${report.totals.turns === 1 ? '' : 's'} across ${report.bySession.length} sessions, ${window}`, '')
  lines.push(...totalRows(report.totals))

  lines.push(...table('per day', report.byDay.filter(row => row.turns > 0)))
  lines.push(...table('per folder', report.byFolder))
  lines.push(...table('per session', report.bySession))
  lines.push(...table('per model', report.byModel))
  lines.push(...table('per agent', report.byAgent))
  lines.push(...table('where it went', report.byPhase))

  if (report.outside > 0) lines.push('', `${report.outside} turn${report.outside === 1 ? '' : 's'} outside the window`)
  if (report.skipped > 0) lines.push('', skippedText(report.skipped))
  return lines.join('\n')
}

// `reasoning` is indented because it is a breakdown of `output`. The four
// unindented rows add up to what the turn cost.
function totalRows(totals: SpendTotals): string[] {
  const rows: [string, string][] = [
    ['input', count(totals.usage.input)],
    ['cache read', count(totals.usage.cacheRead)],
    ['cache write', count(totals.usage.cacheWrite)],
    ['output', count(totals.usage.output)],
    ['  of which reasoning', count(totals.usage.reasoning)],
    ['cache hit', percent(cacheHitRate(totals.usage))],
    ['spent', moneyText(totals.costUsd)],
  ]
  const rate = throughput(totals)
  if (rate !== null) rows.push(['throughput', `${rate.toFixed(rate < 10 ? 1 : 0)} tok/s`])

  const lines = rows.map(([label, value]) => `  ${label.padEnd(20)} ${value.padStart(9)}`)
  // A total with unpriced turns under it is a floor, and saying so is the
  // difference between a bill and a guess.
  if (totals.unpriced > 0) lines.push(`  ${''.padEnd(20)} ${`+ ${totals.unpriced} unpriced`.padStart(9)}`)
  return lines
}

/**
 * One breakdown. Rows past the cut are summed into a last line and never
 * dropped, so the column still adds up to the total above it.
 */
function table(title: string, rows: readonly SpendRow[]): string[] {
  if (rows.length === 0) return []
  const shown = rows.slice(0, ROWS)
  const rest = rows.slice(ROWS)
  const width = Math.max(...shown.map(row => row.label.length), 12)

  const lines = ['', title]
  for (const row of shown) lines.push(`  ${row.label.padEnd(width)}  ${rowText(row)}`)
  if (rest.length > 0) {
    const tail = rest.reduce((sum, row) => sum + row.costUsd, 0)
    const turns = rest.reduce((sum, row) => sum + row.turns, 0)
    lines.push(`  ${`+ ${rest.length} more`.padEnd(width)}  ${String(turns).padStart(4)} turns  ${moneyText(tail).padStart(9)}`)
  }
  return lines
}

function rowText(row: SpendRow): string {
  const hit = percent(cacheHitRate(row.usage))
  const unpriced = row.unpriced > 0 ? `  ${row.unpriced} unpriced` : ''
  return `${String(row.turns).padStart(4)} turns  ${moneyText(row.costUsd).padStart(9)}  hit ${hit.padStart(5)}${unpriced}`
}

/** Output tokens per second over the time the models actually generated for. */
function throughput(totals: SpendTotals): number | null {
  return totals.streamMs === 0 ? null : totals.usage.output / (totals.streamMs / 1000)
}

function skippedText(skipped: number): string {
  return `${skipped} line${skipped === 1 ? '' : 's'} skipped (another schema version or unreadable)`
}

function count(value: number): string {
  return value.toLocaleString('en-US')
}

function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`
}
