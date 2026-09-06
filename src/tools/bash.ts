// doc: docs/harness/tools.md
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { defineTool } from '../core/session.js'
import { suspectPaths } from '../core/scope.js'
import type { ArgsParse, Tool } from '../core/session.js'
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

/**
 * The planner's shell. A read-only role holding a full shell is a write tool
 * with extra steps, so the obvious ways to write are refused before anything
 * runs: redirects, the file-mutating coreutils, in-place sed and perl, the
 * package managers, and the PowerShell verbs that do the same job on Windows.
 *
 * This is a screen, not a security boundary, and it is documented as one in
 * `docs/harness/agents.md`: a command that builds its redirect at runtime gets
 * through, and a script the command runs is never read. It exists to keep a
 * planner honest; the ledger asks for a real sandbox for the rest.
 */
const WRITE_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /(^|[^0-9<>&])>{1,2}(?!&)/, why: 'a redirect writes a file' },
  { pattern: /\|\s*tee\b/, why: 'tee writes a file' },
  {
    pattern: /(^|[;&|(])\s*(rm|mv|cp|ln|touch|mkdir|rmdir|truncate|dd|chmod|chown|install|patch|shred)\b/,
    why: 'that command changes files',
  },
  { pattern: /\bsed\b[^|;&]*\s-[a-z]*i/, why: 'sed -i edits in place' },
  { pattern: /\bperl\b[^|;&]*\s-[a-z]*i/, why: 'perl -i edits in place' },
  {
    pattern: /\bgit\s+(commit|push|tag|checkout|reset|clean|restore|apply|rebase|merge|stash)\b/,
    why: 'that git command changes the tree or the history',
  },
  { pattern: /\b(npm|pnpm|yarn|pip|cargo)\s+(i|install|add|remove|uninstall|update)\b/, why: 'installing writes to the project' },
  { pattern: /\b(curl|wget)\b[^|;&]*\s-[a-zA-Z]*[oO]\b/, why: 'that download writes a file' },
  {
    pattern: /\b(Out-File|Set-Content|Add-Content|Clear-Content|Remove-Item|Move-Item|Copy-Item|New-Item|Set-ItemProperty)\b/i,
    why: 'that PowerShell command changes files',
  },
]

/** Why this command is refused a read-only agent, or null when it looks like a read. */
export function writeGuard(command: string): string | null {
  for (const { pattern, why } of WRITE_PATTERNS) {
    if (pattern.test(command)) return `this agent reads but does not write, and ${why}`
  }
  return null
}

type BashArgs = { command: string }

function parseArgs(args: Record<string, unknown>): ArgsParse<BashArgs> {
  if (typeof args.command !== 'string') return { ok: false, error: 'command must be a string' }
  return { ok: true, args: { command: args.command } }
}

function run(command: string, cwd: string): Promise<ToolResult> {
  return new Promise<ToolResult>(resolve => {
    execFile(
      bashBin as string,
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
}

// One shell with one set of caps, in two dresses: the guard is the only thing
// that differs, so neither variant can drift away from the other's timeout,
// output cap or scope check.
function bashTool(guarded: boolean): Tool {
  return defineTool<BashArgs>({
    input: {
      name: 'bash',
      description: guarded
        ? 'Run a read-only shell command from the project cwd. Commands that write are refused. Output is captured and capped at 1 MB.'
        : 'Run a shell command from the project cwd. Output is captured and capped at 1 MB.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false,
      },
    },
    parse: parseArgs,
    async run({ command }, { cwd, access }): Promise<ToolResult> {
      const refused = guarded ? writeGuard(command) : null
      if (refused !== null) return { ok: false, summary: refused, content: refused, isError: true }

      // A shell command is not a path list, so the scope check is a screen, not
      // a proof: every path the command names is checked, and the command runs
      // with the session root as its cwd. A command that builds a path at
      // runtime slips through, which is why the ledger wants a real sandbox.
      const allowed = await access.checkAll(suspectPaths(command), 'run')
      if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true }
      if (!bashBin) {
        const missing = 'no shell available: git bash not found in the usual Windows paths'
        return { ok: false, summary: missing, content: missing, isError: true }
      }
      return run(command, cwd)
    },
  })
}

/** The full shell: the builder's and the harness editor's. */
export const BASH_TOOL = bashTool(false)

/** The planner's shell, with `writeGuard` in front of it. */
export const GUARDED_BASH_TOOL = bashTool(true)
