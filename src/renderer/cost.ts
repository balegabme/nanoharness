// doc: docs/harness/cost.md
import { el, message, must } from './dom.js'
import { moneyText } from './facts.js'
import { hitRate, promptTokens } from './metrics.js'
import type { SpendRow, SpendTotals, UsageReport } from '../core/usage-report.js'
import type { NanoBridge } from '../ipc/contract.js'

/**
 * What has been spent: a bar per day with the cache hit rate drawn over it,
 * then the same money grouped by folder, session, model, agent and by which
 * part of the harness spent it.
 *
 * The arithmetic is src/core/usage-report.ts and arrives finished over IPC.
 * `nh usage` prints that same report, so the window and the terminal cannot
 * disagree about a number. This file is only how it looks.
 */

const body = must<HTMLElement>('cost-stream')
const windowLabel = must<HTMLElement>('cost-window')
const rangeSelect = must<HTMLSelectElement>('cost-range')
const rangeValue = must<HTMLElement>('cost-range-value')

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Rows of a breakdown before the rest is summed into one line. */
const ROWS = 10

/**
 * The chart's own coordinates. It is drawn once at this size and scaled to
 * whatever the column is, so nothing here has to be measured first.
 */
const PLOT = { width: 780, height: 168, top: 14, floor: 130, left: 44, right: 742, labels: 148 }

let bridge: NanoBridge | null = null
/** How far back the view counts: days, or null for everything the log holds. */
let days: number | null = 30
/** Each read is numbered so a slow one cannot draw over the answer after it. */
let asked = 0

export function initCost(nh: NanoBridge): void {
  bridge = nh
  rangeSelect.addEventListener('change', () => {
    days = rangeSelect.value === 'all' ? null : Number(rangeSelect.value)
    rangeValue.textContent = windowText(days)
    void refreshCost()
  })
}

/** Read the log and draw it. The view asks for this every time it is opened. */
export async function refreshCost(): Promise<void> {
  if (bridge === null) throw new Error('renderer: the spend view was opened before initCost')
  const mine = (asked += 1)
  windowLabel.textContent = windowText(days)
  try {
    const report = await bridge.usageReport(days)
    if (mine === asked) draw(report)
  } catch (err) {
    if (mine !== asked) return
    body.replaceChildren(el('p', 'cost-problem', `The usage log could not be read: ${message(err)}`))
  }
}

function draw(report: UsageReport): void {
  windowLabel.textContent = windowText(report.days)
  const page = document.createDocumentFragment()
  page.append(headline(report))

  if (report.totals.turns === 0) {
    page.append(el('p', 'cost-empty', report.skipped > 0 ? skippedText(report.skipped) : 'Nothing spent in this window.'))
    body.replaceChildren(page)
    return
  }

  page.append(chart(report.byDay))
  page.append(table('By folder', report.byFolder))
  page.append(table('By session', report.bySession))
  page.append(table('By model', report.byModel))
  page.append(table('By agent', report.byAgent))
  page.append(table('Where it went', report.byPhase))
  const footnotes = notes(report)
  if (footnotes !== null) page.append(footnotes)

  body.replaceChildren(page)
  body.scrollTop = 0
}

/**
 * The one number the view exists for, with the measures that qualify it under
 * it: how many turns it took, how much of the prompt came from cache, and how
 * many tokens were read and written to get there.
 */
function headline(report: UsageReport): HTMLElement {
  const totals = report.totals
  const block = el('section', 'cost-headline')
  block.append(el('p', 'cost-window-note', windowText(report.days)))
  block.append(el('p', 'cost-figure', moneyText(totals.costUsd)))

  const line = el('div', 'usage-line')
  line.append(metric('turns', count(totals.turns)))
  line.append(metric('cache hit', hitText(totals.usage), 'hit'))
  line.append(metric('in', tokens(promptTokens(totals.usage))))
  line.append(metric('out', tokens(totals.usage.output)))
  const rate = throughput(totals)
  if (rate !== null) line.append(metric('tok/s', rate.toFixed(rate < 10 ? 1 : 0), 'rate'))
  block.append(line)

  // A total with unpriced turns under it is a floor, and saying so is the
  // difference between a bill and a guess.
  if (totals.unpriced > 0) {
    block.append(el('p', 'cost-floor', `At least: ${count(totals.unpriced)} of these turns ran on a model with no prices set.`))
  }
  return block
}

function metric(name: string, value: string, kind = ''): HTMLElement {
  const pill = el('span', `metric ${kind}`.trim())
  pill.append(el('span', undefined, name), el('b', undefined, value))
  return pill
}

/**
 * A bar per day with the cache hit rate over it. The two belong on one chart
 * because they answer each other: a day the bars jump and the line drops is a
 * prompt prefix that stopped matching, which is the cheapest thing in the
 * harness to miss and the dearest to keep.
 */
function chart(rows: readonly SpendRow[]): HTMLElement {
  const section = el('section', 'cost-chart')
  const head = el('div', 'cost-chart-head')
  head.append(el('h3', undefined, 'Per day'))
  head.append(key('cost', 'cost'), key('hit', 'cache hit'))
  section.append(head)

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${PLOT.width} ${PLOT.height}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `Spend and cache hit rate over ${rows.length} days`)

  const tallest = Math.max(...rows.map(row => row.costUsd))
  const slot = (PLOT.right - PLOT.left) / rows.length
  const width = Math.max(2, Math.min(slot - 3, 26))

  svg.append(rule(PLOT.top, true), rule(PLOT.floor, false))
  svg.append(axisText(PLOT.left - 8, PLOT.top + 4, moneyText(tallest), 'end'))
  svg.append(axisText(PLOT.right + 8, PLOT.top + 4, '100%', 'start'))
  svg.append(axisText(PLOT.right + 8, PLOT.floor + 4, '0%', 'start'))

  for (const [index, row] of rows.entries()) {
    const height = tallest === 0 ? 0 : (row.costUsd / tallest) * (PLOT.floor - PLOT.top)
    const group = document.createElementNS(SVG_NS, 'g')
    const hover = document.createElementNS(SVG_NS, 'title')
    hover.textContent = dayDetail(row)
    group.append(hover)
    if (height > 0) {
      const bar = document.createElementNS(SVG_NS, 'rect')
      bar.setAttribute('class', 'cost-bar-mark')
      bar.setAttribute('x', String(PLOT.left + slot * index + (slot - width) / 2))
      bar.setAttribute('y', String(PLOT.floor - height))
      bar.setAttribute('width', String(width))
      bar.setAttribute('height', String(height))
      bar.setAttribute('rx', String(Math.min(2, width / 2)))
      group.append(bar)
    }
    svg.append(group)
  }

  for (const run of hitRuns(rows, slot)) svg.append(run)
  for (const text of dayLabels(rows, slot)) svg.append(text)

  section.append(svg)
  return section
}

/**
 * The hit-rate line, in runs. A day nothing ran on has no rate to draw, and
 * joining across it would invent a slope between two weeks that never
 * happened, so the line stops and starts again on the other side.
 */
function hitRuns(rows: readonly SpendRow[], slot: number): SVGElement[] {
  const runs: SVGElement[] = []
  let run: { x: number; y: number }[] = []

  const flush = (): void => {
    if (run.length === 0) return
    // A day with quiet days either side has no line in it, so it is drawn as
    // the point it is rather than left off the chart.
    if (run.length === 1) {
      const dot = document.createElementNS(SVG_NS, 'circle')
      dot.setAttribute('class', 'cost-hit-dot')
      dot.setAttribute('cx', run[0]?.x.toFixed(1) ?? '0')
      dot.setAttribute('cy', run[0]?.y.toFixed(1) ?? '0')
      dot.setAttribute('r', '2')
      runs.push(dot)
    } else {
      const polyline = document.createElementNS(SVG_NS, 'polyline')
      polyline.setAttribute('class', 'cost-hit-line')
      polyline.setAttribute('points', run.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '))
      runs.push(polyline)
    }
    run = []
  }

  for (const [index, row] of rows.entries()) {
    const rate = hitRate(row.usage)
    if (rate === null) {
      flush()
      continue
    }
    run.push({ x: PLOT.left + slot * index + slot / 2, y: PLOT.floor - rate * (PLOT.floor - PLOT.top) })
  }
  flush()
  return runs
}

/** Enough dates to read the axis by, and never so many that they collide. */
function dayLabels(rows: readonly SpendRow[], slot: number): SVGElement[] {
  const stride = Math.max(1, Math.ceil(rows.length / 7))
  const labels: SVGElement[] = []
  for (const [index, row] of rows.entries()) {
    // Counted back from the end, so the newest day is always the one labelled.
    if ((rows.length - 1 - index) % stride !== 0) continue
    labels.push(axisText(PLOT.left + slot * index + slot / 2, PLOT.labels, dayText(row.id), 'middle'))
  }
  return labels
}

function rule(y: number, dashed: boolean): SVGElement {
  const line = document.createElementNS(SVG_NS, 'line')
  line.setAttribute('class', dashed ? 'cost-rule dashed' : 'cost-rule')
  line.setAttribute('x1', String(PLOT.left))
  line.setAttribute('x2', String(PLOT.right))
  line.setAttribute('y1', String(y))
  line.setAttribute('y2', String(y))
  return line
}

function axisText(x: number, y: number, text: string, anchor: string): SVGElement {
  const node = document.createElementNS(SVG_NS, 'text')
  node.setAttribute('class', 'cost-axis')
  node.setAttribute('x', String(x))
  node.setAttribute('y', String(y))
  node.setAttribute('text-anchor', anchor)
  node.textContent = text
  return node
}

function key(kind: string, text: string): HTMLElement {
  const entry = el('span', 'cost-key')
  entry.append(el('i', `cost-swatch ${kind}`), el('span', undefined, text))
  return entry
}

/**
 * One breakdown. Rows past the cut are summed into a last line rather than
 * dropped, so the column still adds up to the headline above it.
 */
function table(title: string, rows: readonly SpendRow[]): HTMLElement {
  const section = el('section', 'cost-table')
  section.append(el('h3', undefined, title))
  if (rows.length === 0) {
    section.append(el('p', 'cost-empty', 'Nothing here.'))
    return section
  }

  const dearest = Math.max(...rows.map(row => row.costUsd))
  for (const row of rows.slice(0, ROWS)) section.append(spendRow(row, dearest))

  const rest = rows.slice(ROWS)
  if (rest.length > 0) {
    const more = el('div', 'cost-row rest')
    more.append(el('span', 'cost-label', `+ ${count(rest.length)} more`))
    more.append(el('span', 'cost-turns', turnsText(rest.reduce((sum, row) => sum + row.turns, 0))))
    more.append(el('span', 'cost-hit', ''))
    more.append(el('span', 'cost-money', moneyText(rest.reduce((sum, row) => sum + row.costUsd, 0))))
    section.append(more)
  }
  return section
}

function spendRow(row: SpendRow, dearest: number): HTMLElement {
  const line = el('div', row.gone === true ? 'cost-row gone' : 'cost-row')
  // The bar is this row's share of the dearest one, behind the text rather
  // than beside it, so the shape of a breakdown reads before any of it does.
  const share = el('span', 'cost-share')
  share.style.setProperty('--share', `${dearest === 0 ? 0 : (row.costUsd / dearest) * 100}%`)
  line.append(share)

  const label = el('span', 'cost-label', row.label)
  label.title = row.gone === true ? 'The id is all the log kept of this one.' : row.label
  line.append(label)
  line.append(el('span', 'cost-turns', turnsText(row.turns) + (row.unpriced > 0 ? ` · ${count(row.unpriced)} unpriced` : '')))
  line.append(el('span', 'cost-hit', hitText(row.usage)))
  line.append(el('span', 'cost-money', moneyText(row.costUsd)))
  return line
}

/** What the report leaves out, which a view that looks short has to say. */
function notes(report: UsageReport): HTMLElement | null {
  const lines: string[] = []
  if (report.outside > 0) lines.push(`${turnsText(report.outside)} outside this window.`)
  if (report.skipped > 0) lines.push(skippedText(report.skipped))
  if (lines.length === 0) return null
  return el('p', 'cost-note', lines.join(' '))
}

function skippedText(skipped: number): string {
  return `${count(skipped)} line${skipped === 1 ? '' : 's'} in the log this build cannot read: another schema version, or damaged.`
}

function windowText(window: number | null): string {
  return window === null ? 'all time' : `last ${count(window)} days`
}

function turnsText(turns: number): string {
  return `${count(turns)} turn${turns === 1 ? '' : 's'}`
}

function hitText(usage: SpendTotals['usage']): string {
  const rate = hitRate(usage)
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(0)}%`
}

/** Output tokens per second over the time the models actually generated for. */
function throughput(totals: SpendTotals): number | null {
  return totals.streamMs === 0 ? null : totals.usage.output / (totals.streamMs / 1000)
}

function dayDetail(row: SpendRow): string {
  const spent = `${dayText(row.id)} · ${moneyText(row.costUsd)}`
  return row.turns === 0 ? `${spent} · nothing ran` : `${spent} · ${turnsText(row.turns)} · cache hit ${hitText(row.usage)}`
}

/** `YYYY-MM-DD` as the axis says it. Built from the parts, so it stays local. */
function dayText(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  if (year === undefined || month === undefined || date === undefined) return day
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

function tokens(value: number): string {
  return value < 1000 ? count(value) : COMPACT.format(value)
}

function count(value: number): string {
  return value.toLocaleString('en-US')
}
