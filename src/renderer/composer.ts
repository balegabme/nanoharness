// doc: docs/harness/ui.md
import { el, GLYPH, icon, message, must } from './dom.js'
import { IMAGES_PER_MESSAGE, prepare } from './images.js'
import type { Attachment } from './images.js'

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
const tray = must<HTMLElement>('attachments')
const note = must<HTMLElement>('attach-note')

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

/** The pictures attached to the draft, in the order they were added. */
let attached: Attachment[] = []

/**
 * The pastes and drops still being read. They are read one after another, so
 * the limit is checked against a count no other paste is about to change.
 */
let reading: Promise<void> = Promise.resolve()

/** The pictures attached to the draft, once every paste and drop so far is in. */
export async function attachments(): Promise<readonly Attachment[]> {
  await reading
  return attached
}

export function clearAttachments(): void {
  attached = []
  drawTray()
  attachNote(null)
}

/** A line under the draft about the pictures, or nothing when `text` is null. */
export function attachNote(text: string | null): void {
  note.textContent = text ?? ''
  note.hidden = text === null
  measure()
}

/**
 * Add pictures to the draft. A file that cannot be attached is named in the
 * note with the reason, and the rest are still added.
 */
async function attach(files: readonly File[], shrink: boolean): Promise<void> {
  attachNote(null)
  for (const file of files) {
    if (attached.length >= IMAGES_PER_MESSAGE) {
      attachNote(`One message can carry ${IMAGES_PER_MESSAGE} images at most.`)
      return
    }
    try {
      attached.push(await prepare(file, shrink))
      drawTray()
    } catch (err) {
      attachNote(`${file.name === '' ? 'The pasted picture' : file.name} was not attached: ${message(err)}`)
    }
  }
}

function queue(files: readonly File[], shrink: boolean): void {
  reading = reading.then(() => attach(files, shrink))
}

/**
 * The chips over the draft. Each is named by its place in the message, which
 * is the order the model receives them in, so "Image #2" in the text means the
 * second chip.
 */
function drawTray(): void {
  tray.replaceChildren(...attached.map((item, index) => chip(item, `Image #${index + 1}`)))
  tray.hidden = attached.length === 0
  measure()
}

function chip(item: Attachment, name: string): HTMLElement {
  const wrap = el('span', 'attachment')
  wrap.title = `${name}, ${item.view.width} × ${item.view.height}`
  const thumb = el('img')
  thumb.src = item.view.src
  thumb.alt = ''
  const remove = el('button', 'attachment-remove')
  remove.type = 'button'
  remove.title = `Remove ${name}`
  remove.setAttribute('aria-label', `Remove ${name}`)
  remove.append(icon(GLYPH.close, 12))
  remove.addEventListener('click', () => {
    attached = attached.filter(other => other !== item)
    drawTray()
    attachNote(null)
    input.focus()
  })
  wrap.append(thumb, el('span', 'attachment-name', name), remove)
  return wrap
}

function hasFiles(data: DataTransfer | null): boolean {
  return data?.types.includes('Files') === true
}

/** `shrink` says whether pictures are shrunk before they are attached. It is read at each paste and drop. */
export function initComposer(shrink: () => boolean): void {
  input.addEventListener('input', autoGrow)
  // A window resize rewraps the draft, which changes its height.
  addEventListener('resize', autoGrow)
  // A paste that carries pictures along with text, as a copy from a document
  // can, attaches the pictures and still lets the text land in the draft.
  input.addEventListener('paste', event => {
    const pictures = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
    if (pictures.length > 0 && !input.readOnly) queue(pictures, shrink())
  })
  composer.addEventListener('dragover', event => {
    if (!hasFiles(event.dataTransfer) || input.readOnly) return
    event.preventDefault()
    composer.classList.add('dropping')
  })
  composer.addEventListener('dragleave', event => {
    if (!composer.contains(event.relatedTarget as Node | null)) composer.classList.remove('dropping')
  })
  composer.addEventListener('drop', event => {
    composer.classList.remove('dropping')
    if (!hasFiles(event.dataTransfer) || input.readOnly) return
    event.preventDefault()
    queue([...(event.dataTransfer?.files ?? [])], shrink())
  })
  autoGrow()
}
