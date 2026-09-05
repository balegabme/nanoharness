// doc: docs/harness/tools.md
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { defineTool } from '../core/session.js'
import { suspectPaths } from '../core/scope.js'
import type { ArgsParse } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

const OUTPUT_CAP = 1024 * 1024
const TIMEOUT_MS = 60_000

function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash'
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  return candidates.find(existsSync) ?? null
}

const bashBin = findBash()

type BashArgs = { command: string }

function parseArgs(args: Record<string, unknown>): ArgsParse<BashArgs> {
  if (typeof args.command !== 'string') return { ok: false, error: 'command must be a string' }
  return { ok: true, args: { command: args.command } }
}

export const BASH_TOOL = defineTool<BashArgs>({
  input: {
    name: 'bash',
    description: 'Run a shell command from the project cwd. Output is captured and capped at 1 MB.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run({ command }, { cwd, access }): Promise<ToolResult> {
    // A shell command is not a path list, so the scope check is a screen, not a
    // proof: every path the command names is checked, and the command runs with
    // the session root as its cwd. A command that builds a path at runtime
    // slips through, which is why the ledger wants a real sandbox here.
    const allowed = await access.checkAll(suspectPaths(command), 'run')
    if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true }
    if (!bashBin) {
      return {
        ok: false,
        summary: 'no shell available: git bash not found in the usual Windows paths',
        content: 'no shell available: git bash not found in the usual Windows paths',
        isError: true,
      }
    }
    return new Promise<ToolResult>(resolve => {
      execFile(
        bashBin,
        ['-lc', command],
        { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: OUTPUT_CAP, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join('\n').trim()
          if (!error) {
            resolve({ ok: true, summary: out || '(no output)', content: out || '' })
            return
          }
          const err = error as NodeJS.ErrnoException & { exitCode?: number | null; killed?: boolean; signal?: string | null }
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolve({
              ok: false,
              summary: '[output truncated at 1 MB]\n' + (out || '(no output captured)'),
              content: out,
              isError: true,
            })
            return
          }
          // A timeout kills the child, so there is no exit code to report.
          if (err.killed) {
            const killed = `killed after ${TIMEOUT_MS / 1000}s${err.signal ? ` (${err.signal})` : ''}`
            resolve({ ok: false, summary: out ? `${killed}: ${out}` : killed, content: out || '', isError: true })
            return
          }
          const exitCode = err.exitCode ?? err.code ?? '?'
          resolve({ ok: false, summary: out ? `exit code ${exitCode}: ${out}` : `exit code ${exitCode}`, content: out || '', isError: true })
        },
      )
    })
  },
})