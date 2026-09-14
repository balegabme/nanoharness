// doc: docs/harness/tools.md
import { readFile, stat, writeFile } from 'node:fs/promises'
import { defineTool } from '../core/session.js'
import type { ArgsParse } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

type EditArgs = { path: string; old_string: string; new_string: string; replace_all?: boolean }

function parseArgs(args: Record<string, unknown>): ArgsParse<EditArgs> {
  if (typeof args.path !== 'string') return { ok: false, error: 'path must be a string' }
  if (typeof args.old_string !== 'string') return { ok: false, error: 'old_string must be a string' }
  if (typeof args.new_string !== 'string') return { ok: false, error: 'new_string must be a string' }
  if (args.old_string === args.new_string) return { ok: false, error: 'old_string and new_string must differ' }
  const out: EditArgs = { path: args.path, old_string: args.old_string, new_string: args.new_string }
  if (args.replace_all !== undefined) {
    if (typeof args.replace_all !== 'boolean') return { ok: false, error: 'replace_all must be a boolean' }
    out.replace_all = args.replace_all
  }
  return { ok: true, args: out }
}

function failed(why: string): ToolResult {
  return { ok: false, summary: why, content: why, isError: true }
}

type LineEndings = 'LF' | 'CRLF'

/** Collapse CRLF to LF, the form every match is made in. */
function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/** The style the file came in, so the edit goes back out the same way. */
function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf ? 'CRLF' : 'LF'
}

function restoreLineEndings(content: string, style: LineEndings): string {
  return style === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * The file as text, or why it is not text. A lossy decode would turn a byte it
 * cannot read into U+FFFD, write that replacement back and call it an edit, so
 * invalid UTF-8 is a refusal here the same way a NUL byte is. This is the
 * reference behaviour in `deepseek-harness` (`readForEdit`).
 */
function decodeText(buffer: Buffer, rel: string): { text: string } | { error: string } {
  if (buffer.includes(0)) return { error: `cannot edit ${rel}: binary file` }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    return { error: `cannot edit ${rel}: not valid UTF-8 text` }
  }
}

export const EDIT_TOOL = defineTool<EditArgs>({
  input: {
    name: 'edit',
    description:
      'Replace literal text in an existing UTF-8 file. old_string must appear exactly once unless replace_all is true. Read the file first, unless you created or last edited it in this session.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The text to put in its place.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run({ path: rel, old_string, new_string, replace_all }, { access }): Promise<ToolResult> {
    const allowed = await access.check(rel, 'write')
    if (!allowed.ok) return failed(allowed.reason)
    const abs = allowed.path

    const info = await stat(abs).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
    if (info instanceof Error) {
      if ((info as NodeJS.ErrnoException).code === 'ENOENT') return failed(`edit: ${rel}: no such file`)
      return failed(`edit: ${rel}: ${info.message}`)
    }
    if (!info.isFile()) return failed(`edit: ${rel}: not a regular file`)

    let raw: string
    try {
      const decoded = decodeText(await readFile(abs), rel)
      if ('error' in decoded) return failed(decoded.error)
      raw = decoded.text
    } catch (err) {
      return failed(`could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const content = normalizeLineEndings(raw)
    const oldNorm = normalizeLineEndings(old_string)
    if (oldNorm === '') return failed('old_string must be a non-empty string')
    const replacements = countOccurrences(content, oldNorm)
    if (replacements === 0) {
      return failed(`old_string was not found in ${rel}. Read the file and copy the text exactly, whitespace included.`)
    }
    if (replacements > 1 && replace_all !== true) {
      return failed(`old_string matched ${replacements} times in ${rel}; make it more specific or set replace_all to true`)
    }

    const edited = content.split(oldNorm).join(normalizeLineEndings(new_string))
    try {
      await writeFile(abs, restoreLineEndings(edited, detectLineEndings(raw)), 'utf8')
    } catch (err) {
      return failed(`could not write ${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const done = `edited ${rel} (${replacements} ${replacements === 1 ? 'replacement' : 'replacements'})`
    return { ok: true, summary: done, content: done }
  },
})
