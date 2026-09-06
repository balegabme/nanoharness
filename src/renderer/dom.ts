// doc: docs/harness/ui.md

/** The one place `getElementById` is allowed to return null. */
export function must<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`renderer: #${id} is missing from index.html`)
  return found as T
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Stroked 24-grid glyphs, the one shape language the chrome uses. */
export const GLYPH = {
  chevronDown: 'm6 9 6 6 6-6',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
} as const

export function icon(d: string, size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

/**
 * Electron wraps a rejected invoke as
 * `Error invoking remote method 'x': Error: y`. The reader only wants y.
 */
export function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Sidebar timestamps: short enough to sit beside a title without wrapping. */
export function relativeTime(at: number, now = Date.now()): string {
  const ago = Math.max(0, now - at)
  if (ago < MINUTE) return 'now'
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m`
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h`
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}
