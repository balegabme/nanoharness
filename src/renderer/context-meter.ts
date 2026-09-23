// doc: docs/harness/ui.md
import { el, relativeTime } from './dom.js'
import { shortTokens } from './metrics.js'
import { Popover } from './popover.js'
import type { CompactionReason, ContextLedger, ContextParts } from '../core/types.js'

/**
 * The context button: a ring that fills as the next request grows, and the
 * panel it opens with what the request is made of. `docs/harness/context.md`
 * says how each figure is measured; this file only draws them.
 *
 * The ring is the ledger against the usable space, the window minus what is
 * kept for the answer. It turns red at the ledger's threshold, where automatic
 * compaction runs, and amber a stretch before it.
 */

/** Below this share of the usable space the ring is green, and amber above it. */
const AMBER = 0.6

const SVG_NS = 'http://www.w3.org/2000/svg'
const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** The parts in the order a request is built, which is the order the bar is drawn in. */
const PARTS: readonly { key: keyof ContextParts; label: string }[] = [
  { key: 'system', label: 'System prompt' },
  { key: 'tools', label: 'Tool definitions' },
  { key: 'summary', label: 'Summary' },
  { key: 'user', label: 'Your messages' },
  { key: 'assistant', label: 'Answers and tool calls' },
  { key: 'thinking', label: 'Thinking sent back' },
  { key: 'toolResults', label: 'Tool results' },
]

const REASON: Record<CompactionReason, string> = {
  auto: 'automatic',
  manual: 'by hand',
  overflow: 'after an overflow',
}

/** What the panel can ask the window to do. The subagent meter has none of it. */
export interface MeterActions {
  compact(): void
  /** Whether automatic compaction is on now, which a stored ledger may not know. */
  auto(): boolean
  setAuto(on: boolean): void
  /** The user's limit on the context now, for the same reason. Null for none. */
  limit(): number | null
  setLimit(limit: number | null): void
}

/** How full the ring is as a colour. `red` is the threshold's share of the usable space. */
function level(share: number, red: number): 'ok' | 'warn' | 'high' {
  if (share < AMBER) return 'ok'
  if (share < red) return 'warn'
  return 'high'
}

/**
 * The window, the limit where it is the smaller, the reserve and what is left,
 * on one line.
 */
function sizes(ledger: ContextLedger, usable: number): string {
  const parts: string[] = []
  if (ledger.window !== null) parts.push(`Window ${count(ledger.window)}`)
  if (ledger.limit !== null && (ledger.window === null || ledger.limit < ledger.window)) parts.push(`limited to ${count(ledger.limit)}`)
  parts.push(`${count(ledger.reserve)} kept for the answer`, `${count(usable)} usable`)
  return parts.join(' · ')
}

/** A count in full, for the panel, where there is room for every digit. */
function count(tokens: number): string {
  return Math.round(tokens).toLocaleString('en-US')
}

export class ContextMeter {
  private ledger: ContextLedger | null = null
  /** False for a ledger read back from disk, which is how the session was left. */
  private live = false
  private running = false
  private compacting = false
  /**
   * True while the limit field has focus. The panel is drawn again on every
   * ledger a running turn sends, and that would throw away what the user is
   * typing, so the draw waits for the field to lose focus.
   */
  private editing = false
  private drawDeferred = false
  private readonly popover: Popover
  private readonly fill: SVGCircleElement
  private readonly label: HTMLElement

  /**
   * `stale` is the line the panel shows under a ledger read back from disk,
   * saying what it is as of. `actions` is absent where nothing can be done
   * about the context, which is the case for a subagent.
   */
  constructor(
    private readonly button: HTMLButtonElement,
    private readonly panel: HTMLElement,
    private readonly stale: string,
    private readonly actions?: MeterActions,
  ) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('viewBox', '0 0 18 18')
    svg.setAttribute('aria-hidden', 'true')
    svg.classList.add('meter-ring')
    const track = document.createElementNS(SVG_NS, 'circle')
    this.fill = document.createElementNS(SVG_NS, 'circle')
    for (const circle of [track, this.fill]) {
      circle.setAttribute('cx', '9')
      circle.setAttribute('cy', '9')
      circle.setAttribute('r', String(RADIUS))
    }
    track.classList.add('meter-track')
    this.fill.classList.add('meter-fill')
    // The stroke starts at twelve o'clock and runs clockwise.
    this.fill.setAttribute('transform', 'rotate(-90 9 9)')
    this.fill.setAttribute('stroke-dasharray', `0 ${CIRCUMFERENCE}`)
    svg.append(track, this.fill)
    this.label = el('span', 'meter-label')
    button.replaceChildren(svg, this.label)
    button.hidden = true
    this.popover = new Popover(button, panel, () => this.drawPanel())
  }

  /** A new ledger. `live` is false for one stored when the session last ran. */
  show(ledger: ContextLedger | null, live: boolean): void {
    this.ledger = ledger
    this.live = live
    this.drawButton()
    if (this.popover.isOpen) this.drawPanel()
  }

  /** Draw the panel again, for a change it reads from somewhere other than the ledger. */
  refresh(): void {
    if (this.popover.isOpen) this.drawPanel()
  }

  /** A turn is running, so a compaction by hand has to wait for it. */
  setRunning(on: boolean): void {
    this.running = on
    if (this.popover.isOpen) this.drawPanel()
  }

  setCompacting(on: boolean): void {
    this.compacting = on
    this.button.classList.toggle('compacting', on)
    if (this.popover.isOpen) this.drawPanel()
  }

  /** Nothing to show: no session, or one that has not measured anything yet. */
  clear(): void {
    this.popover.close()
    this.running = false
    this.setCompacting(false)
    this.show(null, false)
  }

  private drawButton(): void {
    const ledger = this.ledger
    this.button.hidden = ledger === null
    if (ledger === null) return
    const usable = ledger.usable
    if (usable === null) {
      // No usable space, so no share to fill the ring with. The size is still
      // worth showing, and the panel says why there is nothing to measure it by.
      this.button.dataset.level = 'unknown'
      this.fill.setAttribute('stroke-dasharray', `0 ${CIRCUMFERENCE}`)
      this.label.textContent = shortTokens(ledger.tokens)
      this.button.setAttribute('aria-label', `Context: ${count(ledger.tokens)} tokens, no usable space known`)
      return
    }
    const share = ledger.tokens / usable
    const drawn = Math.min(1, share) * CIRCUMFERENCE
    this.button.dataset.level = level(share, (ledger.threshold ?? usable) / usable)
    this.fill.setAttribute('stroke-dasharray', `${drawn} ${CIRCUMFERENCE}`)
    this.label.textContent = `${Math.round(share * 100)}%`
    this.button.setAttribute('aria-label', `Context: ${count(ledger.tokens)} of ${count(usable)} usable tokens`)
  }

  private drawPanel(): void {
    if (this.editing) {
      this.drawDeferred = true
      return
    }
    const ledger = this.ledger
    if (ledger === null) {
      this.panel.replaceChildren(el('p', 'pop-note', 'Nothing measured yet.'))
      return
    }
    const rows: HTMLElement[] = [el('div', 'pop-title', 'Context')]
    const usable = ledger.usable
    rows.push(
      el(
        'div',
        'pop-figure',
        usable === null ? `${shortTokens(ledger.tokens)} tokens` : `${shortTokens(ledger.tokens)} of ${shortTokens(usable)} usable`,
      ),
    )
    if (usable !== null) rows.push(el('div', 'pop-line', sizes(ledger, usable)))
    rows.push(this.bar(ledger), this.table(ledger), el('p', 'pop-note', this.measure(ledger)))
    const room = ledger.room
    if (room === null) {
      rows.push(
        el(
          'p',
          'pop-note warn',
          'Nobody has said how big this model’s window is, so there is nothing to compact against. Settings has a field for it under the model, or set a limit below.',
        ),
      )
    } else if (usable === null) {
      const what = room === ledger.window ? 'window' : 'limit'
      rows.push(
        el(
          'p',
          'pop-note warn',
          `The ${count(ledger.reserve)} tokens kept for the answer fill the ${count(room)} token ${what}, so there is nothing to compact against. Check the ${what} and the model’s output limit.`,
        ),
      )
    } else if (!(this.actions?.auto() ?? ledger.auto)) {
      rows.push(el('p', 'pop-note warn', 'Automatic compaction is off. A request that outgrows the window fails with the provider’s error.'))
    }
    if (!this.live) rows.push(el('p', 'pop-note', this.stale))
    if (ledger.compactions.length > 0) rows.push(this.history(ledger))
    if (this.actions !== undefined) rows.push(...this.controls(this.actions))
    this.panel.replaceChildren(...rows)
  }

  /**
   * The parts side by side, against the usable space where there is one. The
   * tick is where automatic compaction runs, so the gap between the end of the
   * bar and the tick is the room left before it does.
   */
  private bar(ledger: ContextLedger): HTMLElement {
    const bar = el('div', 'ctx-bar')
    const scale = ledger.usable ?? ledger.tokens
    if (scale <= 0) return bar
    for (const part of PARTS) {
      const tokens = ledger.parts[part.key]
      if (tokens <= 0) continue
      const segment = el('span', `ctx-seg part-${part.key}`)
      segment.style.width = `${Math.min(100, (tokens / scale) * 100)}%`
      segment.title = `${part.label}: ${count(tokens)}`
      bar.append(segment)
    }
    if (ledger.threshold !== null && ledger.usable !== null) {
      const tick = el('span', 'ctx-tick')
      tick.style.left = `${(ledger.threshold / ledger.usable) * 100}%`
      tick.title = `Automatic compaction runs at ${count(ledger.threshold)}`
      bar.append(tick)
    }
    return bar
  }

  private table(ledger: ContextLedger): HTMLElement {
    const table = el('div', 'ctx-parts')
    for (const part of PARTS) {
      const tokens = ledger.parts[part.key]
      // A summary exists only after a compaction, and thinking only on a wire
      // that sends it back. A row of zeros for either is noise.
      if (tokens <= 0 && (part.key === 'summary' || part.key === 'thinking')) continue
      const share = ledger.tokens > 0 ? `${Math.round((tokens / ledger.tokens) * 100)}%` : ''
      const row = el('div', 'ctx-row')
      row.append(el('span', `ctx-swatch part-${part.key}`), el('span', 'ctx-name', part.label), el('b', undefined, count(tokens)), el('span', 'ctx-share', share))
      table.append(row)
    }
    return table
  }

  /** Which part of the total the provider counted and which part is a guess. */
  private measure(ledger: ContextLedger): string {
    if (ledger.measured === null) {
      return 'Estimated from the length of the text. The next response replaces the estimate with the provider’s own count.'
    }
    if (ledger.estimated <= 0) return `${count(ledger.measured)} as the provider counted the last request.`
    return `${count(ledger.measured)} as the provider counted the last request, and about ${count(ledger.estimated)} estimated for what has been added since.`
  }

  private history(ledger: ContextLedger): HTMLElement {
    const list = el('div', 'ctx-history')
    list.append(el('div', 'pop-sub', 'Compactions'))
    for (const record of [...ledger.compactions].reverse()) {
      const row = el('div', 'ctx-compaction')
      row.append(
        el('span', undefined, REASON[record.reason]),
        el('span', 'ctx-freed', `${shortTokens(record.before)} to ${shortTokens(record.after)}`),
        el('span', 'ctx-when', relativeTime(record.at)),
      )
      list.append(row)
    }
    return list
  }

  private controls(actions: MeterActions): HTMLElement[] {
    const row = el('div', 'pop-actions')
    const compact = el('button', 'btn sm outline', this.compacting ? 'Compacting…' : 'Compact now')
    compact.type = 'button'
    compact.disabled = this.running || this.compacting || this.ledger === null
    compact.title = this.running ? 'A turn is running. It checks the context before every request on its own.' : 'Summarise the older part of the conversation now'
    compact.addEventListener('click', () => actions.compact())

    const toggle = el('label', 'pop-toggle')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = actions.auto()
    box.addEventListener('change', () => actions.setAuto(box.checked))
    toggle.append(box, el('span', undefined, 'Compact automatically'))
    row.append(compact, toggle)
    return [row, this.limitRow(actions)]
  }

  /**
   * The user's limit on the context, for every session. Compaction works
   * against it where it is under the window. An empty field clears it, and
   * anything that is not a whole number above nought puts the old value back.
   */
  private limitRow(actions: MeterActions): HTMLElement {
    const row = el('div', 'pop-actions')
    const field = el('label', 'price-field')
    const box = el('input')
    box.type = 'number'
    box.min = '1'
    box.step = '1000'
    box.placeholder = 'none'
    const current = actions.limit()
    box.value = current === null ? '' : String(current)
    box.addEventListener('focus', () => {
      this.editing = true
    })
    box.addEventListener('blur', () => {
      this.editing = false
      if (!this.drawDeferred) return
      this.drawDeferred = false
      // Blur comes on mousedown, so drawing now would replace the control
      // being clicked before its click arrives. The draw waits for the
      // pointer to come up, and the click after it, or a moment where focus
      // left by keyboard.
      let drawn = false
      const draw = (): void => {
        if (drawn) return
        drawn = true
        this.drawPanel()
      }
      document.addEventListener('pointerup', () => setTimeout(draw, 0), { once: true, capture: true })
      setTimeout(draw, 1000)
    })
    box.addEventListener('change', () => {
      const text = box.value.trim()
      const parsed = Number(text)
      if (text !== '' && !(Number.isInteger(parsed) && parsed > 0)) {
        box.value = current === null ? '' : String(current)
        return
      }
      actions.setLimit(text === '' ? null : parsed)
    })
    field.title = 'Compaction works against this where it is under the model’s window'
    field.append(el('span', undefined, 'Limit the context to'), box, el('span', undefined, 'tokens'))
    row.append(field)
    return row
  }
}
