// doc: docs/harness/ui.md
import { el, pretty } from './dom.js'
import { costOf, moneyText } from './facts.js'
import { hitText, promptTokens, Throughput } from './metrics.js'
import type { TranscriptMessage } from '../ipc/contract.js'
import type { AppEvent, PreventedCall, SessionNote, TurnUsage } from '../core/types.js'
import type { ModelFacts } from '../core/config.js'

/**
 * The message flow. It is append-only and streams as the turn runs: thinking
 * fills in live in its own collapsed block, a tool call appears the moment it
 * is requested and grows its result when it returns, and the answer types
 * itself out underneath.
 *
 * A class rather than a module of globals because there are two of them: the
 * conversation, and the subagent the user has opened. A subagent does what the
 * main agent does, so it is drawn by the same code.
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
  /**
   * Show the change an edit or write made, on its own and full width. Absent
   * where there is nowhere to put it.
   */
  openDiff?(diff: DiffOpen): void
}

/** A diff a tool result carried: the file it changed, and the unified text. */
export interface DiffOpen {
  path: string
  text: string
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

/** The tools whose result ends in a diff of what they changed. */
const WRITES = new Set(['edit', 'write'])

/** The fence `diffBlock` in `core/diff.ts` wraps a diff in. */
const DIFF_FENCE = /```diff\n([\s\S]*?)\n```\s*$/

/** The diff an edit or write put at the end of its result, if it did. */
function toolDiff(text: string): DiffOpen | null {
  const body = DIFF_FENCE.exec(text)?.[1]
  if (body === undefined) return null
  return { path: /^--- a\/(.*)$/m.exec(body)?.[1] ?? 'file', text: body }
}

/** The result with the diff taken out: the card opens it instead of listing it. */
function withoutDiff(text: string): string {
  return text.replace(DIFF_FENCE, '').trimEnd()
}

export function usageText(usage: TurnUsage): string {
  const written = usage.cacheWrite > 0 ? ` · written ${usage.cacheWrite}` : ''
  const reasoning = usage.reasoning > 0 ? ` · reasoning ${usage.reasoning}` : ''
  return `in ${usage.input} · out ${usage.output} · cached ${usage.cacheRead}${written} · hit ${hitText(usage)}${reasoning}`
}

/**
 * One running total minus a share of it, so the remainder can be priced on its
 * own. Every field is clamped at zero: the two totals arrive in separate events
 * and a share that is momentarily ahead of the total it belongs to would
 * otherwise show as a negative token count.
 */
function without(total: TurnUsage, share: TurnUsage): TurnUsage {
  return {
    input: Math.max(0, total.input - share.input),
    output: Math.max(0, total.output - share.output),
    cacheRead: Math.max(0, total.cacheRead - share.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - share.cacheWrite),
    reasoning: Math.max(0, total.reasoning - share.reasoning),
  }
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
   * Everything drawn since the current round started. A round that has to be
   * asked for again throws its half-answer away, and this list is what "away"
   * means on screen.
   */
  private roundNodes: HTMLElement[] = []
  /** The subagents' share of the running total, as of the last usage event. */
  private subagentSpend: TurnUsage | null = null
  /**
   * The harness's own share of the running total, and what it cost. The dollars
   * arrive already summed, because those calls ran on their own models at their
   * own prices; pricing them here would charge an approval check at the rate of
   * the model it was protecting.
   */
  private harnessSpend: TurnUsage | null = null
  private harnessCostUsd = 0
  /** What the selected model charges, or null while nobody has priced it. */
  private facts: ModelFacts | null = null
  /** The totals the usage line is showing, so a repricing can redraw them. */
  private lastUsage: TurnUsage | null = null

  /** Tokens per second for the turn on screen. `metrics.ts` has the arithmetic. */
  private readonly throughput = new Throughput()

  constructor(private readonly host: ChatHost) {}

  /** True when the reader is at the bottom, which is the only time to follow. */
  private append(node: HTMLElement): void {
    const stream = this.host.stream
    const pinned = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80
    // The turn indicator stays the last thing in the flow, so a block that
    // arrives mid-turn goes above it rather than orphaning it up the page.
    stream.insertBefore(node, this.activity ?? this.host.tail)
    this.roundNodes.push(node)
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
    this.lastUsage = usage
    const line = this.host.usageLine
    line.replaceChildren()
    line.hidden = usage === null
    if (usage === null) return

    line.append(metric('in', String(usage.input)), metric('out', String(usage.output)), metric('cached', String(usage.cacheRead)))
    // Whose output it was. A turn that hands its work to three agents pays
    // for all of them, so the total can read fifty thousand with this session
    // having written a paragraph.
    const byAgents = this.subagentSpend?.output ?? 0
    if (byAgents > 0) line.append(metric('by agents', String(byAgents), 'sub'))
    // The harness spending on its own behalf: an approval check, and whatever
    // else later joins it. In the total because it is billed, named apart
    // because it is not the model answering the question that was asked.
    const byHarness = (this.harnessSpend?.input ?? 0) + (this.harnessSpend?.output ?? 0)
    if (byHarness > 0) line.append(metric('harness', String(byHarness), 'sub'))
    // Only Anthropic ever reports a cache write, and a row of pills reading 0
    // on every other provider is a column of noise.
    if (usage.cacheWrite > 0) line.append(metric('written', String(usage.cacheWrite)))
    // The conversation's own tokens are what the session's model priced, so the
    // harness's share comes out before the multiplication and its dollars go
    // back in afterwards.
    const conversation = this.harnessSpend === null ? usage : without(usage, this.harnessSpend)
    const priced = this.facts === null ? null : costOf(conversation, this.facts)
    const spent = priced === null ? (this.harnessCostUsd > 0 ? this.harnessCostUsd : null) : priced + this.harnessCostUsd
    if (spent !== null) line.append(metric('spent', moneyText(spent), 'cost'))
    if (promptTokens(usage) > 0) line.append(metric('hit', hitText(usage), 'hit'))
    if (usage.reasoning > 0) line.append(metric('reasoning', String(usage.reasoning)))
    const rate = this.throughput.value
    if (rate !== null) line.append(metric('tok/s', rate.toFixed(rate < 10 ? 1 : 0), 'rate'))
    const share = byAgents > 0 ? `
${byAgents} of the output was written by subagents this session started.` : ''
    const harness = byHarness > 0 ? `
${byHarness} were spent by the harness itself, on approval checks, priced at that model's own rate.` : ''
    // The per-turn figure under each answer is priced by the model that ran
    // that turn. This one prices every token at what the model selected now
    // charges, so a session that changed models reads as an estimate.
    const note = spent === null ? '' : `
Priced at the rate of the model selected now.`
    line.title = `${usageText(usage)}
Every turn added up, subagents included.${share}${harness}${note}`
  }

  /**
   * The session's own count of what it has spent, which the renderer only ever
   * reads. A subagent's tokens arrive in the same total, so the counter
   * includes the agents this one started; the rate does not, for the reason
   * `metrics.ts` gives.
   */
  noteUsage(usage: TurnUsage, streamMs?: number, subagent?: TurnUsage, harness?: TurnUsage, harnessCostUsd?: number): void {
    this.throughput.note(usage, streamMs)
    if (subagent !== undefined) this.subagentSpend = subagent
    if (harness !== undefined) this.harnessSpend = harness
    if (harnessCostUsd !== undefined) this.harnessCostUsd = harnessCostUsd
    this.setUsage(usage)
  }

  /**
   * What the model now selected charges, so the running total can carry a
   * price. The window hands this down because the selection lives there, and
   * the view redraws so a model switch repriced the line without a new turn.
   */
  setFacts(facts: ModelFacts | null): void {
    this.facts = facts
    if (this.lastUsage !== null) this.setUsage(this.lastUsage)
  }

  /** What a re-opened session has already spent. Nothing was timed, so no rate. */
  showStoredUsage(usage: TurnUsage | undefined, subagent?: TurnUsage, harness?: TurnUsage, harnessCostUsd?: number): void {
    this.throughput.seed(usage?.output ?? 0)
    this.subagentSpend = subagent ?? null
    this.harnessSpend = harness ?? null
    this.harnessCostUsd = harnessCostUsd ?? 0
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

  /**
   * What the turn came to, under the answer it belongs to: how many tool calls
   * it took, which files it left different, and how long it ran. It is drawn
   * dimmer than a note, for the reason `docs/harness/ui.md` gives.
   */
  summaryBlock(text: string, prevented?: readonly PreventedCall[]): void {
    // A turn that was stopped from doing something is the one case where the
    // line has more to say than it can fit, so it becomes a disclosure rather
    // than a second block.
    if (prevented === undefined || prevented.length === 0) {
      const wrapper = el('div', 'block summary')
      wrapper.textContent = text
      this.append(wrapper)
      return
    }

    // The count itself is the affordance: opening it is what shows what was
    // stopped.
    const card = el('details', 'block summary prevented')
    const head = el('summary')
    const mark = `${prevented.length} prevented`
    const cut = text.indexOf(mark)
    if (cut === -1) head.append(el('span', 'summary-text', text))
    else {
      head.append(
        el('span', 'summary-text', text.slice(0, cut)),
        el('span', 'prevented-more', mark),
        el('span', 'summary-text', text.slice(cut + mark.length)),
      )
    }
    const list = el('div', 'prevented-list')
    for (const one of prevented) {
      const row = el('div', 'prevented-row')
      const head2 = el('div', 'prevented-head')
      head2.append(el('code', 'prevented-tool', one.tool))
      if (one.target !== '') head2.append(el('code', 'prevented-target', one.target))
      row.append(head2, el('div', 'prevented-reason', one.reason))
      list.append(row)
    }
    card.append(head, list)
    this.append(card)
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
   * the reader is concerned, so the whole head of it is the way in rather than
   * folding open on the arguments.
   */
  private linkCard(card: HTMLDetailsElement, id: string): void {
    if (card.dataset.subagent === id) return
    card.dataset.subagent = id
    const summary = card.querySelector('summary')
    if (!(summary instanceof HTMLElement)) return
    summary.addEventListener('click', event => {
      // Without this the click also toggles the `<details>` it sits in, so the
      // card would fold open behind the view that just replaced it.
      event.preventDefault()
      this.host.openSubagent?.(id)
    })
  }

  /**
   * A spawn that has started and not answered yet. A foreground subagent
   * blocks the parent's turn, so its card sits there running and is openable
   * before the result lands.
   */
  liveSubagent(id: string): void {
    const cards = [...this.host.stream.querySelectorAll<HTMLDetailsElement>('details.block.tool')].reverse()
    const card = cards.find(
      entry => entry.querySelector('.tool-name')?.textContent === 'spawn' && entry.dataset.subagent === undefined,
    )
    if (card !== undefined) this.linkCard(card, id)
  }

  /**
   * Make an edit or write card open its diff. The change is the whole of what
   * the card is about, so the head of it opens the change, the same way a spawn
   * card opens the agent it started.
   */
  private linkDiff(card: HTMLDetailsElement, diff: DiffOpen): void {
    if (this.host.openDiff === undefined || card.dataset.diff !== undefined) return
    card.dataset.diff = diff.path
    const summary = card.querySelector('summary')
    if (!(summary instanceof HTMLElement)) return
    summary.addEventListener('click', event => {
      event.preventDefault()
      this.host.openDiff?.(diff)
    })
  }

  /**
   * Take back what this round drew. The request failed part way through and is
   * being made again from the top, so the half a paragraph and the tool cards
   * already on screen belong to an answer that no longer exists.
   */
  private rollbackRound(): void {
    for (const node of this.roundNodes) node.remove()
    for (const [id, card] of this.toolCards) if (!card.isConnected) this.toolCards.delete(id)
    this.startRound()
  }

  /**
   * A fresh round draws into fresh blocks. The card the last round left open is
   * not in `roundNodes` any more, so appending to it would put the new answer
   * in a block that a rollback cannot take back.
   */
  private startRound(): void {
    this.roundNodes = []
    this.assistantBody = null
    this.assistantBlock = null
    this.thinkingBody = null
    this.thinkingCard = null
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
    this.roundNodes = []
    this.subagentSpend = null
    this.throughput.seed(0)
    this.setUsage(null)
  }

  /** A new turn starts fresh: the previous turn's blocks are done growing. */
  startTurn(): void {
    this.assistantBody = null
    this.assistantBlock = null
    this.thinkingBody = null
    this.thinkingCard = null
    this.toolCards.clear()
    this.roundNodes = []
    this.throughput.startTurn()
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
   * The answer, told apart from the running commentary above it: a turn is
   * mostly tool cards and half-sentences, and the thing the user asked for is
   * the last block. Marked at the end of the turn rather than while it streams,
   * because a block followed by another tool call was never the answer.
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
    // The card keeps the line that says what changed and hands the diff to
    // the view that can show it properly. Only the two tools that write one
    // are asked: a `read` of a patch file ends in a diff fence too, and that
    // card is showing a file rather than a change it made.
    const diff = ok && WRITES.has(card.querySelector('.tool-name')?.textContent ?? '') ? toolDiff(text) : null
    if (id !== null) card.append(el('pre', undefined, withoutMarker(text)))
    else card.append(el('pre', undefined, diff === null ? text : withoutDiff(text)))
    // A foreground spawn was already linked when its job started; `linkCard`
    // leaves that one alone.
    if (id !== null) this.linkCard(card, id)
    else if (diff !== null) this.linkDiff(card, diff)
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
        else if (note.kind === 'summary') this.summaryBlock(note.text, note.prevented)
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
        this.noteUsage(event.usage, event.streamMs, event.subagent, event.harness, event.harnessCostUsd)
        break
      case 'round.started':
        this.startRound()
        break
      case 'round.retry':
        this.rollbackRound()
        this.noteBlock(event.text)
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
        // Why a turn ended the way it did, in the flow rather than in a log.
        this.noteBlock(event.text)
        break
      case 'session.summary':
        this.summaryBlock(event.text, event.prevented)
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
