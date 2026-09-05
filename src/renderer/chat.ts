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
const usageLine = must<HTMLElement>('usage-line')

const toolCards = new Map<string, HTMLDetailsElement>()
let assistantBody: HTMLElement | null = null
let thinkingBody: HTMLElement | null = null
let thinkingCard: HTMLDetailsElement | null = null

/** True when the reader is at the bottom, which is the only time to follow. */
function append(node: HTMLElement): void {
  const pinned = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80
  stream.append(node)
  if (pinned) stream.scrollTop = stream.scrollHeight
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
  stream.replaceChildren()
  toolCards.clear()
  assistantBody = null
  thinkingBody = null
  thinkingCard = null
  usageLine.textContent = ''
}

/** A new turn starts fresh: the previous turn's blocks are done growing. */
export function startTurn(): void {
  assistantBody = null
  thinkingBody = null
  thinkingCard = null
  toolCards.clear()
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

function usageText(usage: TurnUsage): string {
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
      // The running total belongs on one line under the composer, not as
      // another block pushing the conversation up.
      usageLine.textContent = usageText(event.usage)
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
