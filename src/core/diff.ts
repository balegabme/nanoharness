// doc: docs/harness/tools.md

/**
 * A unified diff of what an edit did: a line LCS and a hunk formatter.
 *
 * The result goes into the tool's own output, so it is read twice, by the
 * window that draws it and by the model that is billed for it. Hence the caps
 * below.
 */

/** Lines of context kept either side of a change. */
const CONTEXT = 3

/** The longest diff that goes into a tool result, in lines. */
const DIFF_LINE_CAP = 120

/**
 * The largest pair of files the line LCS is run on. The table is
 * width × height cells, so a pair past this is answered with a count instead.
 * Filling the table for one costs about a second and a gigabyte.
 */
const LCS_CELL_CAP = 4_000_000

export interface DiffStat {
  added: number
  removed: number
}

export interface FileDiff {
  /**
   * The unified diff, or '' when the two texts are identical. A diff cut to
   * `DIFF_LINE_CAP` says so in its own last line.
   */
  text: string
  stat: DiffStat
}

function lines(text: string): string[] {
  // An empty file has no lines. `''.split('\n')` yields one empty line, and the
  // pop below keeps it, so a brand-new file would diff as the removal of a line
  // that was never on disk.
  if (text === '') return []
  const split = text.split('\n')
  // A trailing newline terminates the last line. Without this every file ends
  // in a phantom '' that the diff then reports on.
  if (split.length > 1 && split[split.length - 1] === '') split.pop()
  return split
}

type Op = { kind: 'same' | 'add' | 'remove'; text: string }

/**
 * The edit script between two line lists. Common head and tail are matched off
 * first, which is what keeps a one-line change in a two-thousand-line file out
 * of the table entirely.
 */
function script(before: string[], after: string[]): Op[] | null {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }

  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)
  if ((a.length + 1) * (b.length + 1) > LCS_CELL_CAP) return null

  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }

  const ops: Op[] = []
  for (const text of before.slice(0, head)) ops.push({ kind: 'same', text })
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      ops.push({ kind: 'remove', text: a[i] ?? '' })
      i += 1
    } else {
      ops.push({ kind: 'add', text: b[j] ?? '' })
      j += 1
    }
  }
  for (; i < a.length; i += 1) ops.push({ kind: 'remove', text: a[i] ?? '' })
  for (; j < b.length; j += 1) ops.push({ kind: 'add', text: b[j] ?? '' })
  for (const text of before.slice(before.length - tail)) ops.push({ kind: 'same', text })
  return ops
}

interface Hunk {
  beforeStart: number
  afterStart: number
  body: string[]
}

/** The changed stretches, each padded with `CONTEXT` unchanged lines. */
function hunks(ops: readonly Op[]): Hunk[] {
  const changed = ops.map(op => op.kind !== 'same')
  const keep = ops.map((_, index) =>
    changed.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some(Boolean),
  )

  const out: Hunk[] = []
  let beforeLine = 1
  let afterLine = 1
  let open: Hunk | null = null
  for (const [index, op] of ops.entries()) {
    if (keep[index] === true) {
      open ??= { beforeStart: beforeLine, afterStart: afterLine, body: [] }
      open.body.push(`${op.kind === 'add' ? '+' : op.kind === 'remove' ? '-' : ' '}${op.text}`)
    } else if (open !== null) {
      out.push(open)
      open = null
    }
    if (op.kind !== 'add') beforeLine += 1
    if (op.kind !== 'remove') afterLine += 1
  }
  if (open !== null) out.push(open)
  return out
}

function header(hunk: Hunk): string {
  const before = hunk.body.filter(line => !line.startsWith('+')).length
  const after = hunk.body.filter(line => !line.startsWith('-')).length
  // A side with no lines starts at 0, which is what the format says an empty
  // side looks like: a file created from nothing is `@@ -0,0 +1,n @@`.
  const from = before === 0 ? 0 : hunk.beforeStart
  const to = after === 0 ? 0 : hunk.afterStart
  return `@@ -${from},${before} +${to},${after} @@`
}

/**
 * The change between two versions of one file, as a unified diff.
 *
 * `path` names both sides because the harness has no rename: an edit writes
 * back to the file it read.
 */
export function unifiedDiff(path: string, before: string, after: string): FileDiff {
  if (before === after) return { text: '', stat: { added: 0, removed: 0 } }

  const beforeLines = lines(before)
  const afterLines = lines(after)
  const ops = script(beforeLines, afterLines)
  if (ops === null) {
    const stat = { added: afterLines.length, removed: beforeLines.length }
    return {
      text: `--- a/${path}\n+++ b/${path}\n@@ file too large to diff @@\n ${beforeLines.length} lines before, ${afterLines.length} after`,
      stat,
    }
  }

  const stat: DiffStat = {
    added: ops.filter(op => op.kind === 'add').length,
    removed: ops.filter(op => op.kind === 'remove').length,
  }

  // Two texts that differ only in whether the last line is terminated have the
  // same lines, so there is nothing for a hunk to show. A header with an empty
  // body under it would read as a write that changed nothing.
  if (stat.added === 0 && stat.removed === 0) {
    const gained = after.endsWith('\n')
    return {
      text: [`--- a/${path}`, `+++ b/${path}`, `@@ trailing newline ${gained ? 'added' : 'removed'} @@`].join('\n'),
      stat,
    }
  }

  const body: string[] = []
  let truncated = false
  for (const hunk of hunks(ops)) {
    if (body.length >= DIFF_LINE_CAP) {
      truncated = true
      break
    }
    body.push(header(hunk))
    for (const line of hunk.body) {
      if (body.length >= DIFF_LINE_CAP) {
        truncated = true
        break
      }
      body.push(line)
    }
  }
  if (truncated) body.push(`@@ cut here: ${stat.added} lines added and ${stat.removed} removed in all @@`)

  return { text: [`--- a/${path}`, `+++ b/${path}`, ...body].join('\n'), stat }
}

/** The diff as it travels in a tool result: a fence the window can find again. */
export function diffBlock(diff: FileDiff): string {
  return diff.text === '' ? '' : `\`\`\`diff\n${diff.text}\n\`\`\``
}

/** "+12 −3", the shape a card's corner shows. */
export function statText(stat: DiffStat): string {
  return `+${stat.added} −${stat.removed}`
}
