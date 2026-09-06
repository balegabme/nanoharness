// doc: docs/harness/ui.md
import { must } from './dom.js'

/**
 * The composer is one element in two seats. Before a session exists it sits in
 * the middle of the hero; once one is open it moves into the dock that floats
 * over the bottom of the flow. Moving the node rather than mounting a second
 * copy is what keeps a half-written message — and the caret — across the move.
 */

const composer = must<HTMLFormElement>('composer')
const input = must<HTMLTextAreaElement>('input')
const heroSeat = must<HTMLElement>('hero-seat')
const dock = must<HTMLElement>('composer-dock')
const stream = must<HTMLElement>('stream')

/**
 * The textarea is never its own scroller: it is exactly as tall as its text and
 * `.composer-text` around it does the scrolling once the 14-line cap is
 * reached. One scrolling box means the caret and the glyphs cannot drift apart.
 */
export function autoGrow(): void {
  input.style.height = '0px'
  input.style.height = `${input.scrollHeight}px`
  measure()
}

/**
 * The docked card floats over the flow, so the flow has to end above it. The
 * tail spacer is written from the card's measured height rather than a guess,
 * which keeps the last message clear of the card at any composer height.
 */
function measure(): void {
  if (composer.parentElement !== dock) return
  const height = composer.getBoundingClientRect().height
  stream.style.setProperty('--nh-composer-clearance', `${Math.round(height) + 28}px`)
}

/** `docked` = a session is open and the card belongs over the flow. */
export function seat(docked: boolean): void {
  const target = docked ? dock : heroSeat
  if (composer.parentElement !== target) target.append(composer)
  dock.hidden = !docked
  measure()
}

export function initComposer(): void {
  input.addEventListener('input', autoGrow)
  // A window resize rewraps the draft, which changes its height.
  addEventListener('resize', autoGrow)
  autoGrow()
}
