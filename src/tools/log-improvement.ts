// doc: docs/harness/tools.md
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isHarnessRepo } from '../core/roots.js'
import { defineTool } from '../core/session.js'
import type { ArgsParse } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

const LEDGER_HEADER = `# Improvements

Flaw and improvement ledger (plan §4 rule 5). The \`log_improvement\` tool
appends entries under dated headings; the harness-editor ticks one off with a
ref once it is fixed.
`

type ImprovementArgs = { title: string; detail?: string }

function parseArgs(args: Record<string, unknown>): ArgsParse<ImprovementArgs> {
  if (typeof args.title !== 'string' || args.title.trim() === '') {
    return { ok: false, error: 'title must be a non-empty string' }
  }
  const out: ImprovementArgs = { title: args.title.trim() }
  if (args.detail !== undefined) {
    if (typeof args.detail !== 'string') return { ok: false, error: 'detail must be a string' }
    if (args.detail.trim() !== '') out.detail = args.detail.trim()
  }
  return { ok: true, args: out }
}

// Dev mode: when the workspace is the nanoharness repo itself the ledger is the
// checked-in one. Any other workspace gets its own under .nanoharness/ — the
// installed package dir is never written to (plan §4 rule 5).
export async function ledgerPath(cwd: string): Promise<string> {
  if (await isHarnessRepo(cwd)) return join(cwd, 'docs', 'harness', 'improvements.md')
  return join(cwd, '.nanoharness', 'improvements.md')
}

export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function appendEntry(ledger: string, date: string, entry: string): string {
  const body = ledger.trimEnd()
  const heading = `## ${date}`
  const start = body.split('\n').findIndex(l => l.trim() === heading)
  if (start === -1) return `${body}\n\n${heading}\n\n${entry}\n`

  const lines = body.split('\n')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.startsWith('## ')) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end).join('\n').trimEnd()
  return [...lines.slice(0, start), section, entry, '', ...lines.slice(end)].join('\n').trimEnd() + '\n'
}

export const LOG_IMPROVEMENT_TOOL = defineTool<ImprovementArgs>({
  input: {
    name: 'log_improvement',
    description: 'Record a flaw or improvement idea in the workspace ledger. Use it when you notice something worth fixing outside the current task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line: what should change.' },
        detail: { type: 'string', description: 'Optional context, file references, or a suggested fix.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run({ title, detail }, { cwd }): Promise<ToolResult> {
    const path = await ledgerPath(cwd)
    const existing = await readFile(path, 'utf8').catch(() => LEDGER_HEADER)
    const oneLine = (s: string) => s.replace(/\s+/g, ' ')
    const entry = detail === undefined ? `- [ ] ${oneLine(title)}` : `- [ ] ${oneLine(title)} — ${oneLine(detail)}`

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, appendEntry(existing, today(), entry), 'utf8')
    return { ok: true, summary: `logged improvement in ${path}` }
  },
})
