// doc: docs/harness/ui.md
import { el, message } from './dom.js'
import { announce } from './notify.js'
import type { NanoBridge } from '../ipc/contract.js'
import type { AppEvent } from '../core/types.js'
import type { Question, QuestionAnswer } from '../shared/questions.js'

/**
 * A question the agent asked with `ask_user`, in a card above the composer.
 * The turn waits on it the way it waits on a permission prompt, but it is not
 * a modal: the conversation that led to it stays readable underneath, and the
 * card sits where the answer would otherwise be typed.
 *
 * One question shows at a time. A call with several gets a tab per header, a
 * single-choice pick moves on to the next unanswered one by itself, and the
 * last pick sends the lot. Every question also takes an answer in the user's
 * own words. Number keys pick, Enter confirms and Escape closes the card
 * unanswered, which the agent is told in those words.
 */

type Ask = Extract<AppEvent, { type: 'question.request' }>

interface Draft {
  picked: Set<string>
  other: string
}

interface Showing {
  ask: Ask
  drafts: Draft[]
  tab: number
}

let bridge: NanoBridge | null = null
let report: (text: string) => void = () => {}
let root: HTMLElement | null = null
/** Questions waiting, by session. Only the session on screen shows its own. */
const waiting = new Map<string, Ask[]>()
let viewing: string | null = null
let showing: Showing | null = null
/** The picks on a card, by question id, so leaving its session and coming back keeps them. */
const kept = new Map<string, Showing>()

function answered(draft: Draft): boolean {
  return draft.picked.size > 0 || draft.other.trim() !== ''
}

/** A question the agent just asked. Rings even when it is not the session on screen. */
export function addQuestion(ask: Ask): void {
  waiting.set(ask.sessionId, [...(waiting.get(ask.sessionId) ?? []), ask])
  announce('asking')
  if (ask.sessionId === viewing && showing === null) next()
}

/** The session on screen changed. Its first waiting question, if it has one, comes up. */
export function viewQuestions(sessionId: string | null): void {
  viewing = sessionId
  showing = null
  next()
}

/**
 * The turn that asked has ended, so nothing is waiting for these any more. The
 * main process has already settled them; this takes the cards away.
 */
export function dropQuestions(sessionId: string): void {
  for (const ask of waiting.get(sessionId) ?? []) kept.delete(ask.id)
  waiting.delete(sessionId)
  if (showing?.ask.sessionId === sessionId) {
    showing = null
    next()
  }
}

function next(): void {
  const ask = viewing === null ? undefined : waiting.get(viewing)?.[0]
  if (ask === undefined) {
    showing = null
    draw()
    return
  }
  showing = kept.get(ask.id) ?? { ask, drafts: ask.questions.map(() => ({ picked: new Set<string>(), other: '' })), tab: 0 }
  kept.set(ask.id, showing)
  draw()
  // The card takes the keyboard, so number keys pick at once, unless the
  // keyboard is busy somewhere else: a keystroke meant for the draft or for an
  // open sheet must not answer.
  const active = document.activeElement
  if (active === null || active === document.body || root?.contains(active) === true) focusCard()
}

/** Send what the card holds, or null for a card closed unanswered, and bring up the next one. */
function settle(reply: QuestionAnswer[] | null): void {
  if (showing === null || bridge === null) return
  const { ask } = showing
  const rest = (waiting.get(ask.sessionId) ?? []).filter(item => item.id !== ask.id)
  if (rest.length === 0) waiting.delete(ask.sessionId)
  else waiting.set(ask.sessionId, rest)
  bridge.answerQuestion(ask.id, reply).catch((err: unknown) => report(message(err)))
  kept.delete(ask.id)
  const hadFocus = root?.contains(document.activeElement) === true
  showing = null
  next()
  // The card that had the keyboard is gone; the composer is where it goes next.
  if (hadFocus && showing === null) document.getElementById('input')?.focus()
}

function submit(): void {
  if (showing === null) return
  const missing = showing.drafts.findIndex(draft => !answered(draft))
  if (missing !== -1) {
    showing.tab = missing
    draw()
    focusCard()
    return
  }
  settle(showing.drafts.map(draft => ({ picked: [...draft.picked], ...(draft.other.trim() === '' ? {} : { other: draft.other.trim() }) })))
}

/** The current question is answered: go to the next unanswered one, or send them all. */
function advance(): void {
  if (showing === null) return
  const { drafts, tab } = showing
  const later = drafts.findIndex((draft, index) => index > tab && !answered(draft))
  const earlier = drafts.findIndex(draft => !answered(draft))
  const to = later !== -1 ? later : earlier
  if (to === -1) {
    submit()
    return
  }
  showing.tab = to
  draw()
  focusCard()
}

function pick(question: Question, draft: Draft, label: string): void {
  if (question.multiSelect) {
    if (draft.picked.has(label)) draft.picked.delete(label)
    else draft.picked.add(label)
    draw()
    focusOption(label)
    return
  }
  // One choice: the pick is the answer, so it replaces anything typed and
  // moves on.
  draft.picked = new Set([label])
  draft.other = ''
  advance()
}

function focusCard(): void {
  const card = root
  if (card === null || showing === null) return
  const draft = showing.drafts[showing.tab]
  const chosen = draft === undefined ? undefined : [...draft.picked][0]
  const target =
    (chosen === undefined ? null : card.querySelector<HTMLElement>(`.q-option[data-label="${CSS.escape(chosen)}"]`)) ??
    (draft !== undefined && draft.other !== '' ? card.querySelector<HTMLElement>('.q-other-input') : null) ??
    card.querySelector<HTMLElement>('.q-option')
  target?.focus()
}

function focusOption(label: string): void {
  root?.querySelector<HTMLElement>(`.q-option[data-label="${CSS.escape(label)}"]`)?.focus()
}

function draw(): void {
  const card = root
  if (card === null) return
  card.hidden = showing === null
  if (showing === null) {
    card.replaceChildren()
    return
  }
  const { ask, drafts, tab } = showing
  const question = ask.questions[tab]
  const draft = drafts[tab]
  if (question === undefined || draft === undefined) return
  const many = ask.questions.length > 1
  const last = drafts.every((item, index) => index === tab || answered(item))

  const top = el('div', 'q-top')
  top.append(el('span', 'q-kicker', 'The agent is asking'))
  if (many) {
    const tabs = el('div', 'q-tabs')
    tabs.setAttribute('role', 'tablist')
    for (const [index, item] of ask.questions.entries()) {
      const chip = el('button', 'q-tab')
      chip.type = 'button'
      chip.setAttribute('role', 'tab')
      chip.setAttribute('aria-selected', String(index === tab))
      chip.classList.toggle('done', answered(drafts[index] ?? { picked: new Set(), other: '' }))
      chip.append(el('span', 'q-tab-mark'), el('span', undefined, item.header))
      chip.addEventListener('click', () => {
        if (showing === null) return
        showing.tab = index
        draw()
        focusCard()
      })
      tabs.append(chip)
    }
    top.append(tabs)
  } else top.append(el('span', 'q-header', question.header))
  top.append(el('span', 'spacer'))
  const dismiss = el('button', 'q-dismiss', 'Dismiss')
  dismiss.type = 'button'
  dismiss.title = 'Close without answering (Esc). The agent is told you did not answer.'
  dismiss.addEventListener('click', () => settle(null))
  top.append(dismiss)

  const options = el('div', 'q-options')
  options.setAttribute('role', question.multiSelect ? 'group' : 'radiogroup')
  options.setAttribute('aria-label', question.question)
  for (const [index, option] of question.options.entries()) {
    const chosen = draft.picked.has(option.label)
    const row = el('button', `q-option${chosen ? ' chosen' : ''}`)
    row.type = 'button'
    row.dataset.label = option.label
    row.setAttribute('role', question.multiSelect ? 'checkbox' : 'radio')
    row.setAttribute('aria-checked', String(chosen))
    const body = el('span', 'q-body')
    body.append(el('span', 'q-label', option.label), el('span', 'q-desc', option.description))
    row.append(el('kbd', 'q-key', String(index + 1)), body, el('span', question.multiSelect ? 'q-box' : 'q-dot'))
    row.addEventListener('click', () => pick(question, draft, option.label))
    options.append(row)
  }

  // The user's own words, always offered, so no set of options can corner them.
  const other = el('label', `q-option q-other${draft.other.trim() !== '' ? ' chosen' : ''}`)
  const input = el('input', 'q-other-input')
  input.type = 'text'
  input.spellcheck = true
  input.placeholder = 'Something else: type your own answer'
  input.value = draft.other
  input.addEventListener('input', () => {
    draft.other = input.value
    // One choice at a time: typed words replace a pick.
    if (!question.multiSelect && input.value.trim() !== '' && draft.picked.size > 0) {
      draft.picked.clear()
      for (const row of options.querySelectorAll('.q-option.chosen:not(.q-other)')) {
        row.classList.remove('chosen')
        row.setAttribute('aria-checked', 'false')
      }
    }
    other.classList.toggle('chosen', input.value.trim() !== '')
    confirm.disabled = !answered(draft)
  })
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    if (answered(draft)) advance()
  })
  other.append(el('kbd', 'q-key', String(question.options.length + 1)), input)
  options.append(other)

  const foot = el('div', 'q-foot')
  const keys = `1–${question.options.length + 1} ${question.multiSelect ? 'to tick' : 'to choose'} · Enter to confirm · Esc to dismiss`
  foot.append(el('span', 'q-hint', question.multiSelect ? `Choose any that apply. ${keys}` : keys))
  const confirm = el('button', 'btn sm primary q-confirm', last ? 'Send answer' : 'Next')
  confirm.type = 'button'
  confirm.disabled = !answered(draft)
  confirm.addEventListener('click', () => advance())
  // A single choice is sent by the pick itself; the button is there for a
  // typed answer, for ticks, and for going back over the tabs.
  foot.append(confirm)

  card.replaceChildren(top, el('p', 'q-text', question.question), options, foot)
}

function onKey(event: KeyboardEvent): void {
  // A key that ends an input method's composition belongs to the composition.
  if (showing === null || event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    settle(null)
    return
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return
  // In the field for the user's own words only the arrows that leave it are the card's.
  const typing = event.target instanceof HTMLInputElement
  if (typing && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  const question = showing.ask.questions[showing.tab]
  const draft = showing.drafts[showing.tab]
  if (question === undefined || draft === undefined) return
  // On a tick box Enter confirms, and Space is what ticks. A single choice
  // keeps the button's own Enter, which picks the row and moves on.
  if (event.key === 'Enter' && question.multiSelect && event.target instanceof HTMLElement && event.target.classList.contains('q-option')) {
    event.preventDefault()
    if (answered(draft)) advance()
    return
  }
  if (/^[1-9]$/.test(event.key)) {
    const index = Number(event.key) - 1
    const option = question.options[index]
    event.preventDefault()
    if (option !== undefined) pick(question, draft, option.label)
    else if (index === question.options.length) root?.querySelector<HTMLElement>('.q-other-input')?.focus()
    return
  }
  const rows = [...(root?.querySelectorAll<HTMLElement>('.q-option:not(.q-other), .q-other-input') ?? [])]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    rows[(at + step + rows.length) % rows.length]?.focus()
    return
  }
  const count = showing.ask.questions.length
  if (count > 1 && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    event.preventDefault()
    showing.tab = (showing.tab + (event.key === 'ArrowRight' ? 1 : -1) + count) % count
    draw()
    focusCard()
  }
}

export interface QuestionHandlers {
  bridge: NanoBridge
  root: HTMLElement
  report(text: string): void
}

export function initQuestions(handlers: QuestionHandlers): void {
  bridge = handlers.bridge
  report = handlers.report
  root = handlers.root
  root.className = 'question'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'The agent is asking')
  root.addEventListener('keydown', onKey)
  draw()
}
