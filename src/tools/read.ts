// doc: docs/harness/tools.md
import { readFile } from 'node:fs/promises'
import { ReadIndex, versionOf } from '../core/read-index.js'
import { defineTool } from '../core/session.js'
import type { ArgsParse } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

const MAX_LINES = 2000
const MAX_CHARS_PER_LINE = 2000
const MAX_BYTES = 256 * 1024

type ReadArgs = { path: string; offset?: number; limit?: number }

function parseArgs(args: Record<string, unknown>): ArgsParse<ReadArgs> {
  if (typeof args.path !== 'string') return { ok: false, error: 'path must be a string' }
  const out: ReadArgs = { path: args.path }
  if (args.offset !== undefined) {
    if (typeof args.offset !== 'number' || !Number.isFinite(args.offset)) return { ok: false, error: 'offset must be a number' }
    out.offset = args.offset
  }
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit)) return { ok: false, error: 'limit must be a number' }
    out.limit = args.limit
  }
  return { ok: true, args: out }
}

export const READ_TOOL = defineTool<ReadArgs>({
  // Reading changes nothing, so a message asking for several files runs them
  // together (`executeTools` in src/core/session.ts).
  parallel: true,
  input: {
    name: 'read',
    description:
      'Read a file with offset/limit. Each line is prefixed with its number, which is not part of the file: never copy a number into an edit. Lines are capped at 2000 chars. A file already read and unchanged comes back as a pointer to the lines already in this conversation, so read one wide window instead of overlapping slices.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run({ path: rel, offset: rawOffset, limit: rawLimit }, { access, reads }): Promise<ToolResult> {
    const offset = rawOffset === undefined ? 0 : Math.max(0, Math.floor(rawOffset))
    const limit = rawLimit === undefined ? MAX_LINES : Math.min(MAX_LINES, Math.max(1, Math.floor(rawLimit)))

    // Scope first: whether the file exists is none of the session's business
    // until it may look there at all.
    const allowed = await access.check(rel, 'read')
    if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true, prevented: true }
    const abs = allowed.path

    const version = await versionOf(abs)
    if (version === null) {
      reads.forget(abs)
      return { ok: false, summary: `read: ${rel}: no such file`, content: `read: ${rel}: no such file`, isError: true }
    }
    if (version.size > MAX_BYTES) {
      return { ok: false, summary: `file is ${version.size} bytes; cap is ${MAX_BYTES}. Read with offset/limit or split the file`, content: `file is ${version.size} bytes; cap is ${MAX_BYTES}`, isError: true }
    }

    const text = await readFile(abs, 'utf8')
    const lines = text.split('\n')
    // Named as an error, since an empty answer reads as an empty file.
    if (offset >= lines.length) {
      const why = `read: ${rel}: offset ${offset} is past the end; the file has ${lines.length} lines`
      return { ok: false, summary: why, content: why, isError: true }
    }
    const end = Math.min(lines.length, offset + limit)
    const span = { start: offset, end }

    // Already in the conversation, and the file has not moved since.
    const plan = reads.plan(abs, span, version)
    if (plan.kind === 'known') {
      const said = ReadIndex.knownText(rel, plan.spans)
      return { ok: true, summary: `${rel} unchanged since it was read`, content: said }
    }

    const slice = lines.slice(offset, offset + limit)
    const numbered = slice.map((line, i) => {
      const shown = line.length > MAX_CHARS_PER_LINE ? `${line.slice(0, MAX_CHARS_PER_LINE)}... [line truncated]` : line
      return `${offset + i + 1}: ${shown}`
    })
    reads.served(abs, span, version)
    return {
      ok: true,
      summary: `${slice.length} lines shown, ${lines.length} total`,
      content: numbered.join('\n'),
    }
  },
})
