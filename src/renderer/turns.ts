// doc: docs/harness/ui.md
import { plural } from '../shared/format.js'
import { GLYPH, el, icon, message, relativeTime } from './dom.js'
import { openMenu } from './menu.js'
import type { MenuItem } from './menu.js'
import type { RewindMode } from '../core/checkpoints.js'
import type { AppEvent } from '../core/types.js'
import type { CheckpointView, NanoBridge, SessionCheckpointsResponse } from '../ipc/contract.js'

/**
 * The turns of the conversation on screen, and going back to one.
 *
 * The index at the right edge of the flow lists the turns. It is a column of
 * marks, one per turn, that opens into a list of the messages under the
 * pointer, or from the keyboard with Esc twice. Every message the user sent
 * has a Rewind button.
 *
 * A rewind asks first. The button opens a card above the turn that marks what
 * would go and names the files that would come back, and nothing changes until
 * the user confirms. A confirmed rewind is held under a bar that can undo it,
 * and the next message keeps it.
 */

export interface TurnsHost {
  bridge: NanoBridge
  stream: HTMLElement
  /** The spacer at the end of the flow, which the index stops above. */
  tail: HTMLElement
  index: HTMLElement
  /** The session a rewind could run in now: open, on screen and between turns. Null otherwise. */
  ready(): string | null
  /** The composer, which a rewind of the conversation fills with the message it took back. */
  draft: { get(): string; set(text: string): void; focus(): void }
  report(text: string): void
}

type Held = SessionCheckpointsResponse['held']

/** A rewind the user is looking at and has not confirmed. */
interface Preview {
  turn: CheckpointView
  mode: RewindMode
  card: HTMLElement
  /** What had the focus before the card took it. */
  from: Element | null
}

let host: TurnsHost
let sessionId: string | null = null
/** Oldest first. */
let turns: CheckpointView[] = []
let held: Held = null
let working = false
/** The text a rewind put in the composer, so the next one can replace it and undoing can take it out. */
let filled: string | null = null
let preview: Preview | null = null

/** In the order the card offers them, which is also what 1, 2 and 3 pick. */
const MODES: readonly { mode: RewindMode; label: string }[] = [
  { mode: 'both', label: 'Conversation and code' },
  { mode: 'conversation', label: 'Conversation only' },
  { mode: 'code', label: 'Code only' },
]

export function initTurns(options: TurnsHost): void {
  host = options
  buildIndex()

  host.stream.addEventListener('contextmenu', event => {
    const block = (event.target as Element).closest<HTMLElement>('.block.user[data-checkpoint]')
    const turn = turnById(block?.dataset.checkpoint)
    if (block === null || turn === undefined) return
    event.preventDefault()
    openMenu(event.clientX, event.clientY, menuFor(turn, block))
  })
  host.stream.addEventListener('scroll', markCurrent, { passive: true })
  const resize = new ResizeObserver(placeIndex)
  resize.observe(host.stream)
  resize.observe(host.tail)

  // Caught on the way down, so the Esc that closes the card does not also
  // count as the first of the composer's double press. An open menu or sheet
  // takes the Esc first.
  addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Escape' || preview === null) return
      if (document.querySelector('dialog[open], .context-menu, .command-menu:not([hidden])') !== null) return
      event.preventDefault()
      event.stopPropagation()
      closePreview()
    },
    true,
  )

  addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (document.querySelector('dialog[open]') !== null) return
    // Over text being typed, Alt and an arrow move the caret, so the keys are
    // the field's until it is empty.
    const field = event.target
    if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && field.value !== '') return
    event.preventDefault()
    jump(event.key === 'ArrowUp' ? -1 : 1)
  })
}

/** True while a rewind is being run, when nothing else may start in the session. */
export function rewinding(): boolean {
  return working
}

/** True when the session on screen is holding a rewind. */
export function holding(): boolean {
  return held !== null
}

/**
 * Read the session's turns afresh and mark them on screen. Null clears them.
 *
 * The turns a sent message took back were set aside by `keepHeld`. When the
 * session holds no rewind now, it kept that one and they go. When it still
 * holds one, the message was refused before its turn began, and they are drawn
 * again as the held rewind has them.
 */
export async function loadTurns(id: string | null): Promise<void> {
  if (id !== sessionId) {
    filled = null
    closeIndex(true)
  }
  closePreview()
  sessionId = id
  turns = []
  held = null
  if (id !== null) {
    try {
      const got = await host.bridge.checkpoints(id)
      if (sessionId !== id) return
      turns = got.checkpoints
      held = got.held
    } catch (err) {
      host.report(message(err))
    }
  }
  for (const node of host.stream.querySelectorAll('.block.dropped')) {
    if (held === null) node.remove()
    else node.classList.remove('dropped', 'kept')
  }
  draw()
}

/** A turn began live. Its message is already on screen, the last one without an index. */
export function noteCheckpoint(event: Extract<AppEvent, { type: 'session.checkpoint' }>): void {
  if (event.sessionId !== sessionId) return
  const { id, turn, at, prompt, marker } = event
  turns.push({ id, turn, at, prompt, marker, edited: 0, files: [] })
  const live = [...host.stream.querySelectorAll<HTMLElement>('.block.user:not([data-index])')].at(-1)
  if (live !== undefined) live.dataset.index = String(marker)
  draw()
}

/**
 * The user is sending a message, which closes the card and keeps the held
 * rewind. The turns it took back stay hidden, set aside until `loadTurns` says
 * whether the session kept it. True when there was a rewind to keep.
 */
export function keepHeld(): boolean {
  closePreview()
  if (held === null) return false
  if (held.mode !== 'code') {
    for (const node of host.stream.querySelectorAll('.block.dropped')) node.classList.add('kept')
    const index = heldIndex()
    if (index !== -1) turns = turns.slice(0, index)
  }
  held = null
  filled = null
  draw()
  return true
}

function turnById(id: string | undefined): CheckpointView | undefined {
  return turns.find(turn => turn.id === id)
}

function heldIndex(): number {
  return held === null ? -1 : turns.findIndex(turn => turn.id === held?.checkpointId)
}

/** The turn's message on screen, leaving out those a sent message set aside. */
function blockOf(turn: CheckpointView): HTMLElement | null {
  return host.stream.querySelector<HTMLElement>(`.block.user[data-index="${turn.marker}"]:not(.kept)`)
}

/**
 * The turn's message and everything after it in the flow, which is what going
 * back to before it takes off the screen. A message that never began a turn,
 * because it was refused, ends the run.
 */
function following(turn: CheckpointView): HTMLElement[] {
  const first = blockOf(turn)
  const out: HTMLElement[] = []
  for (let node: Element | null = first; node !== null; node = node.nextElementSibling) {
    if (!(node instanceof HTMLElement) || !node.classList.contains('block')) continue
    if (node !== first && node.classList.contains('user') && node.dataset.index === undefined) break
    out.push(node)
  }
  return out
}

/** Where a node sits in the flow's scrolled content. */
function offsetOf(node: HTMLElement): number {
  return node.getBoundingClientRect().top - host.stream.getBoundingClientRect().top + host.stream.scrollTop
}

// ── the turns in the flow ──────────────────────────────────────────────

/** Mark every turn on screen, hide what the held rewind took back, put the bar under what is left, and redraw the index. */
function draw(): void {
  const start = turns[heldIndex()]
  if (held !== null && held.mode !== 'code' && start !== undefined) {
    for (const node of following(start)) node.classList.add('dropped')
  }
  const byMarker = new Map(turns.map(turn => [String(turn.marker), turn]))
  for (const block of host.stream.querySelectorAll<HTMLElement>('.block.user[data-index]:not(.kept)')) {
    const turn = byMarker.get(block.dataset.index ?? '')
    if (turn === undefined) undecorate(block)
    else decorate(block, turn)
  }
  host.stream.querySelector('.rewind-bar')?.remove()
  if (held !== null && start !== undefined) host.stream.insertBefore(heldBar(start, held), host.tail)
  drawIndex()
}

function undecorate(block: HTMLElement): void {
  delete block.dataset.checkpoint
  block.querySelector('.turn-tools')?.remove()
  block.querySelector('.turn-no')?.remove()
}

function decorate(block: HTMLElement, turn: CheckpointView): void {
  block.dataset.checkpoint = turn.id
  const label = block.querySelector('.label')
  const number = label?.querySelector('.turn-no')
  if (number !== null && number !== undefined) number.textContent = ` · turn ${turn.turn}`
  else label?.append(el('span', 'turn-no', ` · turn ${turn.turn}`))
  if (block.querySelector('.turn-tools') !== null) return
  const tools = el('div', 'turn-tools')
  const act = el('button', 'turn-act')
  act.type = 'button'
  act.title = 'Go back to before this turn. What would change is shown first.'
  act.append(icon(GLYPH.rewind, 12), 'Rewind')
  // Looked up by the id on the block, since the list of turns is read afresh after every turn.
  act.addEventListener('click', () => openPreview(turnById(block.dataset.checkpoint)))
  tools.append(act)
  block.append(tools)
}

function menuFor(turn: CheckpointView, block: HTMLElement): MenuItem[] {
  const text = block.querySelector('.body')?.textContent ?? ''
  return [
    { label: 'Rewind to before this turn…', run: () => openPreview(turn) },
    { label: 'Copy message', run: () => navigator.clipboard.writeText(text).catch((err: unknown) => host.report(message(err))) },
  ]
}

/** Under what is left of the conversation: what the held rewind did, and the way to undo it. */
function heldBar(turn: CheckpointView, state: NonNullable<Held>): HTMLElement {
  const count = plural(turns.length - turns.indexOf(turn), 'turn')
  const files = plural(turn.files.length, 'file')
  const text =
    state.mode === 'code'
      ? `${files} put back as they were before turn ${turn.turn}. The conversation stays as it is.`
      : state.mode === 'conversation'
        ? `Rewound to before turn ${turn.turn}, ${count} taken back. The files stay as they are.`
        : `Rewound to before turn ${turn.turn}, ${count} and ${files} taken back.`
  const bar = el('div', 'rewind-bar')
  bar.setAttribute('role', 'status')
  const words = el('div', 'rewind-bar-text')
  words.append(el('span', undefined, text), el('span', 'rewind-bar-hint', 'Sending a message makes it final. Until then it can be undone.'))
  const undo = el('button', 'btn sm outline', 'Undo')
  undo.type = 'button'
  undo.addEventListener('click', () => void rewind(null, state.mode))
  bar.append(words, undo)
  return bar
}

// ── asking first ───────────────────────────────────────────────────────

/** Open the card for going back to before `turn`, above its message, and wait for the user. */
function openPreview(turn: CheckpointView | undefined): void {
  if (turn === undefined || host.ready() === null || working) return
  closeIndex(true)
  closePreview()
  const block = blockOf(turn)
  if (block === null) return
  const card = el('div', 'rewind-preview')
  card.setAttribute('role', 'group')
  card.setAttribute('aria-label', `Rewind to before turn ${turn.turn}`)
  card.addEventListener('keydown', onPreviewKey)
  host.stream.insertBefore(card, block)
  const mode = held?.mode ?? 'both'
  preview = { turn, mode: mode === 'code' && turn.files.length === 0 ? 'both' : mode, card, from: document.activeElement }
  renderPreview()
  host.stream.scrollTo({ top: offsetOf(card) - 12, behavior: 'smooth' })
  card.querySelector<HTMLElement>('.rewind-go')?.focus({ preventScroll: true })
}

/** Close the card without rewinding, as when a turn or a compaction starts. */
export function closePreview(): void {
  if (preview === null) return
  const { card, from } = preview
  preview = null
  const focused = card.contains(document.activeElement)
  card.remove()
  for (const node of host.stream.querySelectorAll('.block.doomed')) node.classList.remove('doomed')
  if (focused && from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true })
}

function renderPreview(): void {
  if (preview === null) return
  const { turn, mode, card } = preview
  const count = plural(turns.length - turns.indexOf(turn), 'turn')
  const files = turn.files

  for (const node of host.stream.querySelectorAll('.block.doomed')) node.classList.remove('doomed')
  if (mode !== 'code') for (const node of following(turn)) node.classList.add('doomed')

  const modes = el('div', 'rewind-modes')
  modes.setAttribute('role', 'radiogroup')
  modes.setAttribute('aria-label', 'What goes back')
  for (const option of MODES) {
    const button = el('button', 'rewind-mode', option.label)
    button.type = 'button'
    button.setAttribute('role', 'radio')
    button.setAttribute('aria-checked', String(option.mode === mode))
    button.tabIndex = option.mode === mode ? 0 : -1
    button.dataset.mode = option.mode
    if (option.mode === 'code' && files.length === 0) {
      button.disabled = true
      button.title = 'No file was changed with edit or write since this turn began'
    }
    button.addEventListener('click', () => setMode(option.mode, 'mode'))
    modes.append(button)
  }

  // A held rewind of the code has files out of place. Going back over the
  // conversation alone returns them to how the rewind found them.
  const moved = held !== null && held.mode !== 'conversation'
  const summary =
    mode === 'code'
      ? `${plural(files.length, 'file')} put back as they were. The conversation stays as it is.`
      : mode === 'conversation'
        ? `${count} taken back. ${moved ? 'The files the current rewind put back return to how it found them.' : 'The files stay as they are.'}`
        : files.length === 0
          ? `${count} taken back. No file was changed with edit or write since then.`
          : `${count} and ${plural(files.length, 'file')} taken back.`
  const parts: HTMLElement[] = [el('strong', 'rewind-title', `Rewind to before turn ${turn.turn}`), modes, el('p', 'rewind-summary', summary)]
  if (mode !== 'conversation' && files.length > 0) {
    const shown = files.slice(0, 6)
    const names = el('ul', 'rewind-files')
    for (const path of shown) names.append(el('li', undefined, path))
    if (files.length > shown.length) names.append(el('li', 'rewind-more', `and ${files.length - shown.length} more`))
    parts.push(names)
  }
  if (mode !== 'code') parts.push(el('p', 'rewind-note', 'Its message goes back into the composer, to send again or change first.'))
  if (mode !== 'conversation' && files.length > 0) parts.push(el('p', 'rewind-note', 'Only edits made with edit and write are put back. Commands the agent ran and changes made outside the app stay.'))

  const keys = el('span', 'rewind-keys')
  keys.append(el('kbd', undefined, 'Enter'), ' rewind ', el('kbd', undefined, 'Esc'), ' cancel ', el('kbd', undefined, '← →'), ' what goes back')
  const cancel = el('button', 'btn sm outline rewind-cancel', 'Cancel')
  cancel.type = 'button'
  cancel.addEventListener('click', closePreview)
  const go = el('button', 'btn sm primary rewind-go', 'Rewind')
  go.type = 'button'
  go.addEventListener('click', confirmPreview)
  const actions = el('div', 'rewind-actions')
  actions.append(keys, cancel, go)
  parts.push(actions)
  card.replaceChildren(...parts)
}

/** Pick what goes back, keeping the focus on the choices or on the Rewind button, wherever it was. */
function setMode(mode: RewindMode, focus: 'mode' | 'go'): void {
  if (preview === null || (mode === 'code' && preview.turn.files.length === 0)) return
  preview.mode = mode
  renderPreview()
  const target = focus === 'mode' ? `.rewind-mode[data-mode="${mode}"]` : '.rewind-go'
  preview.card.querySelector<HTMLElement>(target)?.focus({ preventScroll: true })
}

function onPreviewKey(event: KeyboardEvent): void {
  if (preview === null) return
  const target = event.target as HTMLElement
  const focus = target.classList.contains('rewind-mode') ? 'mode' : 'go'
  const open = MODES.filter(option => option.mode !== 'code' || preview?.turn.files.length !== 0).map(option => option.mode)
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const step = event.key === 'ArrowRight' ? 1 : open.length - 1
    const next = open[(open.indexOf(preview.mode) + step) % open.length]
    if (next !== undefined) setMode(next, focus)
  } else if (event.key === '1' || event.key === '2' || event.key === '3') {
    const option = MODES[Number(event.key) - 1]
    if (option !== undefined) setMode(option.mode, focus)
  } else if (event.key === 'Enter' && !target.classList.contains('rewind-cancel')) {
    event.preventDefault()
    confirmPreview()
  }
}

function confirmPreview(): void {
  if (preview === null) return
  const { turn, mode } = preview
  closePreview()
  void rewind(turn, mode)
}

/**
 * Go back to before `target`, or with null undo the held rewind. The files
 * move at once. The conversation is cut when the next message keeps the rewind.
 */
async function rewind(target: CheckpointView | null, mode: RewindMode): Promise<void> {
  const id = host.ready()
  if (id === null || id !== sessionId || working) return
  closePreview()
  working = true
  host.stream.classList.add('rewinding')
  try {
    const out = await host.bridge.rewind({ sessionId: id, checkpointId: target?.id ?? null, mode })
    if (sessionId !== id) return
    for (const node of host.stream.querySelectorAll('.block.dropped')) node.classList.remove('dropped')
    held = target === null ? null : { checkpointId: target.id, mode }
    const put = fill(out.prompt)
    for (const miss of out.failed) host.report(`Could not restore ${miss.path}: ${miss.reason}`)
    draw()
    // The button that started this may be hidden or gone now. The message put
    // back is what the user edits next; otherwise Undo, or the composer once
    // there is nothing to undo.
    const bar = host.stream.querySelector<HTMLElement>('.rewind-bar')
    bar?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const undo = bar?.querySelector('button')
    if (put) host.draft.focus()
    else if (!visible(document.activeElement)) {
      if (undo === null || undo === undefined) host.draft.focus()
      else undo.focus({ preventScroll: true })
    }
  } catch (err) {
    host.report(message(err))
  } finally {
    working = false
    host.stream.classList.remove('rewinding')
  }
}

function visible(node: Element | null): boolean {
  return node !== null && node !== document.body && node.isConnected && node.checkVisibility()
}

/**
 * Put the taken-back message in the composer, unless the user has typed
 * something of their own there. True when the composer now holds the message.
 */
function fill(prompt: string | undefined): boolean {
  const current = host.draft.get()
  if (current !== '' && current !== filled) return false
  if (prompt !== undefined) {
    host.draft.set(prompt)
    filled = prompt
    return true
  }
  if (filled !== null) {
    host.draft.set('')
    filled = null
  }
  return false
}

// ── the index ──────────────────────────────────────────────────────────

const strip = el('div', 'ti-strip')
const panel = el('div', 'ti-panel')
const filter = el('input', 'ti-filter')
const list = el('ol', 'ti-list')
const empty = el('p', 'ti-empty', 'No turn matches.')

/** The turns in sight, oldest first, each with its message on screen. */
let order: { turn: CheckpointView; block: HTMLElement }[] = []
/** The turns the list shows, which the filter narrows. */
let shown: CheckpointView[] = []
let cursor = -1
/** The turn being read. */
let currentId: string | null = null
/** Closed, open under the pointer, or open from the keyboard with the focus in it. */
let state: 'closed' | 'hover' | 'keys' = 'closed'
/** Where the flow was scrolled when the keyboard opened the index, for Esc to go back to. */
let origin = 0
/** What had the focus when the keyboard opened the index. */
let returnTo: Element | null = null
let opening: ReturnType<typeof setTimeout> | null = null
let closing: ReturnType<typeof setTimeout> | null = null

function buildIndex(): void {
  const nav = host.index
  filter.type = 'search'
  filter.placeholder = 'Filter turns'
  filter.setAttribute('aria-label', 'Filter turns')
  filter.setAttribute('role', 'combobox')
  filter.setAttribute('aria-expanded', 'true')
  filter.setAttribute('aria-controls', 'ti-list')
  list.id = 'ti-list'
  list.tabIndex = 0
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Turns')
  empty.hidden = true
  const keys = el('footer', 'ti-keys')
  for (const [key, does] of [
    ['↑↓', 'move'],
    ['Enter', 'stay'],
    ['Esc', 'back'],
    ['r', 'rewind…'],
    ['/', 'filter'],
  ]) {
    const pair = el('span')
    pair.append(el('kbd', undefined, key), ` ${does}`)
    keys.append(pair)
  }
  panel.append(filter, list, empty, keys)
  nav.append(panel, strip)

  // A short wait before opening, so a pointer on its way across the window
  // does not throw the list open.
  strip.addEventListener('pointerenter', () => {
    if (closing !== null) clearTimeout(closing)
    closing = null
    opening ??= setTimeout(() => {
      opening = null
      openIndex('hover')
    }, 120)
  })
  nav.addEventListener('pointerenter', () => {
    if (closing !== null) clearTimeout(closing)
    closing = null
  })
  nav.addEventListener('pointerleave', () => {
    if (opening !== null) clearTimeout(opening)
    opening = null
    if (state === 'hover') closing = setTimeout(() => closeIndex(true), 250)
  })
  // A click in the list leaves the focus where it is, so the keys still work after it.
  panel.addEventListener('mousedown', event => {
    if (event.target !== filter) event.preventDefault()
  })
  nav.addEventListener('focusout', event => {
    if (state === 'keys' && !nav.contains(event.relatedTarget as Node | null)) closeIndex(true)
  })
  nav.addEventListener('keydown', onIndexKey)
  filter.addEventListener('input', () => {
    renderRows()
    move(0)
  })
}

/** Open the index from the keyboard, on the turn being read. */
export function openTurnIndex(): void {
  if (sessionId === null || host.index.hidden) return
  openIndex('keys')
}

function stopTimers(): void {
  if (opening !== null) clearTimeout(opening)
  if (closing !== null) clearTimeout(closing)
  opening = null
  closing = null
}

function openIndex(mode: 'hover' | 'keys'): void {
  if (state === 'keys' || state === mode) return
  stopTimers()
  state = mode
  host.index.classList.add('open')
  host.index.classList.toggle('keys', mode === 'keys')
  const at = shown.findIndex(turn => turn.id === currentId)
  if (mode === 'keys') {
    origin = host.stream.scrollTop
    returnTo = document.activeElement
    list.focus({ preventScroll: true })
    move(at === -1 ? shown.length - 1 : at)
  } else {
    rowOf(currentId)?.scrollIntoView({ block: 'center' })
  }
}

/** Close the index. Opened from the keyboard, `stay` false scrolls the flow back to where it was. */
function closeIndex(stay: boolean): void {
  stopTimers()
  if (state === 'closed') return
  const keys = state === 'keys'
  state = 'closed'
  host.index.classList.remove('open', 'keys')
  cursor = -1
  for (const row of list.children) row.setAttribute('aria-selected', 'false')
  list.removeAttribute('aria-activedescendant')
  filter.removeAttribute('aria-activedescendant')
  for (const node of host.stream.querySelectorAll('.block.turn-focus')) node.classList.remove('turn-focus')
  if (filter.value !== '') {
    filter.value = ''
    renderRows()
  }
  if (!keys) return
  if (!stay) host.stream.scrollTo({ top: origin, behavior: 'auto' })
  const focused = document.activeElement
  if (host.index.contains(focused)) {
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true })
    else if (focused instanceof HTMLElement) focused.blur()
  }
  returnTo = null
}

/** Beside the flow, from its top to the spacer at its end. */
function placeIndex(): void {
  const { stream, tail, index } = host
  index.style.top = `${stream.offsetTop}px`
  index.style.height = `${Math.max(0, stream.clientHeight - tail.offsetHeight)}px`
}

/** Rebuild the marks and the list from the turns in sight. */
function drawIndex(): void {
  const blocks = new Map<string, HTMLElement>()
  for (const block of host.stream.querySelectorAll<HTMLElement>('.block.user[data-index]:not(.dropped)')) {
    blocks.set(block.dataset.index ?? '', block)
  }
  order = []
  for (const turn of turns) {
    const block = blocks.get(String(turn.marker))
    if (block !== undefined) order.push({ turn, block })
  }
  host.index.hidden = host.stream.hidden || order.length === 0
  if (host.index.hidden) closeIndex(true)
  // One turn has nowhere to go but itself, and the list still opens from the keyboard.
  strip.hidden = order.length < 2
  strip.replaceChildren(...order.map(({ turn }) => mark(turn)))
  const kept = shown[cursor]?.id
  currentId = null
  renderRows()
  if (state === 'keys') move(Math.max(0, shown.findIndex(turn => turn.id === kept)))
  placeIndex()
  markCurrent()
}

function mark(turn: CheckpointView): HTMLElement {
  const button = el('button', 'ti-mark')
  button.type = 'button'
  // The list is the keyboard's way along the turns, so the marks stay out of the tab order.
  button.tabIndex = -1
  button.dataset.id = turn.id
  button.classList.toggle('edited', turn.edited > 0)
  button.setAttribute('aria-label', `Turn ${turn.turn}: ${turn.prompt}`)
  button.addEventListener('click', () => reveal(turn, 'smooth'))
  button.addEventListener('pointerenter', () => {
    for (const row of list.querySelectorAll('.ti-row.pointed')) row.classList.remove('pointed')
    const row = rowOf(turn.id)
    row?.classList.add('pointed')
    row?.scrollIntoView({ block: 'nearest' })
  })
  return button
}

function rowOf(id: string | null): HTMLElement | null {
  return id === null ? null : list.querySelector<HTMLElement>(`.ti-row[data-id="${id}"]`)
}

function renderRows(): void {
  const needle = filter.value.trim().toLowerCase()
  shown = order.map(({ turn }) => turn).filter(turn => needle === '' || turn.prompt.toLowerCase().includes(needle) || String(turn.turn) === needle)
  list.replaceChildren(
    ...shown.map((turn, index) => {
      const row = el('li', 'ti-row')
      row.id = `ti-row-${turn.id}`
      row.dataset.id = turn.id
      row.title = turn.prompt
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.classList.toggle('current', turn.id === currentId)
      const meta = el('span', 'ti-meta', relativeTime(turn.at))
      if (turn.edited > 0) meta.append(el('span', 'ti-files', plural(turn.edited, 'file')))
      const back = el('button', 'ti-rewind')
      back.type = 'button'
      // r does this from the keyboard, so the buttons stay out of the tab order.
      back.tabIndex = -1
      back.title = 'Rewind to before this turn…'
      back.setAttribute('aria-label', `Rewind to before turn ${turn.turn}`)
      back.append(icon(GLYPH.rewind, 13))
      back.addEventListener('click', event => {
        event.stopPropagation()
        openPreview(turn)
      })
      row.append(el('span', 'ti-num', String(turn.turn)), el('span', 'ti-prompt', turn.prompt === '' ? '(no text)' : turn.prompt), meta, back)
      row.addEventListener('click', () => {
        if (state === 'keys') move(index)
        else reveal(turn, 'smooth')
      })
      return row
    }),
  )
  empty.hidden = shown.length > 0
}

/** Select row `index` from the keyboard and bring its turn into view behind the list. */
function move(index: number): void {
  if (shown.length === 0) return
  cursor = Math.max(0, Math.min(shown.length - 1, index))
  for (const [at, row] of [...list.children].entries()) row.setAttribute('aria-selected', String(at === cursor))
  const turn = shown[cursor]
  if (turn === undefined) return
  list.setAttribute('aria-activedescendant', `ti-row-${turn.id}`)
  filter.setAttribute('aria-activedescendant', `ti-row-${turn.id}`)
  rowOf(turn.id)?.scrollIntoView({ block: 'nearest' })
  reveal(turn, 'auto')
}

function onIndexKey(event: KeyboardEvent): void {
  if (state !== 'keys' || event.ctrlKey || event.metaKey || event.altKey) return
  const typing = event.target === filter
  // Letters are read in lower case, so Caps Lock changes nothing.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  let handled = true
  if (key === 'ArrowDown' || (!typing && key === 'j')) move(cursor + 1)
  else if (key === 'ArrowUp' || (!typing && key === 'k')) move(cursor - 1)
  else if (key === 'PageDown') move(cursor + 8)
  else if (key === 'PageUp') move(cursor - 8)
  else if (!typing && key === 'Home') move(0)
  else if (!typing && key === 'End') move(shown.length - 1)
  else if (key === 'Enter') closeIndex(true)
  else if (key === 'Escape') {
    if (typing && filter.value !== '') {
      filter.value = ''
      renderRows()
      move(0)
      list.focus({ preventScroll: true })
    } else closeIndex(false)
  } else if (typing) handled = false
  else if (key === '/') filter.focus()
  else if (key === 'r') openPreview(shown[cursor])
  else handled = false
  if (handled) {
    event.preventDefault()
    // A key spent here goes no further, so the window's own listeners, such
    // as the one that closes a menu on Esc, do not act on it as well.
    event.stopPropagation()
  }
}

/** Scroll the flow to the turn and outline its message. */
function reveal(turn: CheckpointView, behavior: ScrollBehavior): void {
  const block = blockOf(turn)
  if (block === null) return
  host.stream.scrollTo({ top: offsetOf(block) - 12, behavior })
  for (const node of host.stream.querySelectorAll('.block.turn-focus')) node.classList.remove('turn-focus')
  block.classList.add('turn-focus')
}

/**
 * Where the turn being read is in `order`: the last one whose message starts
 * above a line near the top of the view, or the last turn once the flow is
 * scrolled to its end. A binary search, so a scroll reads a handful of
 * positions however long the session is.
 */
function currentIndex(): number {
  const { stream } = host
  if (order.length === 0) return -1
  if (stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 2) return order.length - 1
  const line = stream.getBoundingClientRect().top + Math.min(120, stream.clientHeight / 3)
  let low = 0
  let high = order.length - 1
  let at = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((order[mid]?.block.getBoundingClientRect().top ?? Infinity) <= line) {
      at = mid
      low = mid + 1
    } else high = mid - 1
  }
  return at
}

/** Light the turn being read, in the marks and in the list, as the flow scrolls. */
function markCurrent(): void {
  const id = order[currentIndex()]?.turn.id ?? null
  if (id === currentId) return
  currentId = id
  for (const node of strip.children) node.classList.toggle('current', (node as HTMLElement).dataset.id === id)
  for (const row of list.children) row.classList.toggle('current', (row as HTMLElement).dataset.id === id)
  // More marks than fit scroll the column, which keeps the lit one in the middle.
  const lit = strip.querySelector<HTMLElement>('.ti-mark.current')
  if (lit !== null && strip.scrollHeight > strip.clientHeight) strip.scrollTop = lit.offsetTop - strip.clientHeight / 2
}

/** To the start of the turn before or after the one being read. Partway down a turn, up goes to its start. */
function jump(step: -1 | 1): void {
  if (sessionId === null || host.stream.hidden || order.length === 0) return
  const at = currentIndex()
  const here = order[at]
  const top = host.stream.getBoundingClientRect().top
  const target = step === -1 && here !== undefined && here.block.getBoundingClientRect().top < top - 4 ? here : order[at + step]
  if (target !== undefined) reveal(target.turn, 'smooth')
  else if (step === 1) host.stream.scrollTo({ top: host.stream.scrollHeight, behavior: 'smooth' })
}
