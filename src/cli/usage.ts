// doc: docs/harness/cli.md
import { cacheHitRate, tokensPerSecond } from '../shared/usage.js'
import { countText, moneyText, percentText, plural, rateText, skippedText } from '../shared/format.js'
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
    lines.push(report.skipped > 0 ? `no turns to show (${skippedText(report.skipped)})` : 'no turns recorded yet')
    return lines.join('\n')
  }

  const window = report.days === null ? 'all time' : `last ${report.days} days`
  lines.push(`${plural(report.totals.turns, 'turn')} across ${report.bySession.length} sessions, ${window}`, '')
  lines.push(...totalRows(report.totals))

  lines.push(...table('per day', report.byDay.filter(row => row.turns > 0)))
  lines.push(...table('per folder', report.byFolder))
  lines.push(...table('per session', report.bySession))
  lines.push(...table('per model', report.byModel))
  lines.push(...table('per agent', report.byAgent))
  lines.push(...table('where it went', report.byPhase))

  if (report.outside > 0) lines.push('', `${plural(report.outside, 'turn')} outside the window`)
  if (report.skipped > 0) lines.push('', skippedText(report.skipped))
  return lines.join('\n')
}

// `reasoning` is indented because it is a breakdown of `output`. The four
// unindented rows add up to what the turn cost.
function totalRows(totals: SpendTotals): string[] {
  const rows: [string, string][] = [
    ['input', countText(totals.usage.input)],
    ['cache read', countText(totals.usage.cacheRead)],
    ['cache write', countText(totals.usage.cacheWrite)],
    ['output', countText(totals.usage.output)],
    ['  of which reasoning', countText(totals.usage.reasoning)],
    ['cache hit', percentText(cacheHitRate(totals.usage))],
    ['spent', moneyText(totals.costUsd)],
  ]
  const rate = tokensPerSecond(totals.usage.output, totals.streamMs)
  if (rate !== null) rows.push(['throughput', `${rateText(rate)} tok/s`])

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
  const hit = percentText(cacheHitRate(row.usage))
  const unpriced = row.unpriced > 0 ? `  ${row.unpriced} unpriced` : ''
  return `${String(row.turns).padStart(4)} turns  ${moneyText(row.costUsd).padStart(9)}  hit ${hit.padStart(5)}${unpriced}`
}
