// doc: docs/harness/tools.md
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool } from '../core/session.js'
import type { ArgsParse } from '../core/session.js'

type WriteArgs = { path: string; content: string }

function parseArgs(args: Record<string, unknown>): ArgsParse<WriteArgs> {
  if (typeof args.path !== 'string') return { ok: false, error: 'path must be a string' }
  if (typeof args.content !== 'string') return { ok: false, error: 'content must be a string' }
  return { ok: true, args: { path: args.path, content: args.content } }
}

export const WRITE_TOOL = defineTool<WriteArgs>({
  input: {
    name: 'write',
    description: 'Create or overwrite a file with the given content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run({ path: rel, content }, { access }) {
    const allowed = await access.check(rel, 'write')
    if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true }
    const abs = allowed.path
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return { ok: true, summary: `wrote ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)` }
  },
})