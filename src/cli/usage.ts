// doc: docs/harness/cli.md
import { cacheHitRate, emptyUsage } from '../core/types.js'
import type { TurnUsage } from '../core/types.js'
import type { UsageRecord } from '../core/usage-log.js'

export interface UsageSummary {
  turns: number
  sessions: number
  total: TurnUsage
  byModel: Map<string, { turns: number; usage: TurnUsage }>
}

export function summarize(records: UsageRecord[]): UsageSummary {
  const total = emptyUsage()
  const sessions = new Set<string>()
  const byModel = new Map<string, { turns: number; usage: TurnUsage }>()

  for (const record of records) {
    sessions.add(record.sessionId)
    add(total, record.usage)
    const entry = byModel.get(record.model) ?? { turns: 0, usage: emptyUsage() }
    entry.turns += 1
    add(entry.usage, record.usage)
    byModel.set(record.model, entry)
  }

  return { turns: records.length, sessions: sessions.size, total, byModel }
}

export function formatSummary(summary: UsageSummary, logPath: string, skipped: number): string {
  const lines = [`usage log: ${logPath}`]
  if (summary.turns === 0) {
    lines.push('no turns recorded yet')
    return lines.join('\n')
  }

  lines.push(`${summary.turns} turns across ${summary.sessions} sessions`, '')
  for (const [label, value] of usageRows(summary.total)) lines.push(`  ${label.padEnd(20)} ${value.toLocaleString('en-US').padStart(9)}`)
  lines.push(`  ${'cache hit'.padEnd(20)} ${percent(cacheHitRate(summary.total)).padStart(9)}`)

  if (summary.byModel.size > 0) {
    lines.push('', 'per model')
    for (const [model, entry] of [...summary.byModel].sort((a, b) => b[1].turns - a[1].turns)) {
      const turns = `${entry.turns} turn${entry.turns === 1 ? '' : 's'}`
      // `written` is left out when there is none: only Anthropic reports cache
      // writes, and a 0 on every row of every other provider says nothing.
      const written = entry.usage.cacheWrite > 0 ? `  written ${entry.usage.cacheWrite.toLocaleString('en-US')}` : ''
      lines.push(`  ${model}  ${turns}  in ${entry.usage.input.toLocaleString('en-US')}  cached ${entry.usage.cacheRead.toLocaleString('en-US')}${written}  hit ${percent(cacheHitRate(entry.usage))}`)
    }
  }

  if (skipped > 0) lines.push('', `${skipped} line${skipped === 1 ? '' : 's'} skipped (another schema version or unreadable)`)
  return lines.join('\n')
}

// `reasoning` is indented because it is a breakdown of `output`. The four
// unindented rows add up to what the turn cost.
function usageRows(usage: TurnUsage): [string, number][] {
  return [
    ['input', usage.input],
    ['cache read', usage.cacheRead],
    ['cache write', usage.cacheWrite],
    ['output', usage.output],
    ['  of which reasoning', usage.reasoning],
  ]
}

function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`
}

function add(target: TurnUsage, source: TurnUsage): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.reasoning += source.reasoning
}
