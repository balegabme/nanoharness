// doc: docs/harness/tools.md
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { versionOf } from '../core/read-index.js'
import { defineTool } from '../core/session.js'
import { diffBlock, statText, unifiedDiff } from '../core/diff.js'
import { decodeText } from './text.js'
import type { ArgsParse } from '../core/session.js'

type WriteArgs = { path: string; content: string }

function parseArgs(args: Record<string, unknown>): ArgsParse<WriteArgs> {
  if (typeof args.path !== 'string') return { ok: false, error: 'path must be a string' }
  if (typeof args.content !== 'string') return { ok: false, error: 'content must be a string' }
  return { ok: true, args: { path: args.path, content: args.content } }
}

/**
 * What the file held, '' when there was no file, and null when there was one
 * and its content is not something a diff can be made of: a permission error, a
 * lock, a binary, anything that does not decode as UTF-8. The three cases read
 * differently in the result.
 */
async function previous(abs: string): Promise<string | null> {
  const raw = await readFile(abs).catch((err: unknown) =>
    (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? Buffer.alloc(0) : null,
  )
  if (raw === null) return null
  if (raw.length === 0) return ''
  const decoded = decodeText(raw)
  return 'error' in decoded ? null : decoded.text
}

export const WRITE_TOOL = defineTool<WriteArgs>({
  input: {
    name: 'write',
    description: 'Create or overwrite a file with the given content. Overwriting a file this conversation has not read is refused: read it first, or use edit.',
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
  async run({ path: rel, content }, { access, reads }) {
    const allowed = await access.check(rel, 'write')
    if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true, prevented: true }
    const abs = allowed.path
    // Creating a file is always allowed. Replacing the whole of one nobody
    // read, or one that has changed since they did, throws away content this
    // conversation never saw.
    const may = reads.mayWrite(abs, await versionOf(abs), `write: ${rel}:`)
    if (!may.ok) return { ok: false, summary: may.reason, content: may.reason, isError: true }
    // Read before writing, so an overwrite can say what it replaced. Only a
    // file that is not there diffs against nothing; one that is there and
    // cannot be read is not a new file, and reporting it as one would tell the
    // model it had created four hundred lines it actually destroyed.
    const before = await previous(abs)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    reads.wrote(abs, await versionOf(abs))
    const bytes = Buffer.byteLength(content, 'utf8')
    if (before === null) {
      const done = `wrote ${rel} (${bytes} bytes, replacing content that could not be read as text)`
      return { ok: true, summary: done, content: done }
    }
    const diff = unifiedDiff(rel, before, content)
    const done = `wrote ${rel} (${bytes} bytes, ${statText(diff.stat)})`
    return { ok: true, summary: done, content: `${done}\n\n${diffBlock(diff)}` }
  },
})