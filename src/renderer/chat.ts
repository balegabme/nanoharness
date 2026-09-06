// doc: docs/harness/ui.md
import { el, must, pretty } from './dom.js'
import type { TranscriptMessage } from '../ipc/contract.js'
import type { AppEvent, ToolResult, TurnUsage } from '../core/types.js'

/**
 * The message flow. It is append-only and streams as the turn runs: thinking
 * fills in live in its own collapsed block, a tool call appears the moment it
 * is requested and grows its result when it returns, and the answer types
 * itself out underneath.
 */

const stream = must<HTMLElement>('stream')
// The flow ends above the floating composer, and the spacer that holds that
// clearance is a real child of the scroller, so every append goes before it.
const tail = must<HTMLElement>('stream-tail')
const mark = must<HTMLImageElement>('stream-mark')
const usageLine = must<HTMLElement>('usage-line')

const toolCards = new Map<string, HTMLDetailsElement>()
let activity: HTMLElement | null = null
let activityClock: ReturnType<typeof setInterval> | null = null
let assistantBody: HTMLElement | null = null
let thinkingBody: HTMLElement | null = null
let thinkingCard: HTMLDetailsElement | null = null

/**
 * Output tokens per second, measured across the round that just reported: the
 * running total is what the session emits, so the rate is the difference
 * between two totals over the time between them.
 */
let roundStartedAt = 0
let lastOutput = 0
let rate: number | null = null

/** True when the reader is at the bottom, which is the only time to follow. */
function append(node: HTMLElement): void {
  const pinned = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80
  // The turn indicator stays the last thing in the flow, so a block that
  // arrives mid-turn goes above it rather than orphaning it up the page.
  stream.insertBefore(node, activity ?? tail)
  mark.hidden = true
  if (pinned) stream.scrollTop = stream.scrollHeight
}

/**
 * The one moving thing in the window while a turn runs, and nothing at all when
 * one is not: three dots and the elapsed time, at the end of the flow where the
 * next answer will appear.
 */
export function setActivity(on: boolean): void {
  if (activityClock !== null) {
    clearInterval(activityClock)
    activityClock = null
  }
  activity?.remove()
  activity = null
  if (!on) return

  const row = el('div', 'activity')
  const dots = el('span', 'activity-dots')
  dots.append(el('i'), el('i'), el('i'))
  const clock = el('span', 'activity-time', '0:00')
  row.append(dots, el('span', 'activity-word', 'working'), clock)
  stream.insertBefore(row, tail)
  activity = row
  stream.scrollTop = stream.scrollHeight

  const started = Date.now()
  activityClock = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000)
    clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }, 1000)
}

/**
 * The running total for the open session, as a row of small pills. It is one
 * line of numbers in a corner, so the name of each is dim and the number is
 * not; the two worth noticing — cache hit and throughput — carry the accent.
 */
export function setUsage(usage: TurnUsage | null): void {
  usageLine.replaceChildren()
  usageLine.hidden = usage === null
  if (usage === null) return

  const seen = usage.cacheRead + usage.input
  usageLine.append(
    metric('in', String(usage.input)),
    metric('out', String(usage.output)),
    metric('cached', String(usage.cacheRead)),
  )
  if (seen > 0) usageLine.append(metric('hit', `${((usage.cacheRead / seen) * 100).toFixed(0)}%`, 'hit'))
  if (usage.reasoning > 0) usageLine.append(metric('reasoning', String(usage.reasoning)))
  if (rate !== null) usageLine.append(metric('tok/s', rate.toFixed(rate < 10 ? 1 : 0), 'rate'))
  usageLine.title = `${usageText(usage)}
This session, every turn added up.`
}

function metric(name: string, value: string, kind?: string): HTMLElement {
  const pill = el('span', kind === undefined ? 'metric' : `metric ${kind}`)
  pill.append(el('b', undefined, value), el('span', undefined, name))
  return pill
}

/**
 * The session's own count of what it has spent, which the renderer only ever
 * reads: the rate is measured here because only the window knows when the
 * round started.
 */
export function noteUsage(usage: TurnUsage): void {
  const now = Date.now()
  const produced = usage.output - lastOutput
  const seconds = (now - roundStartedAt) / 1000
  if (roundStartedAt > 0 && produced > 0 && seconds >= 0.4) rate = produced / seconds
  lastOutput = usage.output
  roundStartedAt = now
  setUsage(usage)
}

/** What a re-opened session has already spent. Nothing was timed, so no rate. */
export function showStoredUsage(usage: TurnUsage | undefined): void {
  rate = null
  roundStartedAt = 0
  lastOutput = usage?.output ?? 0
  setUsage(usage ?? null)
}

function block(kind: string, label: string): HTMLElement {
  const wrapper = el('div', `block ${kind}`)
  const body = el('div', 'body')
  wrapper.append(el('div', 'label', label), body)
  append(wrapper)
  return body
}

export function userBlock(text: string): void {
  block('user', 'you').textContent = text
}

export function errorBlock(text: string): void {
  block('error', 'error').textContent = text
}

/** A line about the run itself rather than about the conversation. */
export function noteBlock(text: string): void {
  block('note', 'note').textContent = text
}

/** A finished thinking block, folded away. Live thinking is drawn by deltas. */
function thinkingBlock(text: string): void {
  const card = el('details', 'block thinking')
  card.append(el('summary', undefined, 'thinking'), el('pre', undefined, text))
  append(card)
}

export function clearChat(): void {
  setActivity(false)
  stream.replaceChildren(mark, tail)
  mark.hidden = false
  toolCards.clear()
  assistantBody = null
  thinkingBody = null
  thinkingCard = null
  rate = null
  roundStartedAt = 0
  lastOutput = 0
  setUsage(null)
}

/** A new turn starts fresh: the previous turn's blocks are done growing. */
export function startTurn(): void {
  assistantBody = null
  thinkingBody = null
  thinkingCard = null
  toolCards.clear()
  roundStartedAt = Date.now()
}

function toolCard(name: string, args: string): HTMLDetailsElement {
  const card = el('details', 'block tool')
  const summary = el('summary')
  summary.append(el('span', 'tool-name', name), el('span', 'tool-arg', argHint(args)))
  summary.dataset.state = 'running'
  card.append(summary, el('pre', undefined, pretty(args)))
  append(card)
  return card
}

/**
 * The one argument worth showing beside the tool name — a path, a command —
 * so a row reads like "read src/index.ts" without being unfolded.
 */
function argHint(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed !== 'object' || parsed === null) return ''
    const record = parsed as Record<string, unknown>
    for (const key of ['path', 'command', 'title']) {
      const value = record[key]
      if (typeof value === 'string') return value.length > 90 ? `${value.slice(0, 89)}…` : value
    }
    return ''
  } catch {
    return ''
  }
}

function finishToolCard(card: HTMLDetailsElement, result: ToolResult): void {
  card.classList.add(result.ok ? 'ok' : 'failed')
  const summary = card.querySelector('summary')
  if (summary instanceof HTMLElement) summary.dataset.state = result.ok ? 'done' : 'failed'
  card.append(el('pre', undefined, result.content ?? result.summary))
}

export function usageText(usage: TurnUsage): string {
  const seen = usage.cacheRead + usage.input
  const hit = seen === 0 ? 'n/a' : `${((usage.cacheRead / seen) * 100).toFixed(0)}%`
  return `in ${usage.input} · out ${usage.output} · cached ${usage.cacheRead} · hit ${hit}${usage.reasoning > 0 ? ` · reasoning ${usage.reasoning}` : ''}`
}

/**
 * Replay a stored conversation. Only signed thinking survives a round trip, so
 * a replayed turn shows exactly the thinking the next request would send back.
 */
export function renderTranscript(messages: TranscriptMessage[]): void {
  clearChat()
  // Replay appends, and appending is what takes the mark away.
  const results = new Map<string, { text: string; failed: boolean }>()
  for (const message of messages) {
    if (message.role === 'tool' && message.callId !== undefined) {
      results.set(message.callId, { text: message.text, failed: message.failed === true })
    }
  }

  for (const message of messages) {
    if (message.role === 'tool') continue
    if (message.role === 'user') {
      userBlock(message.text)
      continue
    }
    if (message.thinking !== undefined && message.thinking !== '') thinkingBlock(message.thinking)
    if (message.text.trim() !== '') block('assistant', 'assistant').textContent = message.text
    for (const call of message.tools ?? []) {
      const card = toolCard(call.name, call.args)
      const output = results.get(call.id)
      if (output !== undefined) {
        card.classList.add(output.failed ? 'failed' : 'ok')
        const summary = card.querySelector('summary')
        if (summary instanceof HTMLElement) summary.dataset.state = output.failed ? 'failed' : 'done'
        card.append(el('pre', undefined, output.text))
      }
    }
  }
}

/** Live events for the session on screen. Anything else is dropped. */
export function handleEvent(event: AppEvent, activeSessionId: string | null): void {
  if ('sessionId' in event && event.sessionId !== activeSessionId) return

  switch (event.type) {
    case 'thinking_delta':
      if (thinkingBody === null) {
        thinkingCard = el('details', 'block thinking')
        thinkingCard.open = true
        thinkingBody = el('pre')
        thinkingCard.append(el('summary', undefined, 'thinking'), thinkingBody)
        append(thinkingCard)
      }
      thinkingBody.textContent += event.text
      if (thinkingCard !== null && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80) {
        stream.scrollTop = stream.scrollHeight
      }
      break
    case 'text_delta':
      // The first token of the answer is the cue that thinking is over.
      if (thinkingCard !== null) thinkingCard.open = false
      assistantBody ??= block('assistant', 'assistant')
      assistantBody.textContent += event.text
      break
    case 'tool_call':
      toolCards.set(event.call.id, toolCard(event.call.name, event.call.args))
      assistantBody = null
      break
    case 'tool_result': {
      const card = toolCards.get(event.callId)
      if (card) finishToolCard(card, event.result)
      break
    }
    case 'usage':
      // The running total belongs in the topbar, beside the session's name,
      // not as another block pushing the conversation up.
      noteUsage(event.usage)
      break
    case 'session.error':
      errorBlock(event.message)
      break
    case 'session.stopped':
      if (thinkingCard !== null) thinkingCard.open = false
      noteBlock('Stopped.')
      break
    case 'session.started':
    case 'session.finished':
    case 'permission.request':
      break
  }
}
