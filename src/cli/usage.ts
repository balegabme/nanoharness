// doc: docs/harness/cli.md
import { emptyUsage } from '../core/types.js'
import type { TurnUsage } from '../core/types.js'
import type { UsageRecord } from '../core/usage-log.js'

export interface UsageSummary {
  turns: number
  sessions: number
  total: TurnUsage
  byModel: Map<string, { turns: number; usage: TurnUsage }>
}

// Cache hit rate is the plan's §15 headline metric: cached input over all
// input the provider had to look at. No input at all means nothing to report.
export function cacheHitRate(usage: TurnUsage): number | null {
  const looked = usage.cacheRead + usage.input
  return looked === 0 ? null : usage.cacheRead / looked
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
  for (const [label, value] of usageRows(summary.total)) lines.push(`  ${label.padEnd(12)} ${value.toLocaleString('en-US').padStart(9)}`)
  lines.push(`  ${'cache hit'.padEnd(12)} ${percent(cacheHitRate(summary.total)).padStart(9)}`)

  if (summary.byModel.size > 0) {
    lines.push('', 'per model')
    for (const [model, entry] of [...summary.byModel].sort((a, b) => b[1].turns - a[1].turns)) {
      const turns = `${entry.turns} turn${entry.turns === 1 ? '' : 's'}`
      lines.push(`  ${model}  ${turns}  in ${entry.usage.input.toLocaleString('en-US')}  cached ${entry.usage.cacheRead.toLocaleString('en-US')}  hit ${percent(cacheHitRate(entry.usage))}`)
    }
  }

  if (skipped > 0) lines.push('', `${skipped} unreadable line${skipped === 1 ? '' : 's'} skipped`)
  return lines.join('\n')
}

function usageRows(usage: TurnUsage): [string, number][] {
  return [
    ['input', usage.input],
    ['output', usage.output],
    ['cache read', usage.cacheRead],
    ['cache write', usage.cacheWrite],
    ['reasoning', usage.reasoning],
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
