// doc: docs/harness/tools.md
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '../core/session.js'
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

/**
 * Hand the command to bash as a file rather than as an argument. Git Bash
 * truncates a `-c` string at 8 KiB and runs the front half anyway, so a 12 KB
 * patch script would run cut mid-line, with bash reporting an unterminated
 * heredoc, and the agent would read that as a failed edit rather than a
 * half-applied one. A script file has no such limit, and the shell still
 * starts as a login shell, so `grep`, `sed` and `curl` are on PATH.
 *
 * CRLF is normalised on the way in: bash reads the carriage return as part of
 * the word, so a heredoc terminator written `PY\r` never matches `PY`. The fold is
 * over the whole command and not only its line ends, so a heredoc written to
 * lay down a CRLF fixture lays down LF instead. That is worth the trade here:
 * the model writes CRLF by accident far more often than on purpose, and
 * `printf` is the way to write one on purpose.
 *
 * The file is the command, so it is written for this user alone: the temp
 * directory is shared, and this project keeps a pasted key out of the
 * transcript and off the wire.
 */
function run(command: string, cwd: string): Promise<ToolResult> {
  const script = join(tmpdir(), `nh-${randomUUID()}.sh`)
  return writeFile(script, command.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o600 })
    .then(() => exec(script, cwd))
    .catch((err: unknown) => {
      // A script that could not be written is a tool failure and not a thrown
      // promise: the loop needs a result to hand back to the model.
      const why = `could not write the command to a script file: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, summary: why, content: why, isError: true } satisfies ToolResult
    })
    // Cleanup is not the command's result. Windows can hold the file open just
    // long enough after a timeout kills bash for `rm` to fail, and throwing
    // there would discard output that is already in hand.
    .finally(() => void rm(script, { force: true }).catch(() => undefined))
}

function exec(script: string, cwd: string): Promise<ToolResult> {
  return new Promise<ToolResult>(resolve => {
    execFile(
      bashBin as string,
      ['-l', script],
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
// that differs, so neither variant can drift away from the other's timeout or
// output cap.
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

      if (!bashBin) {
        const missing = 'no shell available: git bash not found in the usual Windows paths'
        return { ok: false, summary: missing, content: missing, isError: true }
      }

      // The command is approved as a whole, never read. A shell command is a
      // program, and every attempt to pull paths out of one has read a script
      // body, a heredoc, a sed address or an HTML tag as somewhere on disk. So
      // the app's gate shows the person the command and remembers their answer
      // for the session; a gate with nobody to ask refuses it outright.
      const allowed = await access.checkCommand(command)
      if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true }

      return run(command, cwd)
    },
  })
}

/** The full shell: the builder's and the harness editor's. */
export const BASH_TOOL = bashTool(false)

/** The planner's shell, with `writeGuard` in front of it. */
export const GUARDED_BASH_TOOL = bashTool(true)
