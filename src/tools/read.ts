// doc: docs/harness/tools.md
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
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
  input: {
    name: 'read',
    description: 'Read a file with offset/limit. Lines are capped at 2000 chars.',
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
  async run({ path: rel, offset: rawOffset, limit: rawLimit }, cwd): Promise<ToolResult> {
    const offset = rawOffset === undefined ? 0 : Math.max(0, Math.floor(rawOffset))
    const limit = rawLimit === undefined ? MAX_LINES : Math.min(MAX_LINES, Math.max(1, Math.floor(rawLimit)))
    const abs = resolve(cwd, rel)

    const info = await stat(abs).catch(() => null)
    if (!info) return { ok: false, summary: `read: ${rel}: no such file`, content: `read: ${rel}: no such file`, isError: true }
    if (info.size > MAX_BYTES) {
      return { ok: false, summary: `file is ${info.size} bytes; cap is ${MAX_BYTES}. Read with offset/limit or split the file`, content: `file is ${info.size} bytes; cap is ${MAX_BYTES}`, isError: true }
    }
    const text = await readFile(abs, 'utf8')
    const lines = text.split('\n')
    const slice = lines.slice(offset, offset + limit)
    const truncated = slice.map(l => (l.length > MAX_CHARS_PER_LINE ? `${l.slice(0, MAX_CHARS_PER_LINE)}... [line truncated]` : l))
    return {
      ok: true,
      summary: `${slice.length} lines shown, ${lines.length} total`,
      content: truncated.join('\n'),
    }
  },
})