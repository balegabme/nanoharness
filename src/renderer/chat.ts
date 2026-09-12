// doc: docs/harness/ui.md
import { el, pretty } from './dom.js'
import type { TranscriptMessage } from '../ipc/contract.js'
import type { AppEvent, SessionNote, TurnUsage } from '../core/types.js'

/**
 * The message flow. It is append-only and streams as the turn runs: thinking
 * fills in live in its own collapsed block, a tool call appears the moment it
 * is requested and grows its result when it returns, and the answer types
 * itself out underneath.
 *
 * A view is a class rather than a module of globals because there are two of
 * them: the conversation, and the subagent the user has opened. A subagent is
 * an agent doing exactly what the main one does, so it is drawn by exactly the
 * same code. A second, dimmer rendering of the same events would be a second
 * thing to keep correct and never as good as the first.
 */

/** Everything one flow needs to draw itself. */
export interface ChatHost {
  stream: HTMLElement
  /** The spacer that keeps the last block clear of whatever floats over it. */
  tail: HTMLElement
  /** The watermark behind an empty flow, where the view has one. */
  mark?: HTMLElement
  /** Where the running totals are drawn. */
  usageLine: HTMLElement
  /**
   * Open the subagent a tool call or a note names. Absent in a subagent's own
   * view: a subagent cannot spawn, so nothing in it is ever a link.
   */
  openSubagent?(id: string): void
}

/**
 * How a subagent is named in text the window has to read back: in a tool
 * result, in a note, and in the stored transcript of both. It is the one thread
 * from "an agent did something here" to the conversation it had.
 */
const SUBAGENT = /\[subagent:([0-9a-fA-F-]{36})\]/

export function subagentId(text: string): string | null {
  return SUBAGENT.exec(text)?.[1] ?? null
}

/** The same text with the marker taken out: the button says it better. */
function withoutMarker(text: string): string {
  return text.replace(SUBAGENT, '').replace(/[ \t]+\n/g, '\n').trim()
}

export function usageText(usage: TurnUsage): string {
  const seen = usage.cacheRead + usage.input
  const hit = seen === 0 ? 'n/a' : `${((usage.cacheRead / seen) * 100).toFixed(0)}%`
  return `in ${usage.input} · out ${usage.output} · cached ${usage.cacheRead} · hit ${hit}${usage.reasoning > 0 ? ` · reasoning ${usage.reasoning}` : ''}`
}

function metric(name: string, value: string, kind?: string): HTMLElement {
  const pill = el('span', kind === undefined ? 'metric' : `metric ${kind}`)
  pill.append(el('b', undefined, value), el('span', undefined, name))
  return pill
}

/**
 * The one argument worth showing beside the tool name, a path or a command,
 * so a row reads like "read src/index.ts" without being unfolded.
 */
function argHint(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed !== 'object' || parsed === null) return ''
    const record = parsed as Record<string, unknown>
    for (const key of ['path', 'command', 'title', 'task']) {
      const value = record[key]
      if (typeof value === 'string') return value.length > 90 ? `${value.slice(0, 89)}…` : value
    }
    return ''
  } catch {
    return ''
  }
}

export class ChatView {
  private readonly toolCards = new Map<string, HTMLDetailsElement>()
  private activity: HTMLElement | null = null
  private activityClock: ReturnType<typeof setInterval> | null = null
  private assistantBody: HTMLElement | null = null
  /**
   * The block `assistantBody` belongs to. A turn's last assistant text *is* the
   * answer, because the loop only ends when the model stops asking for tools.
   * That is not known until the turn ends, so the block is held here and
   * marked then.
   */
  private assistantBlock: HTMLElement | null = null
  private thinkingBody: HTMLElement | null = null
  private thinkingCard: HTMLDetailsElement | null = null

  /**
   * Output tokens per second, measured across the round that just reported: the
   * running total is what the session emits, so the rate is the difference
   * between two totals over the time between them.
   */
  private roundStartedAt = 0
  private lastOutput = 0
  private rate: number | null = null

  constructor(private readonly host: ChatHost) {}

  /** True when the reader is at the bottom, which is the only time to follow. */
  private append(node: HTMLElement): void {
    const stream = this.host.stream
    const pinned = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80
    // The turn indicator stays the last thing in the flow, so a block that
    // arrives mid-turn goes above it rather than orphaning it up the page.
    stream.insertBefore(node, this.activity ?? this.host.tail)
    if (this.host.mark !== undefined) this.host.mark.hidden = true
    if (pinned) stream.scrollTop = stream.scrollHeight
  }

  /**
   * The one moving thing in the view while a turn runs, and nothing at all when
   * one is not: three dots and the elapsed time, at the end of the flow where
   * the next answer will appear.
   */
  setActivity(on: boolean): void {
    if (this.activityClock !== null) {
      clearInterval(this.activityClock)
      this.activityClock = null
    }
    this.activity?.remove()
    this.activity = null
    if (!on) return

    const row = el('div', 'activity')
    const dots = el('span', 'activity-dots')
    dots.append(el('i'), el('i'), el('i'))
    const clock = el('span', 'activity-time', '0:00')
    row.append(dots, el('span', 'activity-word', 'working'), clock)
    this.host.stream.insertBefore(row, this.host.tail)
    this.activity = row
    this.host.stream.scrollTop = this.host.stream.scrollHeight

    const started = Date.now()
    this.activityClock = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000)
      clock.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    }, 1000)
  }

  /**
   * The running total, as a row of small pills. It is one line of numbers in a
   * corner, so the name of each is dim and the number is not; the two worth
   * noticing, cache hit and throughput, carry the accent.
   */
  setUsage(usage: TurnUsage | null): void {
    const line = this.host.usageLine
    line.replaceChildren()
    line.hidden = usage === null
    if (usage === null) return

    const seen = usage.cacheRead + usage.input
    line.append(metric('in', String(usage.input)), metric('out', String(usage.output)), metric('cached', String(usage.cacheRead)))
    if (seen > 0) line.append(metric('hit', `${((usage.cacheRead / seen) * 100).toFixed(0)}%`, 'hit'))
    if (usage.reasoning > 0) line.append(metric('reasoning', String(usage.reasoning)))
    if (this.rate !== null) line.append(metric('tok/s', this.rate.toFixed(this.rate < 10 ? 1 : 0), 'rate'))
    line.title = `${usageText(usage)}
Every turn added up, subagents included.`
  }

  /**
   * The session's own count of what it has spent, which the renderer only ever
   * reads: the rate is measured here because only the window knows when the
   * round started. A subagent's tokens arrive in the same total, so both the
   * count and the rate include the agents this one started.
   */
  noteUsage(usage: TurnUsage): void {
    const now = Date.now()
    const produced = usage.output - this.lastOutput
    const seconds = (now - this.roundStartedAt) / 1000
    if (this.roundStartedAt > 0 && produced > 0 && seconds >= 0.4) this.rate = produced / seconds
    this.lastOutput = usage.output
    this.roundStartedAt = now
    this.setUsage(usage)
  }

  /** What a re-opened session has already spent. Nothing was timed, so no rate. */
  showStoredUsage(usage: TurnUsage | undefined): void {
    this.rate = null
    this.roundStartedAt = 0
    this.lastOutput = usage?.output ?? 0
    this.setUsage(usage ?? null)
  }

  private block(kind: string, label: string): HTMLElement {
    return this.blockPair(kind, label).body
  }

  private blockPair(kind: string, label: string): { wrapper: HTMLElement; body: HTMLElement } {
    const wrapper = el('div', `block ${kind}`)
    const body = el('div', 'body')
    wrapper.append(el('div', 'label', label), body)
    this.append(wrapper)
    return { wrapper, body }
  }

  userBlock(text: string): void {
    this.block('user', 'you').textContent = text
  }

  errorBlock(text: string): void {
    this.block('error', 'error').textContent = text
  }

  /** A line about the run itself rather than about the conversation. */
  noteBlock(text: string): void {
    const id = subagentId(text)
    const pair = this.blockPair('note', 'note')
    pair.body.textContent = id === null ? text : withoutMarker(text)
    if (id !== null) pair.wrapper.append(this.openButton(id))
  }

  /**
   * The way in to a subagent's own conversation, from the thing that mentions
   * it. Both places one is named, the `spawn` result and the note a background
   * job leaves behind, get the same button, and it survives a restart because
   * the id it carries is stored in the transcript.
   */
  private openButton(id: string): HTMLButtonElement {
    const open = el('button', 'open-subagent', 'Open subagent') as HTMLButtonElement
    open.type = 'button'
    open.addEventListener('click', event => {
      // Inside a `<summary>` the click would also fold the card it sits in.
      event.preventDefault()
      event.stopPropagation()
      this.host.openSubagent?.(id)
    })
    return open
  }

  /**
   * Make a `spawn` card open its subagent. The card is the subagent as far as
   * the reader is concerned, so the whole head of it is the way in: clicking
   * anywhere on it shows that conversation instead of folding the card open on
   * the arguments, which are the least interesting thing about it. The button
   * stays as the visible sign that the card does something other cards do not.
   */
  private linkCard(card: HTMLDetailsElement, id: string): void {
    if (card.dataset.subagent === id) return
    card.dataset.subagent = id
    const summary = card.querySelector('summary')
    if (!(summary instanceof HTMLElement)) return
    summary.append(this.openButton(id))
    summary.addEventListener('click', event => {
      // Without this the click also toggles the `<details>` it sits in, so the
      // card would fold open behind the view that just replaced it.
      event.preventDefault()
      this.host.openSubagent?.(id)
    })
  }

  /**
   * A spawn that has started and not answered yet. A foreground subagent blocks
   * the parent's turn, so its tool card sits there running for as long as it
   * takes, and until this the card was the one thing in the window that named a
   * subagent nobody could open. The card becomes a way in the moment the job
   * starts; when the result lands, the card keeps the link it already has.
   */
  liveSubagent(id: string): void {
    const cards = [...this.host.stream.querySelectorAll<HTMLDetailsElement>('details.block.tool')].reverse()
    const card = cards.find(
      entry => entry.querySelector('.tool-name')?.textContent === 'spawn' && entry.dataset.subagent === undefined,
    )
    if (card !== undefined) this.linkCard(card, id)
  }

  /** A finished thinking block, folded away. Live thinking is drawn by deltas. */
  private thinkingBlock(text: string): void {
    const card = el('details', 'block thinking')
    card.append(el('summary', undefined, 'thinking'), el('pre', undefined, text))
    this.append(card)
  }

  clear(): void {
    this.setActivity(false)
    if (this.host.mark === undefined) this.host.stream.replaceChildren(this.host.tail)
    else this.host.stream.replaceChildren(this.host.mark, this.host.tail)
    if (this.host.mark !== undefined) this.host.mark.hidden = false
    this.toolCards.clear()
    this.assistantBody = null
    this.assistantBlock = null
    this.thinkingBody = null
    this.thinkingCard = null
    this.rate = null
    this.roundStartedAt = 0
    this.lastOutput = 0
    this.setUsage(null)
  }

  /** A new turn starts fresh: the previous turn's blocks are done growing. */
  startTurn(): void {
    this.assistantBody = null
    this.assistantBlock = null
    this.thinkingBody = null
    this.thinkingCard = null
    this.toolCards.clear()
    this.roundStartedAt = Date.now()
  }

  private toolCard(name: string, args: string): HTMLDetailsElement {
    const card = el('details', 'block tool')
    const summary = el('summary')
    summary.append(el('span', 'tool-name', name), el('span', 'tool-arg', argHint(args)))
    summary.dataset.state = 'running'
    card.append(summary, el('pre', undefined, pretty(args)))
    this.append(card)
    return card
  }

  /**
   * The answer, told apart from the running commentary above it. A turn is
   * mostly tool cards and half-sentences between them; the thing the user
   * actually asked for is the last block.
   *
   * Marking it is deliberately something that happens at the *end* of a turn
   * rather than a guess made while it streams: an assistant block that turns
   * out to be followed by another tool call was never the answer.
   */
  private markFinal(wrapper: HTMLElement | null): void {
    if (wrapper === null) return
    wrapper.classList.add('final')
    const label = wrapper.querySelector('.label')
    if (label instanceof HTMLElement) label.textContent = 'answer'
  }

  private finishToolCard(card: HTMLDetailsElement, text: string, ok: boolean): void {
    card.classList.add(ok ? 'ok' : 'failed')
    const summary = card.querySelector('summary')
    if (summary instanceof HTMLElement) summary.dataset.state = ok ? 'done' : 'failed'
    const id = subagentId(text)
    card.append(el('pre', undefined, id === null ? text : withoutMarker(text)))
    // A foreground spawn was already linked when its job started; `linkCard`
    // leaves that one alone.
    if (id !== null) this.linkCard(card, id)
  }

  /**
   * Replay a stored conversation, thinking included: a turn reads back the way
   * it was drawn live, which is the whole of why the reasoning is stored.
   */
  renderTranscript(messages: TranscriptMessage[], notes: readonly SessionNote[] = []): void {
    this.clear()
    const results = new Map<string, { text: string; failed: boolean }>()
    for (const message of messages) {
      if (message.role === 'tool' && message.callId !== undefined) {
        results.set(message.callId, { text: message.text, failed: message.failed === true })
      }
    }

    // A note sits where it happened: `after` is how many messages had been
    // written at the time, so a stop or an error comes back between the same
    // two blocks the user saw it between.
    const pending = [...notes].sort((a, b) => a.after - b.after || a.at - b.at)
    let next = 0
    const drawNotes = (upto: number): void => {
      for (;;) {
        const note = pending[next]
        if (note === undefined || note.after > upto) return
        next += 1
        if (note.kind === 'error') this.errorBlock(note.text)
        else this.noteBlock(note.text)
      }
    }

    for (const [index, message] of messages.entries()) {
      drawNotes(index)
      if (message.role === 'tool') continue
      if (message.role === 'user') {
        this.userBlock(message.text)
        continue
      }
      if (message.thinking !== undefined && message.thinking !== '') this.thinkingBlock(message.thinking)
      if (message.text.trim() !== '') {
        const pair = this.blockPair('assistant', 'assistant')
        pair.body.textContent = message.text
        // An assistant message with text and no tool calls is where a turn
        // stopped, which is the same rule the live path uses: the loop runs
        // until the model asks for nothing more.
        if ((message.tools ?? []).length === 0) this.markFinal(pair.wrapper)
      }
      for (const call of message.tools ?? []) {
        const card = this.toolCard(call.name, call.args)
        const output = results.get(call.id)
        if (output !== undefined) this.finishToolCard(card, output.text, !output.failed)
      }
    }
    drawNotes(messages.length)
  }

  /** One live event, for whichever agent this view is showing. */
  handleEvent(event: AppEvent): void {
    switch (event.type) {
      case 'thinking_delta': {
        if (this.thinkingBody === null) {
          this.thinkingCard = el('details', 'block thinking')
          this.thinkingCard.open = true
          this.thinkingBody = el('pre')
          this.thinkingCard.append(el('summary', undefined, 'thinking'), this.thinkingBody)
          this.append(this.thinkingCard)
        }
        this.thinkingBody.textContent += event.text
        const stream = this.host.stream
        if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80) stream.scrollTop = stream.scrollHeight
        break
      }
      case 'text_delta': {
        // The first token of the answer is the cue that thinking is over.
        if (this.thinkingCard !== null) this.thinkingCard.open = false
        if (this.assistantBody === null) {
          const pair = this.blockPair('assistant', 'assistant')
          this.assistantBlock = pair.wrapper
          this.assistantBody = pair.body
        }
        this.assistantBody.textContent += event.text
        break
      }
      case 'tool_call':
        // Text followed by a tool call was commentary, not the answer.
        this.toolCards.set(event.call.id, this.toolCard(event.call.name, event.call.args))
        this.assistantBody = null
        this.assistantBlock = null
        break
      case 'tool_result': {
        const card = this.toolCards.get(event.callId)
        if (card) this.finishToolCard(card, event.result.content ?? event.result.summary, event.result.ok)
        break
      }
      case 'usage':
        // The running total belongs beside the session's name, not as another
        // block pushing the conversation up.
        this.noteUsage(event.usage)
        break
      case 'session.error':
        this.errorBlock(event.message)
        break
      case 'session.stopped':
        if (this.thinkingCard !== null) this.thinkingCard.open = false
        // A stopped turn has no answer, only however far it got.
        this.noteBlock('Stopped.')
        break
      case 'session.finished':
        if (this.thinkingCard !== null) this.thinkingCard.open = false
        this.markFinal(this.assistantBlock)
        this.assistantBlock = null
        break
      case 'session.note':
        // Why a turn ended the way it did, in the flow rather than in a log
        // nobody opens.
        this.noteBlock(event.text)
        break
      case 'session.started':
      case 'permission.request':
      case 'mcp.status':
      case 'job.started':
      case 'job.update':
      case 'job.finished':
        break
    }
  }
}
