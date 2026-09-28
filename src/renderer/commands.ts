// doc: docs/harness/commands.md
import { el, must } from './dom.js'
import type { SnippetView } from '../ipc/contract.js'

/**
 * The command menu. A `/` typed at the start of the draft or after a space
 * opens it, the letters after the slash narrow it, and picking an entry takes
 * the `/word` back out of the draft. The `/` button in the controls opens the
 * same menu with nothing typed.
 *
 * It lists the commands first and the snippets after them. A command is shown
 * only when it can run now, so the list never offers something that would be
 * refused. The keys are taken before the composer's own handlers see them,
 * so Enter picks an entry and does not send, and Up moves through the menu
 * and does not recall a sent message.
 */

export interface Command {
  name: string
  description: string
  available: () => boolean
  run: () => void
}

export interface CommandsOptions {
  commands: readonly Command[]
  /** The snippets the open session can use, read again each time the menu opens. */
  snippets: () => Promise<readonly SnippetView[]>
  addSnippet: (snippet: SnippetView) => void
}

type Entry = { kind: 'command'; command: Command } | { kind: 'snippet'; snippet: SnippetView }

const menu = must<HTMLElement>('command-menu')
const input = must<HTMLTextAreaElement>('input')
const button = must<HTMLButtonElement>('commands')

/** A `/word` that ends at the caret, at the start of the draft or after whitespace. */
const TOKEN = /(?:^|\s)\/([\w-]*)$/

let options: CommandsOptions | null = null
let open = false
/** Where the `/word` being typed starts, or null when the button opened the menu. */
let tokenAt: number | null = null
/** The snippets on offer, or null while they are still being read. */
let snippets: readonly SnippetView[] | null = null
let shown: Entry[] = []
let chosen = 0
/** Counts the menu's openings, so a slow snippet list for an earlier one is dropped. */
let opening = 0

export function initCommands(given: CommandsOptions): void {
  options = given
  input.addEventListener('input', follow)
  input.addEventListener('click', follow)
  input.addEventListener('blur', close)
  input.addEventListener('keydown', steer, { capture: true })
  // Kept from taking the focus, so the caret stays where the user left it.
  menu.addEventListener('mousedown', event => event.preventDefault())
  button.addEventListener('mousedown', event => event.preventDefault())
  button.addEventListener('click', () => {
    if (open) close()
    else {
      input.focus()
      show(null, '')
    }
  })
}

/**
 * Open, narrow or close the menu from what sits before the caret. Typing
 * anything other than a `/word` closes it, the menu the button opened
 * included, so Enter goes back to sending.
 */
function follow(): void {
  const { value, selectionStart, selectionEnd } = input
  const match = selectionStart === selectionEnd ? TOKEN.exec(value.slice(0, selectionStart)) : null
  if (match === null) {
    close()
    return
  }
  const query = match[1] ?? ''
  show(selectionStart - query.length - 1, query)
}

function show(at: number | null, query: string): void {
  if (options === null) return
  const wasOpen = open
  tokenAt = at
  open = true
  chosen = 0
  menu.hidden = false
  button.classList.add('on')
  draw(query)
  if (wasOpen) return
  const mine = ++opening
  void options
    .snippets()
    .catch(() => [])
    .then(list => {
      if (mine !== opening || !open) return
      snippets = list
      draw(currentQuery())
    })
}

function close(): void {
  if (!open) return
  open = false
  tokenAt = null
  snippets = null
  menu.hidden = true
  menu.replaceChildren()
  button.classList.remove('on')
}

function currentQuery(): string {
  if (tokenAt === null) return ''
  return input.value.slice(tokenAt + 1, input.selectionStart)
}

function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase())
}

function draw(query: string): void {
  const commands = (options?.commands ?? []).filter(command => command.available() && matches(command.name, query))
  const found = (snippets ?? []).filter(snippet => matches(snippet.name, query) || matches(snippet.file, query))
  shown = [...commands.map(command => ({ kind: 'command', command }) as const), ...found.map(snippet => ({ kind: 'snippet', snippet }) as const)]
  chosen = Math.min(chosen, Math.max(0, shown.length - 1))

  const rows: HTMLElement[] = []
  if (commands.length > 0) rows.push(el('div', 'command-head', 'Commands'))
  shown.forEach((entry, index) => {
    if (entry.kind === 'snippet' && (index === 0 || shown[index - 1]?.kind === 'command')) rows.push(el('div', 'command-head', 'Snippets'))
    rows.push(row(entry, index))
  })
  if (shown.length === 0 && snippets !== null) rows.push(el('div', 'command-empty', query === '' ? 'Nothing to run here yet.' : `Nothing called ${query}.`))
  menu.replaceChildren(...rows)
}

function row(entry: Entry, index: number): HTMLElement {
  const item = el('div', index === chosen ? 'command-row chosen' : 'command-row')
  item.setAttribute('role', 'option')
  item.setAttribute('aria-selected', String(index === chosen))
  if (entry.kind === 'command') {
    item.append(el('span', 'command-name', `/${entry.command.name}`), el('span', 'command-text', entry.command.description))
  } else {
    const { snippet } = entry
    item.append(
      el('span', 'command-name', snippet.name),
      el('span', 'command-text', snippet.description),
      el('span', 'command-where', where(snippet)),
    )
    item.title = snippet.body
  }
  item.addEventListener('mousemove', () => {
    if (chosen === index) return
    chosen = index
    draw(currentQuery())
  })
  item.addEventListener('click', () => pick(entry))
  return item
}

/** Which end of the message a snippet goes to, and whose it is when it did not ship with the app. */
function where(snippet: SnippetView): string {
  const end = snippet.placement === 'append' ? 'end' : 'start'
  if (snippet.source === 'built-in') return end
  return `${end} · ${snippet.source === 'user' ? 'yours' : 'project'}`
}

/** Takes the menu's keys before any other handler on the composer sees them. */
function steer(event: KeyboardEvent): void {
  if (!open || event.isComposing) return
  const take = (): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    take()
    if (shown.length === 0) return
    chosen = (chosen + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
    draw(currentQuery())
    menu.querySelector('.chosen')?.scrollIntoView({ block: 'nearest' })
  } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
    const entry = shown[chosen]
    if (entry === undefined) {
      // Enter with nothing to pick sends the draft as it is, once the
      // snippets are in and it is known that nothing matches.
      if (event.key === 'Enter' && snippets !== null) close()
      else take()
      return
    }
    take()
    pick(entry)
  } else if (event.key === 'Escape') {
    take()
    close()
  }
}

function pick(entry: Entry): void {
  if (tokenAt !== null) {
    const end = input.selectionStart
    input.setRangeText('', tokenAt, end, 'end')
    input.dispatchEvent(new Event('input'))
  }
  close()
  if (entry.kind === 'command') entry.command.run()
  else options?.addSnippet(entry.snippet)
}
