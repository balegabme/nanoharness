// doc: docs/harness/tools.md
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '../core/session.js'
import { shellLaunch } from '../env/shell.js'
import type { ShellLaunch } from '../env/shell.js'
import type { ArgsParse, Tool } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

const OUTPUT_CAP = 1024 * 1024
const TIMEOUT_MS = 60_000

/**
 * The ways to write that the planner's shell refuses: redirects, the
 * file-mutating coreutils, in-place sed and perl, the package managers, and
 * the PowerShell verbs that do the same job on Windows.
 *
 * This is a screen and not containment. A redirect built at runtime gets
 * through. See `docs/harness/agents.md`.
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
 * The command goes to bash as a file. Git Bash truncates a `-c` string at
 * 8 KiB and runs the front half anyway.
 *
 * CRLF is folded to LF over the whole command, since bash counts the carriage
 * return as part of a heredoc terminator. A heredoc meant to lay down a CRLF
 * fixture lays down LF; `printf` writes one on purpose.
 *
 * The temp directory is shared and the file holds the command, so it is
 * written for this user alone.
 */
function run(command: string, cwd: string, launch: ShellLaunch): Promise<ToolResult> {
  const script = join(tmpdir(), `nh-${randomUUID()}.sh`)
  return writeFile(script, command.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o600 })
    .then(() => exec(script, cwd, launch))
    .catch((err: unknown) => {
      // The loop needs a result to hand back to the model, so a failed write
      // is a tool error and not a thrown promise.
      const why = `could not write the command to a script file: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, summary: why, content: why, isError: true } satisfies ToolResult
    })
    // Windows can hold the script open after a timeout kills bash, so a failed
    // cleanup must not touch the result.
    .finally(() => void rm(script, { force: true }).catch(() => undefined))
}

function exec(script: string, cwd: string, launch: ShellLaunch): Promise<ToolResult> {
  return new Promise<ToolResult>(resolve => {
    execFile(
      launch.bin,
      [...launch.args, script],
      { cwd, env: launch.env, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: OUTPUT_CAP, encoding: 'utf8' },
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

function noShell(): ToolResult {
  const missing = 'no shell available: git bash not found in the usual Windows paths'
  return { ok: false, summary: missing, content: missing, isError: true }
}

// Both shells share one timeout and one output cap; the guard is the only
// difference between them.
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

      // Before the gate, so nobody is asked to approve a command with no shell to run it.
      const launch = shellLaunch()
      if (launch === null) return noShell()

      // The command is approved whole and never parsed for paths: a heredoc or
      // a sed address reads as somewhere on disk. A gate with nobody to ask
      // refuses it outright.
      const allowed = await access.checkCommand(command)
      if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true, prevented: true }

      return run(command, cwd, launch)
    },
  })
}

/** The full shell: the builder's and the harness editor's. */
export const BASH_TOOL = bashTool(false)

/** The planner's shell, with `writeGuard` in front of it. */
export const GUARDED_BASH_TOOL = bashTool(true)
