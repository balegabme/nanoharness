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

/**
 * How long the one-off PATH probe gets before it is killed. Nothing waits on
 * it, so this is not a latency budget. It is here so that a profile which
 * blocks for ever does not leave a shell running for the life of the app.
 */
const PROBE_TIMEOUT_MS = 120_000

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
 * A screen, not a security boundary, and documented as one in
 * `docs/harness/agents.md`: a redirect built at runtime gets through.
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
 * patch script would run cut mid-line and the agent would read the unterminated
 * heredoc as a failed edit rather than a half-applied one.
 *
 * CRLF is folded to LF on the way in, since bash counts the carriage return as
 * part of a heredoc terminator. The fold is over the whole command, so a
 * heredoc meant to lay down a CRLF fixture lays down LF; `printf` is the way to
 * write one on purpose.
 *
 * The file holds the command, so it is written for this user alone. The temp
 * directory is shared.
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

/**
 * The PATH a login shell would have, learned once in the background.
 *
 * A login shell is worth starting only for what the profile exports:
 * `~/.local/bin`, `~/.cargo/bin`, and on macOS the PATH a GUI-launched app has
 * no other way to inherit. Git Bash prepends `/mingw64/bin` and `/usr/bin`
 * either way. Sourcing that profile costs three to four seconds on an idle
 * Windows machine, and every command paid it.
 *
 * A profile does not change while the app is open, so one read serves them all
 * and nothing waits for it. A command that arrives before the answer starts its
 * own login shell, and so does every command if the read fails outright.
 *
 * On Windows the value is converted back to Windows form, because that is what
 * a child's `PATH` has to be; `cygpath -w -p` round-trips it without losing a
 * segment.
 */
let probe: Promise<void> | undefined
let loginPath: string | undefined

/**
 * Start the read now, so the first command is not the one that pays for it.
 * Called at app start, where nobody is waiting. Safe to call more than once,
 * and optional: without it the first command starts its own login shell.
 */
export function warmShell(): void {
  if (bashBin !== null) readLoginPath()
}

function readLoginPath(): void {
  probe ??= new Promise<void>(resolve => {
    const print = process.platform === 'win32' ? 'cygpath -w -p "$PATH"' : 'printf %s "$PATH"'
    execFile(bashBin as string, ['-lc', print], { windowsHide: true, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      const value = stdout.trim()
      if (error === null && value !== '') loginPath = value
      resolve()
    })
  })
}

function exec(script: string, cwd: string): Promise<ToolResult> {
  readLoginPath()
  // Whatever the probe has settled on by now, which for the first command is
  // nothing. With the profile's PATH already in hand the shell has no reason to
  // read the profile again; without it, `-l` is the only way to get one.
  const path = loginPath
  const args = path === undefined ? ['-l', script] : [script]
  const env = path === undefined ? process.env : { ...process.env, PATH: path }
  return new Promise<ToolResult>(resolve => {
    execFile(
      bashBin as string,
      args,
      { cwd, env, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: OUTPUT_CAP, encoding: 'utf8' },
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

      // The command is approved as a whole, never read: every attempt to pull
      // paths out of a shell command has read a heredoc or a sed address as
      // somewhere on disk. A gate with nobody to ask refuses it outright.
      const allowed = await access.checkCommand(command)
      if (!allowed.ok) return { ok: false, summary: allowed.reason, content: allowed.reason, isError: true, prevented: true }

      return run(command, cwd)
    },
  })
}

/** The full shell: the builder's and the harness editor's. */
export const BASH_TOOL = bashTool(false)

/** The planner's shell, with `writeGuard` in front of it. */
export const GUARDED_BASH_TOOL = bashTool(true)
