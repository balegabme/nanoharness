// doc: docs/harness/commands.md
import { textTokens } from '../shared/usage.js'
import { autoGrow } from './composer.js'
import { el, GLYPH, icon, must } from './dom.js'
import type { SnippetPlacement } from '../core/snippets.js'
import type { SnippetView } from '../ipc/contract.js'

/**
 * The snippets added to the draft. `prepend` ones sit above the draft and
 * `append` ones below it, in the order they will be sent, so the composer
 * reads top to bottom as the message will. Each is its own text box, edited
 * for this message only, and dragged by its chip to move it within its end
 * or across to the other one.
 */

interface Added {
  name: string
  text: string
}

const before = must<HTMLElement>('snippets-before')
const after = must<HTMLElement>('snippets-after')
const input = must<HTMLTextAreaElement>('input')

const stacks: Record<SnippetPlacement, Added[]> = { prepend: [], append: [] }

/** The block being dragged, while it is. */
let dragging: { placement: SnippetPlacement; index: number } | null = null

export function addSnippet(snippet: SnippetView): void {
  stacks[snippet.placement].push({ name: snippet.name, text: snippet.body })
  draw()
  // The caret stays in the draft, which is what the user was writing.
  input.focus()
}

export function clearSnippets(): void {
  stacks.prepend = []
  stacks.append = []
  draw()
}

/** The snippet texts above and below the draft, in the order they are on screen. */
export function snippetTexts(): { before: string[]; after: string[] } {
  return { before: stacks.prepend.map(one => one.text), after: stacks.append.map(one => one.text) }
}

function draw(): void {
  drawStack('prepend', before)
  drawStack('append', after)
  autoGrow()
}

function drawStack(placement: SnippetPlacement, host: HTMLElement): void {
  host.replaceChildren(...stacks[placement].map((added, index) => block(placement, index, added)))
  host.hidden = stacks[placement].length === 0 && dragging === null
}

function block(placement: SnippetPlacement, index: number, added: Added): HTMLElement {
  const wrap = el('div', 'snippet')
  const chip = el('div', 'snippet-chip')
  chip.draggable = true
  chip.title = 'Drag to move it'
  const cost = el('span', 'snippet-cost', `~${textTokens(added.text)} tokens`)
  const remove = el('button', 'snippet-remove')
  remove.type = 'button'
  remove.title = `Remove ${added.name}`
  remove.setAttribute('aria-label', `Remove ${added.name}`)
  remove.append(icon(GLYPH.close, 12))
  remove.addEventListener('click', () => {
    stacks[placement].splice(index, 1)
    draw()
    input.focus()
  })
  chip.append(el('span', 'snippet-grip', '⋮⋮'), el('span', 'snippet-name', added.name), cost, remove)

  const text = el('textarea', 'snippet-text')
  text.rows = 1
  text.value = added.text
  text.setAttribute('aria-label', added.name)
  text.addEventListener('input', () => {
    added.text = text.value
    cost.textContent = `~${textTokens(added.text)} tokens`
    fit(text)
  })
  // Sized once it is on the page, where it has a width to wrap at.
  requestAnimationFrame(() => fit(text))

  chip.addEventListener('dragstart', event => {
    dragging = { placement, index }
    // A type of its own, so the draft does not take the drop as text.
    event.dataTransfer?.setData('application/x-nanoharness-snippet', added.name)
    wrap.classList.add('dragged')
    // Both ends show as drop targets, the empty one included.
    before.hidden = false
    after.hidden = false
  })
  chip.addEventListener('dragend', () => {
    dragging = null
    draw()
  })
  wrap.append(chip, text)
  return wrap
}

function fit(text: HTMLTextAreaElement): void {
  text.style.height = '0px'
  text.style.height = `${text.scrollHeight}px`
  autoGrow()
}

/**
 * Where a drop over `host` lands: before the first block whose middle is
 * below the pointer, or at the end.
 */
function dropIndex(host: HTMLElement, y: number): number {
  const blocks = [...host.children]
  const at = blocks.findIndex(node => {
    const box = node.getBoundingClientRect()
    return y < box.top + box.height / 2
  })
  return at === -1 ? blocks.length : at
}

function acceptDrops(placement: SnippetPlacement, host: HTMLElement): void {
  host.addEventListener('dragover', event => {
    if (dragging === null) return
    event.preventDefault()
    host.classList.add('drop-target')
  })
  host.addEventListener('dragleave', event => {
    if (!host.contains(event.relatedTarget as Node | null)) host.classList.remove('drop-target')
  })
  host.addEventListener('drop', event => {
    host.classList.remove('drop-target')
    if (dragging === null) return
    event.preventDefault()
    const from = dragging
    const [moved] = stacks[from.placement].splice(from.index, 1)
    if (moved === undefined) return
    let to = dropIndex(host, event.clientY)
    // The block left its own stack before the drop point was counted in it.
    if (from.placement === placement && from.index < to) to -= 1
    stacks[placement].splice(to, 0, moved)
    dragging = null
    draw()
  })
}

acceptDrops('prepend', before)
acceptDrops('append', after)
