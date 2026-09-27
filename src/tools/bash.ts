// doc: docs/harness/tools.md
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '../core/session.js'
import { killTree, shellLaunch, TREE } from '../env/shell.js'
import type { ShellLaunch } from '../env/shell.js'
import type { ArgsParse, Tool } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

/** The most output one call keeps, in characters. Past it the command is ended. */
const OUTPUT_CAP = 1024 * 1024

/** How long a command may run when the call names no timeout, in seconds. */
export const DEFAULT_TIMEOUT_S = 120

/**
 * The longest a call may ask for, in seconds. The turn waits on the command
 * the whole time, so anything longer belongs in `terminal`, which does not.
 */
export const MAX_TIMEOUT_S = 600

/**
 * How long the pipes get once bash has exited. A process the command left
 * running, a server started with `&`, holds them open for as long as it runs,
 * so the result is whatever arrived by then.
 */
const PIPE_GRACE_MS = 1_000

/**
 * Settings that stop a command from waiting on a person who is not there. Git
 * fails on a missing credential instead of asking for one, and nothing pages
 * its output through `less`. The `bash` tool also closes stdin, so a command
 * that reads it gets end-of-file at once.
 */
export const UNATTENDED_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' }

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

type BashArgs = { command: string; timeoutS: number }

function parseArgs(args: Record<string, unknown>): ArgsParse<BashArgs> {
  if (typeof args.command !== 'string') return { ok: false, error: 'command must be a string' }
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_S
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return { ok: false, error: 'timeout must be a positive number of seconds' }
  }
  return { ok: true, args: { command: args.command, timeoutS: Math.min(Math.ceil(timeout), MAX_TIMEOUT_S) } }
}

/** One command to run, and what to say if it leaves something running. */
interface Job {
  command: string
  cwd: string
  launch: ShellLaunch
  timeoutS: number
  signal: AbortSignal | undefined
  leftRunning: string
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
function run(job: Job): Promise<ToolResult> {
  const script = join(tmpdir(), `nh-${randomUUID()}.sh`)
  return writeFile(script, job.command.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o600 })
    .then(() => exec(script, job))
    .catch((err: unknown) => {
      // The loop needs a result to hand back to the model, so a failed write
      // is a tool error and not a thrown promise.
      const why = `could not write the command to a script file: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, summary: why, content: why, isError: true } satisfies ToolResult
    })
    // Windows can hold the script open after a kill, so a failed cleanup must
    // not touch the result.
    .finally(() => void rm(script, { force: true }).catch(() => undefined))
}

/**
 * Run the script and settle on the first of four endings: bash exits, the
 * timeout runs out, the user stops the turn, or the output passes the cap.
 * The last three end bash and everything it started, because a child left
 * behind holds the pipes and would keep the turn waiting.
 */
function exec(script: string, job: Job): Promise<ToolResult> {
  return new Promise<ToolResult>(resolve => {
    const started = Date.now()
    const child = spawn(job.launch.bin, [...job.launch.args, script], {
      cwd: job.cwd,
      env: { ...job.launch.env, ...UNATTENDED_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...TREE,
    })
    let out = ''
    let settled = false
    let grace: NodeJS.Timeout | undefined

    const settle = (result: ToolResult): void => {
      clearTimeout(timer)
      clearTimeout(grace)
      job.signal?.removeEventListener('abort', abort)
      if (settled) return
      settled = true
      resolve(result)
    }
    const failed = (head: string, tail = ''): ToolResult => {
      const text = [head, out.trim(), tail].filter(part => part !== '').join('\n')
      return { ok: false, summary: text, content: text, isError: true }
    }

    const timer = setTimeout(() => {
      killTree(child)
      settle(
        failed(
          `killed after ${job.timeoutS}s, still running; everything it started was ended with it`,
          `[a longer \`timeout\`, up to ${MAX_TIMEOUT_S}s, gives it more time]`,
        ),
      )
    }, job.timeoutS * 1000)
    const abort = (): void => {
      killTree(child)
      settle(failed(`stopped by the user after ${Math.round((Date.now() - started) / 1000)}s`))
    }
    if (job.signal?.aborted === true) abort()
    else job.signal?.addEventListener('abort', abort)

    const take = (chunk: string): void => {
      if (settled) return
      out += chunk
      if (out.length <= OUTPUT_CAP) return
      out = out.slice(0, OUTPUT_CAP)
      killTree(child)
      settle(failed('[output truncated at 1 MB, and the command was ended]'))
    }
    child.stdout.setEncoding('utf8').on('data', take)
    child.stderr.setEncoding('utf8').on('data', take)
    child.on('error', err => settle(failed(`bash could not start: ${err.message}`)))

    // `close` waits for every process holding the pipes. `exit` is bash alone,
    // and a pipe still open a second after it is a process left running.
    const finish = (code: number | null, held: boolean): void => {
      const note = held ? job.leftRunning : ''
      if (code !== 0) {
        settle(failed(`exit code ${code ?? 'on a signal'}`, note))
        return
      }
      const text = [out.trim() || '(no output)', note].filter(part => part !== '').join('\n')
      settle({ ok: true, summary: text, content: text })
    }
    child.on('exit', code => {
      grace = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        finish(code, true)
      }, PIPE_GRACE_MS)
    })
    child.on('close', code => finish(code, false))
  })
}

function noShell(): ToolResult {
  const missing = 'no shell available: git bash not found in the usual Windows paths'
  return { ok: false, summary: missing, content: missing, isError: true }
}

// Both shells share one timeout and one output cap; the guard is the only
// difference between them. The planner has no `terminal`, so its shell does
// not point at one.
function bashTool(guarded: boolean): Tool {
  const held = '[bash exited, but a process it started is still running and holding the output open. It was left running'
  const leftRunning = guarded ? `${held}.]` : `${held}, where nothing can read or stop it: start a server or a watcher with \`terminal\` instead.]`
  return defineTool<BashArgs>({
    input: {
      name: 'bash',
      description: [
        guarded ? 'Run a read-only shell command from the project cwd. Commands that write are refused.' : 'Run a shell command from the project cwd.',
        `Output is captured, and a command that prints more than 1 MB is ended. Stdin is closed, so nothing waits for input. The command and everything it started are killed after \`timeout\` seconds (default ${DEFAULT_TIMEOUT_S}, at most ${MAX_TIMEOUT_S}).`,
        guarded ? '' : 'A server, a watcher, or anything that must keep running or take input, goes in `terminal`.',
        'Calls run one at a time, and each may wait on an approval first, so join steps that belong together into one command with `&&`.',
        'Every call starts in the project cwd, so a `cd` lasts only for the command it is in. Quote a path that has a space in it.',
      ]
        .filter(line => line !== '')
        .join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', description: `Seconds before the command is killed. Default ${DEFAULT_TIMEOUT_S}, at most ${MAX_TIMEOUT_S}.` },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    parse: parseArgs,
    async run({ command, timeoutS }, { cwd, access, signal }): Promise<ToolResult> {
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

      return run({ command, cwd, launch, timeoutS, signal, leftRunning })
    },
  })
}

/** The full shell: the builder's and the harness editor's. */
export const BASH_TOOL = bashTool(false)

/** The planner's shell, with `writeGuard` in front of it. */
export const GUARDED_BASH_TOOL = bashTool(true)
