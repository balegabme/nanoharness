// doc: docs/harness/ui.md
import { must } from './dom.js'

/**
 * The composer is one element in two seats. Before a session exists it sits in
 * the middle of the hero; once one is open it moves into the dock that floats
 * over the bottom of the flow. The node is moved and no second copy is
 * mounted, which keeps a half-written message, and the caret, across the move.
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
 * tail spacer is written from the card's measured height and never a guess,
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

/**
 * Hide the docked card without unseating it. A subagent's view is the one place
 * a session is open and there is nothing to type into: the subagent was given
 * its whole task when it started and answers once.
 */
export function showDock(visible: boolean): void {
  if (composer.parentElement !== dock) return
  dock.hidden = !visible
}

export function initComposer(): void {
  input.addEventListener('input', autoGrow)
  // A window resize rewraps the draft, which changes its height.
  addEventListener('resize', autoGrow)
  autoGrow()
}
