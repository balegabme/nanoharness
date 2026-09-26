// doc: docs/harness/ui.md
import { el } from './dom.js'
import { grammarFor, highlight, languageOfPath } from './highlight.js'

/** Where a hunk starts on each side and how many lines it covers: `@@ -12,4 +12,6 @@`. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The lines a diff writes about a file before its first hunk. */
const FILE_HEADER = /^(?:---|\+\+\+|diff --git |index )/

/**
 * A unified diff drawn as rows: the line's number before the change and after
 * it, the sign, and the text coloured as the file's language. The same rows go
 * in a tool card, the full-width diff view and a diff fence in an answer.
 *
 * The lines naming the file are left out, since every place that draws these
 * says which file it is. They are only looked for outside a hunk, where the
 * hunk's own counts say it has ended, so a removed line that read `-- note`
 * inside one is still drawn. Each line is coloured on its own, because the old
 * and new sides interleave, so a comment or string that spans lines is
 * coloured only where it opens.
 */
export function diffRows(text: string, path?: string): HTMLElement {
  const rules = path === undefined ? null : grammarFor(languageOfPath(path))
  const rows = el('div', 'diff-rows')
  let before = 0
  let after = 0
  // The lines the open hunk still covers on each side. The notes the diff
  // writes in place of hunks, a file too large or a cut, give no count, so
  // everything under one is content, and none of it is numbered.
  let oldLeft = 0
  let newLeft = 0
  let numbered = false
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const start = HUNK.exec(line)
      numbered = start !== null
      before = Number(start?.[1] ?? 0)
      after = Number(start?.[3] ?? 0)
      oldLeft = start === null ? Infinity : Number(start[2] ?? 1)
      newLeft = start === null ? Infinity : Number(start[4] ?? 1)
      rows.append(el('div', 'diff-line hunk', line))
      continue
    }
    if (oldLeft <= 0 && newLeft <= 0 && FILE_HEADER.test(line)) continue
    const sign = line[0] === '+' || line[0] === '-' || line[0] === ' ' ? line[0] : ''
    const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'same'
    let old = ''
    let now = ''
    if (kind !== 'add') {
      if (numbered) old = String(before++)
      oldLeft -= 1
    }
    if (kind !== 'del') {
      if (numbered) now = String(after++)
      newLeft -= 1
    }
    const content = line.slice(sign.length)
    const row = el('div', `diff-line ${kind}`)
    const body = el('span', 'diff-text')
    // An empty line collapses to no height and breaks the column; a space keeps the row.
    body.append(content === '' ? ' ' : highlight(content, rules))
    row.append(el('span', 'diff-num', old), el('span', 'diff-num', now), el('span', 'diff-sign', sign), body)
    rows.append(row)
  }
  return rows
}
