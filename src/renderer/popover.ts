// doc: docs/harness/ui.md

/**
 * A panel that opens under the button it belongs to. The tokens and context
 * buttons both use it, in the topbar and in the subagent head.
 *
 * The panel lives at the end of `<body>` and is placed with fixed coordinates,
 * because the topbar clips what overflows it. It closes on Escape, on a click
 * anywhere outside it and when another one opens. Escape is caught before the
 * composer sees it, where it would otherwise also stop the running turn.
 */

const GAP = 6
const MARGIN = 8

/** Every panel the window has, so opening one can close the others. */
const panels = new Set<Popover>()

/** Close whichever panel is open, for a change of view that leaves it describing nothing. */
export function closePopover(): void {
  for (const panel of panels) panel.close()
}

export class Popover {
  private shown = false

  constructor(
    private readonly button: HTMLElement,
    readonly panel: HTMLElement,
    /** Called each time the panel opens, so it is drawn from what is current. */
    private readonly onOpen?: () => void,
  ) {
    panels.add(this)
    panel.hidden = true
    button.setAttribute('aria-haspopup', 'dialog')
    button.setAttribute('aria-expanded', 'false')
    if (panel.id !== '') button.setAttribute('aria-controls', panel.id)
    button.addEventListener('click', () => {
      if (this.shown) this.close()
      else this.open()
    })
    document.addEventListener('pointerdown', event => {
      const target = event.target
      if (!this.shown || !(target instanceof Node)) return
      if (!panel.contains(target) && !button.contains(target)) this.close()
    })
    document.addEventListener(
      'keydown',
      event => {
        if (!this.shown || event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        this.close()
        button.focus()
      },
      true,
    )
    window.addEventListener('resize', () => {
      if (this.shown) this.place()
    })
  }

  get isOpen(): boolean {
    return this.shown
  }

  open(): void {
    for (const other of panels) if (other !== this) other.close()
    this.shown = true
    this.onOpen?.()
    this.panel.hidden = false
    this.button.setAttribute('aria-expanded', 'true')
    this.place()
  }

  close(): void {
    if (!this.shown) return
    this.shown = false
    this.panel.hidden = true
    this.button.setAttribute('aria-expanded', 'false')
  }

  /** Under the button, right edges lined up, and kept inside the window. */
  private place(): void {
    const anchor = this.button.getBoundingClientRect()
    const width = this.panel.offsetWidth
    const left = Math.min(Math.max(MARGIN, anchor.right - width), window.innerWidth - width - MARGIN)
    this.panel.style.left = `${Math.max(MARGIN, left)}px`
    this.panel.style.top = `${anchor.bottom + GAP}px`
    this.panel.style.maxHeight = `${window.innerHeight - anchor.bottom - GAP - MARGIN}px`
  }
}
