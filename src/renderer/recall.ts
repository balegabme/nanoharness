// doc: docs/harness/ui.md
import { autoGrow } from './composer.js'

/**
 * Up and Down in the composer walk back through the messages sent in the
 * session on screen, newest first, the way a shell walks its history. A walk
 * starts only from an empty composer, so a key meant to move the caret never
 * replaces a draft. Inside a recalled message of several lines the keys move
 * the caret until it reaches the first or the last line, and Down past the
 * newest message empties the composer again.
 */

interface Walk {
  sent: readonly string[]
  at: number
  /** What the walk put in the composer. Anything else there means it is over. */
  shown: string
}

let walk: Walk | null = null

export function initRecall(input: HTMLTextAreaElement, sent: () => readonly string[]): void {
  input.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return
    const { value, selectionStart, selectionEnd } = input
    if (selectionStart !== selectionEnd) return
    // Typing, sending or switching sessions changes what is in the composer,
    // and that ends the walk without anything having to say so.
    if (walk !== null && value !== walk.shown) walk = null

    if (walk === null) {
      if (event.key !== 'ArrowUp' || value !== '') return
      const all = sent()
      if (all.length === 0) return
      walk = { sent: all, at: all.length, shown: '' }
    }

    let at = walk.at
    if (event.key === 'ArrowUp') {
      if (value.slice(0, selectionStart).includes('\n')) return
      at = Math.max(0, at - 1)
    } else {
      if (value.slice(selectionEnd).includes('\n')) return
      at += 1
    }
    event.preventDefault()
    const text = walk.sent[at] ?? ''
    walk = at >= walk.sent.length ? null : { ...walk, at, shown: text }
    input.value = text
    input.setSelectionRange(text.length, text.length)
    autoGrow()
  })
}
