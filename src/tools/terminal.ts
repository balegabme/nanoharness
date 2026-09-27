// doc: docs/harness/tools.md
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { defineTool } from '../core/session.js'
import { killTree, shellLaunch, TREE } from '../env/shell.js'
import { UNATTENDED_ENV } from './bash.js'
import type { ArgsParse, Tool } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

/**
 * Shells that keep running between tool calls: a dev server, a watcher, a
 * REPL, a command that asks questions on stdin. `bash` runs one command and
 * waits for it; a terminal is started once, then read from, written to and
 * stopped by id while the turn does other things, and across turns.
 *
 * The shell talks over pipes and has no TTY. A program that insists on a
 * terminal, such as a full-screen editor or `top`, will not draw here, and
 * one that turns off its prompts without a TTY behaves as it does in CI.
 */

/** Running terminals one session may hold, so a model that forgets to stop them runs into a refusal. */
const MAX_RUNNING = 8

/** Finished terminals kept for their last output, oldest dropped first. */
const MAX_FINISHED = 8

/** Unread output kept per terminal, in characters. Older output is dropped from the front. */
const BUFFER_CAP = 256 * 1024

/** Output handed back by one call, in characters: the newest part, when there is more. */
const READ_CAP = 32 * 1024

/** The longest one call waits for output, in seconds. */
const MAX_WAIT_S = 300

/** How long `start` and `send` wait for the first output when the call names no wait. */
const DEFAULT_WAIT_S = 2

/** The longest command `start` takes, in bytes, because Git Bash cuts a `-c` string at 8 KiB. */
const COMMAND_CAP = 8_000

/** The longest `until` pattern, in characters. */
const UNTIL_CAP = 200

/**
 * How much of the newest unread output `until` is tested against, in
 * characters. The pattern is the model's and runs in the app's main process on
 * every chunk, so it only ever sees this much.
 */
const UNTIL_WINDOW = 4 * 1024

/** One terminal: a bash process started by `start`, and the output it has not handed back yet. */
class Shell {
  private unread = ''
  private dropped = 0
  /** Null while running; the exit code, or the signal's name, once it has stopped. */
  exit: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    readonly id: string,
    readonly command: string,
    readonly child: ChildProcessWithoutNullStreams,
  ) {
    const take = (chunk: string): void => {
      this.unread += chunk
      if (this.unread.length > BUFFER_CAP) {
        this.dropped += this.unread.length - BUFFER_CAP
        this.unread = this.unread.slice(-BUFFER_CAP)
      }
      this.wake()
    }
    child.stdout.setEncoding('utf8').on('data', take)
    child.stderr.setEncoding('utf8').on('data', take)
    // A program that exits without reading its input closes the pipe under a
    // later write. The exit says what happened; the write error adds nothing.
    child.stdin.on('error', () => undefined)
    child.on('error', err => {
      this.unread += `\n[could not start: ${err.message}]`
      this.exit ??= 'failed'
      this.wake()
    })
    child.on('exit', (code, signal) => {
      this.exit = code === null ? (signal ?? 'killed') : String(code)
      this.wake()
    })
  }

  get running(): boolean {
    return this.exit === null
  }

  private wake(): void {
    for (const listener of this.listeners) listener()
  }

  /**
   * Wait until there is something to say: the pattern turns up in the unread
   * output, the shell exits, or `seconds` pass. No pattern means waiting the
   * whole time, since a server that printed one line is not done printing.
   */
  wait(seconds: number, until: RegExp | undefined, signal: AbortSignal | undefined): Promise<void> {
    const ready = (): boolean => !this.running || (until !== undefined && until.test(this.unread.slice(-UNTIL_WINDOW)))
    if (seconds <= 0 || signal?.aborted === true || ready()) return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        this.listeners.delete(check)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const check = (): void => {
        if (ready()) done()
      }
      const timer = setTimeout(done, seconds * 1000)
      this.listeners.add(check)
      signal?.addEventListener('abort', done)
    })
  }

  /** The output since the last read, and the line that says what state the shell is in. */
  take(): string {
    let text = this.unread
    let lost = this.dropped
    if (text.length > READ_CAP) {
      lost += text.length - READ_CAP
      text = text.slice(-READ_CAP)
    }
    this.unread = ''
    this.dropped = 0
    const lines = [this.status()]
    if (lost > 0) lines.push(`[${lost} earlier characters of output not shown]`)
    lines.push(text.trim() === '' ? '(no new output)' : text.replace(/\s+$/, ''))
    return lines.join('\n')
  }

  status(): string {
    const state = this.running ? 'running' : `exited ${this.exit ?? ''}`.trim()
    return `[terminal ${this.id}, ${state}: ${oneLine(this.command)}]`
  }
}

function oneLine(command: string): string {
  const first = command.trim().split('\n')[0] ?? ''
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}

/** Every session's terminals, so quitting the app can stop them all. */
const everyRegistry = new Set<Terminals>()

/** Stop every terminal any session started, with everything each one started. */
export function stopTerminals(): void {
  for (const registry of everyRegistry) registry.stopAll()
}

/**
 * One session's terminals. The app keeps one per session for the whole launch,
 * so a session rebuilt after a settings change still reaches the servers it
 * started, and deleting the session stops them.
 */
export class Terminals {
  private readonly shells = new Map<string, Shell>()
  private counter = 0
  private closed = false

  constructor() {
    everyRegistry.add(this)
  }

  get(id: string): Shell | undefined {
    return this.shells.get(id)
  }

  list(): Shell[] {
    return [...this.shells.values()]
  }

  /** Start one, or say why not. */
  start(command: string, cwd: string): Shell | string {
    if (this.closed) return 'this session is gone, and its terminals with it'
    const running = this.list().filter(shell => shell.running).length
    if (running >= MAX_RUNNING) return `${running} terminals are already running; stop one first`
    const launch = shellLaunch()
    if (launch === null) return 'no shell available: git bash not found in the usual Windows paths'
    this.counter += 1
    const id = `t${this.counter}`
    // The trailing `wait` keeps bash alive while anything it put in the
    // background is still running, so the terminal reads as running for as
    // long as there is something to stop, and a stop can still find it: on
    // Windows `taskkill /T` walks the tree from a live bash and cannot reach a
    // child whose bash has exited.
    const script = `${command}\n__nh_status=$?\nwait\nexit $__nh_status`
    const child = spawn(launch.bin, [...launch.args, '-c', script], {
      cwd,
      env: { ...launch.env, ...UNATTENDED_ENV },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...TREE,
    })
    const shell = new Shell(id, command, child)
    this.shells.set(id, shell)
    this.prune()
    return shell
  }

  stop(shell: Shell): void {
    if (shell.running) killTree(shell.child)
  }

  stopAll(): void {
    for (const shell of this.shells.values()) this.stop(shell)
  }

  /** Stop them all and forget this registry, for a session that is gone. */
  close(): void {
    this.closed = true
    this.stopAll()
    everyRegistry.delete(this)
  }

  private prune(): void {
    const finished = this.list().filter(shell => !shell.running)
    for (const shell of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) this.shells.delete(shell.id)
  }
}

type TerminalArgs =
  | { action: 'start'; command: string; wait: number; until?: RegExp }
  | { action: 'send'; id: string; input: string; wait: number; until?: RegExp }
  | { action: 'read'; id: string; wait: number; until?: RegExp }
  | { action: 'stop'; id: string }
  | { action: 'list' }

function parseArgs(raw: Record<string, unknown>): ArgsParse<TerminalArgs> {
  const { action } = raw
  const wait = raw.wait ?? (action === 'read' ? 0 : DEFAULT_WAIT_S)
  if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) return { ok: false, error: 'wait must be a number of seconds' }
  const seconds = Math.min(wait, MAX_WAIT_S)
  let until: RegExp | undefined
  if (raw.until !== undefined) {
    if (typeof raw.until !== 'string' || raw.until === '') return { ok: false, error: 'until must be a non-empty regular expression' }
    if (raw.until.length > UNTIL_CAP) return { ok: false, error: `until is over ${UNTIL_CAP} characters; match a short piece of the line you are waiting for` }
    try {
      until = new RegExp(raw.until)
    } catch (err) {
      return { ok: false, error: `until is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const waits = { wait: seconds, ...(until === undefined ? {} : { until }) }
  if (action === 'list') return { ok: true, args: { action } }
  if (action === 'start') {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') return { ok: false, error: 'start needs a command' }
    // A line ending pasted from Windows would reach bash as part of the command.
    const command = raw.command.replace(/\r\n/g, '\n')
    if (Buffer.byteLength(command) > COMMAND_CAP) return { ok: false, error: `the command is over ${COMMAND_CAP} bytes; write it to a script file and start that` }
    return { ok: true, args: { action, command, ...waits } }
  }
  if (action !== 'send' && action !== 'read' && action !== 'stop') return { ok: false, error: 'action must be start, send, read, stop or list' }
  if (typeof raw.id !== 'string' || raw.id === '') return { ok: false, error: `${action} needs the terminal's id` }
  if (action === 'stop') return { ok: true, args: { action, id: raw.id } }
  if (action === 'read') return { ok: true, args: { action, id: raw.id, ...waits } }
  if (typeof raw.input !== 'string') return { ok: false, error: 'send needs input' }
  return { ok: true, args: { action, id: raw.id, input: raw.input, ...waits } }
}

function said(text: string): ToolResult {
  return { ok: true, summary: text, content: text }
}

function refused(text: string, prevented = false): ToolResult {
  return { ok: false, summary: text, content: text, isError: true, ...(prevented ? { prevented: true } : {}) }
}

export const TERMINAL_TOOL: Tool = defineTool<TerminalArgs>({
  input: {
    name: 'terminal',
    description: [
      'Shells that keep running in the background, for a server, a watcher, a long build, or a program that reads input.',
      '`start` runs a command from the project cwd and returns its id and first output. `read` returns the output since the last read. `send` writes a line to its stdin. `stop` ends it and everything it started. `list` shows them all.',
      '`wait` is how many seconds to wait for output first (start and send: 2 by default; read: 0); `until` is a regular expression that ends the wait as soon as the new output matches it, such as "ready|error".',
      'There is no TTY: full-screen programs will not draw. Use `bash` for a command that finishes on its own.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'send', 'read', 'stop', 'list'] },
        command: { type: 'string', description: 'For start: the command to run.' },
        id: { type: 'string', description: 'For send, read and stop: the id start returned, such as t1.' },
        input: { type: 'string', description: 'For send: the line to write. A newline is added.' },
        wait: { type: 'number', description: `Seconds to wait for output, at most ${MAX_WAIT_S}.` },
        until: { type: 'string', description: 'A regular expression that ends the wait when the output matches it.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run(args, { cwd, access, terminals, signal }): Promise<ToolResult> {
    if (terminals === undefined) return refused('terminals are not available to a subagent; use `bash`')
    if (args.action === 'list') {
      const shells = terminals.list()
      return said(shells.length === 0 ? 'no terminals' : shells.map(shell => shell.status()).join('\n'))
    }
    if (args.action === 'start') {
      const allowed = await access.checkCommand(args.command)
      if (!allowed.ok) return refused(allowed.reason, true)
      const shell = terminals.start(args.command, cwd)
      if (typeof shell === 'string') return refused(shell)
      await shell.wait(args.wait, args.until, signal)
      return said(shell.take())
    }
    const shell = terminals.get(args.id)
    if (shell === undefined) return refused(`no terminal ${args.id}; \`list\` shows the ones there are`)
    if (args.action === 'stop') {
      terminals.stop(shell)
      // The exit is what makes the status line true, and a tree kill is not
      // synchronous. On a busy Windows machine walking the tree takes seconds.
      await shell.wait(10, undefined, signal)
      return said(shell.take())
    }
    if (args.action === 'send') {
      if (!shell.running) return refused(`${shell.status()} nothing is reading input any more`)
      // Input to a running program can be a command to a shell, so it is asked
      // about like one. The comment line says where it is going.
      const allowed = await access.checkCommand(`# input to terminal ${shell.id} (${oneLine(shell.command)})\n${args.input}`)
      if (!allowed.ok) return refused(allowed.reason, true)
      shell.child.stdin.write(`${args.input}\n`)
    }
    await shell.wait(args.wait, args.until, signal)
    return said(shell.take())
  },
})
