// doc: docs/harness/ui.md
import { el, GLYPH, icon } from './dom.js'
import { planProgress } from '../shared/plan.js'
import type { PlanItem } from '../shared/plan.js'

/**
 * The agent's plan, pinned above the composer while there is one. The head is
 * one line, a progress ring, the count and the step being worked on, so a
 * folded plan still says where the turn has got to. Opened, it lists every
 * step with its state.
 *
 * It draws whatever the last `todo_write` call said and keeps nothing else:
 * the chat view finds that call, live or in a replayed transcript, and hands
 * the list over.
 */

/** Whether the list is open, which the reader chooses once and keeps. */
const OPEN_KEY = 'nh.plan.open'

/** The ring in the head: its radius, and the length of its stroke. */
const RING_R = 7
const RING_LENGTH = 2 * Math.PI * RING_R

const SVG_NS = 'http://www.w3.org/2000/svg'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'closed'
  } catch {
    return true
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? 'open' : 'closed')
  } catch {
    // A window without storage opens the list every time, as a new one does.
  }
}

function ring(): { svg: SVGSVGElement; arc: SVGCircleElement } {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'plan-ring')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('viewBox', '0 0 18 18')
  svg.setAttribute('aria-hidden', 'true')
  const track = document.createElementNS(SVG_NS, 'circle')
  const arc = document.createElementNS(SVG_NS, 'circle')
  for (const circle of [track, arc]) {
    circle.setAttribute('cx', '9')
    circle.setAttribute('cy', '9')
    circle.setAttribute('r', String(RING_R))
  }
  track.setAttribute('class', 'plan-ring-track')
  arc.setAttribute('class', 'plan-ring-arc')
  arc.setAttribute('stroke-dasharray', String(RING_LENGTH))
  svg.append(track, arc)
  return { svg, arc }
}

export class PlanView {
  private items: PlanItem[] = []
  /** Put away by the reader. The next plan the agent writes brings it back. */
  private dismissed = false
  private running = false
  private open = readOpen()

  private readonly head: HTMLButtonElement
  private readonly arc: SVGCircleElement
  private readonly count: HTMLElement
  private readonly current: HTMLElement
  private readonly list: HTMLElement

  constructor(private readonly root: HTMLElement) {
    root.className = 'plan'
    this.head = el('button', 'plan-head')
    this.head.type = 'button'
    const { svg, arc } = ring()
    this.arc = arc
    this.count = el('span', 'plan-count')
    this.current = el('span', 'plan-current')
    const chevron = icon(GLYPH.chevronDown, 13)
    chevron.classList.add('plan-chevron')
    this.head.append(svg, el('span', 'plan-word', 'Plan'), this.count, this.current, chevron)
    this.head.addEventListener('click', () => this.toggle())

    const close = el('button', 'plan-close')
    close.type = 'button'
    close.title = 'Hide the plan until the agent changes it'
    close.setAttribute('aria-label', 'Hide the plan')
    close.append(icon(GLYPH.close, 12))
    close.addEventListener('click', () => {
      this.dismissed = true
      this.draw()
    })

    const bar = el('div', 'plan-bar')
    bar.append(this.head, close)
    // The list sits in a wrapper whose one grid row goes from 0fr to 1fr, which
    // is what lets the list slide open to its own height.
    this.list = el('ol', 'plan-list')
    const fold = el('div', 'plan-fold')
    fold.append(this.list)
    root.append(bar, fold)
    this.draw()
  }

  /**
   * The plan as the last `todo_write` left it, or null for a session that has
   * none. A finished plan read back from a stored session stays put away, as
   * it would have been once the next message was sent.
   */
  show(items: readonly PlanItem[] | null, replayed = false): void {
    this.items = items === null ? [] : [...items]
    const { done, total } = planProgress(this.items)
    this.dismissed = replayed && done === total
    this.draw()
  }

  /** Whether a turn is running, which is the only time the step being worked on moves. */
  setRunning(on: boolean): void {
    this.running = on
    this.root.classList.toggle('running', on)
  }

  /**
   * A new message was sent. A plan the agent finished belongs to the task
   * before it, so it goes; one still under way stays, since the message may
   * be about it.
   */
  turnStarted(): void {
    const { done, total } = planProgress(this.items)
    if (total > 0 && done === total) this.dismissed = true
    this.draw()
  }

  private toggle(): void {
    this.open = !this.open
    saveOpen(this.open)
    this.draw()
  }

  private draw(): void {
    const { done, total, current } = planProgress(this.items)
    this.root.hidden = total === 0 || this.dismissed
    if (this.root.hidden) return
    const finished = done === total
    this.root.classList.toggle('open', this.open)
    this.root.classList.toggle('finished', finished)
    this.root.classList.toggle('running', this.running)
    this.head.setAttribute('aria-expanded', String(this.open))
    this.head.title = this.open ? 'Fold the plan' : 'Show every step'
    this.arc.setAttribute('stroke-dashoffset', String(RING_LENGTH * (1 - done / total)))
    this.count.textContent = `${done}/${total}`
    // What the head says is the step under way; between steps it is the next
    // one, and at the end it says the plan is done.
    const next = current ?? this.items.find(item => item.status === 'pending')
    this.current.textContent = finished ? 'All steps done' : (next?.content ?? '')
    this.current.classList.toggle('waiting', current === undefined && !finished)

    this.list.replaceChildren(
      ...this.items.map((item, index) => {
        const row = el('li', `plan-item ${item.status}`)
        row.append(el('span', 'plan-mark'), el('span', 'plan-text', item.content))
        row.title = `${index + 1}. ${item.content}`
        return row
      }),
    )
    // A long plan scrolls inside its own box; the step under way is kept in it.
    const live = this.list.querySelector('.plan-item.in_progress')
    if (this.open && live instanceof HTMLElement) {
      this.list.scrollTop = Math.max(0, live.offsetTop - this.list.clientHeight / 2 + live.clientHeight / 2)
    }
  }
}
