// doc: docs/harness/ui.md
import { diffRows } from './diff-rows.js'
import { el } from './dom.js'
import { grammarFor, highlight } from './highlight.js'

/**
 * The Markdown a model writes, drawn as the page it describes: headings,
 * lists, tables, quotes, rules, and code in coloured blocks with a copy
 * button. It covers what models actually send and leaves the rest of
 * CommonMark alone: no setext headings, no indented code blocks, no reference
 * links. Raw HTML is shown as the text it is.
 *
 * Every node is built with `createElement` and text nodes, never `innerHTML`,
 * so nothing a model writes can become markup the window runs. An unclosed
 * fence or a half-typed table draws sensibly, since a streaming answer is
 * drawn while it is still arriving.
 */

/** What a drawn page needs from the window around it. */
export interface MarkdownHost {
  /** Open an http(s) link in the user's browser. */
  openLink(url: string): void
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>[ ]?(.*)$/
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const TASK = /^\[([ xX])\][ \t]+/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === ''
}

function isTableStart(lines: readonly string[], i: number): boolean {
  return (lines[i] ?? '').includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('|')
}

/**
 * Whether a line starts a block of its own and so ends the paragraph above it.
 * An ordered item interrupts only when it is numbered 1, so a sentence that
 * happens to wrap onto "2019. The year" is not a list.
 */
function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? ''
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || isTableStart(lines, i)) return true
  const item = ITEM.exec(line)
  return item !== null && item[4] !== undefined && item[4].trim() !== '' && (/^[-*+]$/.test(item[2] ?? '') || /^1[.)]$/.test(item[2] ?? ''))
}

export function renderMarkdown(source: string, host: MarkdownHost): DocumentFragment {
  try {
    return blocks(source.replace(/\r\n?/g, '\n').split('\n'), host)
  } catch (err) {
    // Quotes and lists recurse once per level, so text nested thousands deep
    // runs out of stack. It is shown as the text it is.
    if (!(err instanceof RangeError)) throw err
    const out = document.createDocumentFragment()
    out.append(el('p', undefined, source))
    return out
  }
}

/** A fence opening or closing at any indent, which is how deep a list item can hold one. */
const ANY_FENCE = /^\s*(`{3,}|~{3,})(.*)$/

/**
 * How much of `text`, from `from` on, is settled: the length up to the last
 * blank line that sits outside a fence. More text arriving cannot change how
 * the blocks before that line are drawn, so a streaming answer draws them once
 * and redraws only what follows. `from` must itself be such a point.
 */
export function settledLength(text: string, from: number): number {
  let settled = from
  let fence: string | null = null
  let at = from
  while (true) {
    const end = text.indexOf('\n', at)
    if (end === -1) return settled
    const line = text.slice(at, end)
    const mark = ANY_FENCE.exec(line)
    if (fence === null) {
      if (mark !== null) fence = mark[1] ?? null
      else if (line.trim() === '') settled = end + 1
    } else if (mark !== null && mark[1]?.[0] === fence[0] && (mark[1]?.length ?? 0) >= fence.length && mark[2]?.trim() === '') fence = null
    at = end + 1
  }
}

function blocks(lines: readonly string[], host: MarkdownHost): DocumentFragment {
  const out = document.createDocumentFragment()
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (isBlank(line)) {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const indent = fence[1]?.length ?? 0
      const marker = fence[2] ?? '```'
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
      const body: string[] = []
      i += 1
      while (i < lines.length && !close.test(lines[i] ?? '')) {
        const next = lines[i] ?? ''
        body.push(next.slice(Math.min(indent, indentOf(next))))
        i += 1
      }
      i += 1
      out.append(codeBlock(body.join('\n'), fence[3] ?? ''))
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      const node = el(`h${heading[1]?.length ?? 1}` as 'h1')
      inline(heading[2] ?? '', node, host)
      out.append(node)
      i += 1
      continue
    }

    if (RULE.test(line)) {
      out.append(el('hr'))
      i += 1
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i] ?? '')
        if (quoted === null) break
        inner.push(quoted[1] ?? '')
        i += 1
      }
      const quote = el('blockquote')
      quote.append(blocks(inner, host))
      out.append(quote)
      continue
    }

    if (isTableStart(lines, i)) {
      i = table(lines, i, out, host)
      continue
    }

    if (ITEM.test(line)) {
      i = list(lines, i, out, host)
      continue
    }

    const para: string[] = [line.trim()]
    i += 1
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      para.push((lines[i] ?? '').trim())
      i += 1
    }
    const node = el('p')
    inline(para.join('\n'), node, host)
    out.append(node)
  }
  return out
}

/** A fenced block: its language, a copy button, and the code coloured when the language is one `highlight.ts` knows. */
function codeBlock(code: string, language: string): HTMLElement {
  const wrap = el('div', 'md-code')
  const head = el('div', 'md-code-head')
  const copy = el('button', 'md-code-copy', 'Copy')
  copy.type = 'button'
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(code).then(
      () => (copy.textContent = 'Copied'),
      () => (copy.textContent = 'Copy failed'),
    )
  })
  head.append(el('span', 'md-code-lang', language === '' ? 'text' : language), copy)
  const lang = language.toLowerCase()
  if (lang === 'diff' || lang === 'patch') {
    wrap.append(head, diffRows(code))
    return wrap
  }
  const pre = el('pre')
  const body = el('code')
  body.append(highlight(code, grammarFor(lang)))
  pre.append(body)
  wrap.append(head, pre)
  return wrap
}

/** One row of a table split into cells, on pipes that are neither escaped nor inside a code span. */
function cells(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const out: string[] = []
  let cell = ''
  let code = false
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i] ?? ''
    if (char === '\\' && row[i + 1] === '|') {
      cell += '|'
      i += 1
    } else if (char === '`') {
      code = !code
      cell += char
    } else if (char === '|' && !code) {
      out.push(cell.trim())
      cell = ''
    } else cell += char
  }
  out.push(cell.trim())
  return out
}

function table(lines: readonly string[], start: number, out: DocumentFragment, host: MarkdownHost): number {
  const header = cells(lines[start] ?? '')
  const aligns = cells(lines[start + 1] ?? '').map(rule =>
    rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : rule.startsWith(':') ? 'left' : '',
  )
  const row = (values: readonly string[], tag: 'th' | 'td'): HTMLTableRowElement => {
    const tr = el('tr')
    for (let c = 0; c < header.length; c += 1) {
      const cell = el(tag)
      const align = aligns[c] ?? ''
      if (align !== '') cell.style.textAlign = align
      inline(values[c] ?? '', cell, host)
      tr.append(cell)
    }
    return tr
  }
  const head = el('thead')
  head.append(row(header, 'th'))
  const body = el('tbody')
  let i = start + 2
  while (i < lines.length && !isBlank(lines[i]) && (lines[i] ?? '').includes('|')) {
    body.append(row(cells(lines[i] ?? ''), 'td'))
    i += 1
  }
  const grid = el('table')
  grid.append(head, body)
  // Wide tables scroll inside their own frame instead of widening the flow.
  const frame = el('div', 'md-table')
  frame.append(grid)
  out.append(frame)
  return i
}

/**
 * A list and everything nested in it. A line indented past the list's own
 * margin belongs to the item above it, and that item's lines are drawn as
 * blocks of their own, which is how a nested list or a code block inside an
 * item comes out right.
 */
function list(lines: readonly string[], start: number, out: DocumentFragment, host: MarkdownHost): number {
  const first = ITEM.exec(lines[start] ?? '')
  const margin = first?.[1]?.length ?? 0
  const ordered = /\d/.test(first?.[2] ?? '')
  const node = ordered ? el('ol') : el('ul')
  if (ordered) {
    const number = Number.parseInt(first?.[2] ?? '1', 10)
    if (number !== 1) (node as HTMLOListElement).start = number
  }
  const items: string[][] = []
  let content = 0
  let loose = false
  let i = start
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (isBlank(line)) {
      let next = i + 1
      while (next < lines.length && isBlank(lines[next])) next += 1
      const after = lines[next]
      if (after === undefined) break
      const sibling = ITEM.exec(after)
      const continues = indentOf(after) > margin || (sibling !== null && (sibling[1]?.length ?? 0) <= margin && /\d/.test(sibling[2] ?? '') === ordered)
      if (!continues) break
      loose = true
      items[items.length - 1]?.push('')
      i += 1
      continue
    }
    const item = ITEM.exec(line)
    const indent = indentOf(line)
    if (item !== null && indent <= margin && /\d/.test(item[2] ?? '') === ordered) {
      const pad = Math.min(Math.max(item[3]?.length ?? 1, 1), 4)
      content = indent + (item[2]?.length ?? 1) + pad
      items.push([item[4] ?? ''])
    } else if (indent > margin) {
      items[items.length - 1]?.push(line.slice(Math.min(indent, content)))
    } else if (!isBlank(lines[i - 1]) && !startsBlock(lines, i) && !ITEM.test(line)) {
      // A paragraph that runs on without its indent still belongs to the item.
      items[items.length - 1]?.push(line.trim())
    } else break
    i += 1
  }
  if (!loose) node.classList.add('tight')
  for (const itemLines of items) {
    const li = el('li')
    const task = TASK.exec(itemLines[0] ?? '')
    if (task !== null) itemLines[0] = (itemLines[0] ?? '').slice(task[0].length)
    li.append(blocks(itemLines, host))
    if (task !== null) {
      const box = el('input')
      box.type = 'checkbox'
      box.disabled = true
      box.checked = task[1] !== ' '
      li.classList.add('task')
      // Inside the item's first paragraph, so the box sits on the line it ticks.
      const first = li.firstElementChild
      if (first instanceof HTMLParagraphElement) first.prepend(box)
      else li.prepend(box)
    }
    node.append(li)
  }
  out.append(node)
  return i
}

const PUNCTUATION = /[!-/:-@[-`{-~]/
const BARE_URL = /https?:\/\/[^\s<>]+/y
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/y

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char)
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char)
}

/** How many times `char` repeats from `at`. */
function runOf(text: string, at: number, char: string): number {
  let end = at
  while (text[end] === char) end += 1
  return end - at
}

/**
 * Where a run of exactly `size` `char`s closes the one opened before `from`,
 * or -1. Runs of another length are stepped over whole, so `**` inside a `*`
 * span neither closes it nor is split by it, and code spans are skipped.
 */
function closer(text: string, from: number, char: string, size: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] === '`') {
      const ticks = runOf(text, i, '`')
      const end = text.indexOf('`'.repeat(ticks), i + ticks)
      i = end !== -1 && runOf(text, end, '`') === ticks ? end + ticks : i + ticks
      continue
    }
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === char) {
      const run = runOf(text, i, char)
      const flanked = !isSpace(text[i - 1]) && (char !== '_' || !isWordChar(text[i + run]))
      if (run === size && flanked && i > from) return i
      i += run
      continue
    }
    i += 1
  }
  return -1
}

/**
 * Where each bracket or parenthesis in `text` closes, by where it opens,
 * counting nesting. One pass finds every pair, so a line of unmatched brackets
 * costs one scan and not one per bracket.
 */
function pairs(text: string, left: string, right: string): Map<number, number> {
  const found = new Map<number, number>()
  const open: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\\') i += 1
    else if (char === left) open.push(i)
    else if (char === right) {
      const start = open.pop()
      if (start !== undefined) found.set(start, i)
    }
  }
  return found
}

function link(url: string, into: Node, host: MarkdownHost, label: (anchor: HTMLElement) => void): void {
  if (!/^https?:\/\//i.test(url)) {
    // A relative path or another scheme has nowhere to go from the window, so
    // it stays text and says where it pointed.
    const span = el('span', 'md-ref')
    span.title = url
    label(span)
    into.appendChild(span)
    return
  }
  const anchor = el('a', 'md-link')
  anchor.href = url
  anchor.title = url
  anchor.addEventListener('click', event => {
    event.preventDefault()
    host.openLink(url)
  })
  label(anchor)
  into.appendChild(anchor)
}

/**
 * Inline Markdown: code spans, emphasis, strikethrough, links and bare URLs. A
 * newline is kept as a line break, since chat text is not wrapped at a column
 * and a newline inside a paragraph is one the writer meant. A link's own label
 * is `linked`, and no link is looked for inside it, because a link in a link
 * would open twice on one click.
 */
function inline(text: string, into: Node, host: MarkdownHost, linked = false): void {
  let plain = ''
  const flush = (): void => {
    if (plain !== '') into.appendChild(document.createTextNode(plain))
    plain = ''
  }
  // Where a search for each kind of closing run already came up empty. A
  // search from further on covers less of the same text and cannot do better,
  // so a line of unmatched asterisks costs one scan and not one per asterisk.
  const unclosed = new Map<string, number>()
  let brackets: Map<number, number> | null = null
  let parens: Map<number, number> | null = null

  let i = 0
  while (i < text.length) {
    const char = text[i] ?? ''

    if (char === '\n') {
      flush()
      into.appendChild(el('br'))
      i += 1
      continue
    }

    if (char === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) {
      plain += text[i + 1]
      i += 2
      continue
    }

    if (char === '`') {
      const ticks = runOf(text, i, '`')
      const end = text.indexOf('`'.repeat(ticks), i + ticks)
      if (end !== -1 && runOf(text, end, '`') === ticks) {
        flush()
        let code = text.slice(i + ticks, end).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
        into.appendChild(el('code', undefined, code))
        i = end + ticks
        continue
      }
      plain += '`'.repeat(ticks)
      i += ticks
      continue
    }

    if (!linked && (char === '[' || (char === '!' && text[i + 1] === '['))) {
      const open = char === '!' ? i + 1 : i
      brackets ??= pairs(text, '[', ']')
      const close = brackets.get(open)
      if (close !== undefined && text[close + 1] === '(') {
        parens ??= pairs(text, '(', ')')
        const end = parens.get(close + 1)
        if (end !== undefined) {
          flush()
          const target = text.slice(close + 2, end).trim().replace(/\s+["'(].*$/, '').replace(/^<(.*)>$/, '$1')
          const label = text.slice(open + 1, close)
          // A picture from anywhere but the app itself is blocked by the page's
          // policy, so an image reference is drawn as a link to it.
          link(target, into, host, anchor => inline(label === '' && char === '!' ? 'image' : label, anchor, host, true))
          i = end + 1
          continue
        }
      }
    }

    if (char === '<' && !linked) {
      AUTOLINK.lastIndex = i
      const auto = AUTOLINK.exec(text)
      if (auto !== null) {
        flush()
        const url = auto[1] ?? ''
        link(url, into, host, anchor => anchor.append(url))
        i += auto[0].length
        continue
      }
    }

    if (char === 'h' && !linked && !isWordChar(text[i - 1])) {
      BARE_URL.lastIndex = i
      const bare = BARE_URL.exec(text)
      if (bare !== null) {
        let url = bare[0].replace(/[.,;:!?'"]+$/, '')
        // A URL in parentheses keeps its closing one outside the link.
        if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1)
        flush()
        link(url, into, host, anchor => anchor.append(url))
        i += url.length
        continue
      }
    }

    if (char === '*' || char === '_' || char === '~') {
      const run = runOf(text, i, char)
      const opens = !isSpace(text[i + run]) && (char !== '_' || !isWordChar(text[i - 1]))
      const size = char === '~' ? 2 : Math.min(run, 3)
      const kind = char + String(size)
      if (opens && run === size && i + run < (unclosed.get(kind) ?? Infinity)) {
        const end = closer(text, i + run, char, size)
        if (end === -1) unclosed.set(kind, i + run)
        else {
          flush()
          const node = el(char === '~' ? 'del' : size === 1 ? 'em' : 'strong')
          // Three of a kind is both at once.
          const target = size === 3 ? node.appendChild(el('em')) : node
          inline(text.slice(i + run, end), target, host, linked)
          into.appendChild(node)
          i = end + run
          continue
        }
      }
      plain += char.repeat(run)
      i += run
      continue
    }

    plain += char
    i += 1
  }
  flush()
}
