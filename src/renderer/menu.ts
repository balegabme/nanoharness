// doc: docs/harness/ui.md
import { el } from './dom.js'

/**
 * The right-click menu. One is open at a time, it is a real element in the
 * window rather than an OS menu, and it closes on the next thing the user does:
 * a click anywhere, Esc, a scroll, a resize.
 *
 * It is here rather than in `sidebar.ts` because the sidebar is not the only
 * place a row will want one, and a second copy of "position a box near the
 * pointer without letting it fall off the screen" is exactly the sort of thing
 * that ends up subtly different in each copy.
 */

export interface MenuItem {
  label: string
  run(): void | Promise<void>
  /** Destructive: drawn in the danger colour and set apart from what precedes it. */
  danger?: boolean
}

let open: HTMLElement | null = null

export function closeMenu(): void {
  open?.remove()
  open = null
}

/** Margin kept between the menu and the window edge when it has to be nudged. */
const EDGE = 8

export function openMenu(x: number, y: number, items: readonly MenuItem[]): void {
  closeMenu()
  if (items.length === 0) return

  const menu = el('div', 'context-menu')
  menu.setAttribute('role', 'menu')
  for (const item of items) {
    const button = el('button', item.danger === true ? 'context-item danger' : 'context-item', item.label)
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.addEventListener('click', () => {
      closeMenu()
      void item.run()
    })
    menu.append(button)
  }

  // Laid out off-screen first, because where it fits cannot be known until it
  // has a size, and a menu that flickers into place has already been seen.
  menu.style.left = '-9999px'
  menu.style.top = '-9999px'
  document.body.append(menu)
  open = menu

  const box = menu.getBoundingClientRect()
  const left = Math.max(EDGE, Math.min(x, window.innerWidth - box.width - EDGE))
  const top = Math.max(EDGE, Math.min(y, window.innerHeight - box.height - EDGE))
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  menu.querySelector('button')?.focus()
}

// Capture, so a menu closes before the click underneath it is acted on: a menu
// left standing over a row the user has already moved past is the one bug this
// kind of thing always has.
addEventListener('pointerdown', event => {
  if (open !== null && !open.contains(event.target as Node)) closeMenu()
}, true)
addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenu()
})
addEventListener('resize', closeMenu)
addEventListener('scroll', closeMenu, true)
