// doc: docs/harness/hooks.md
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { shellLaunch } from '../env/shell.js'
import type { HookEvent, HookSpec } from './config.js'

/**
 * How much of a hook's stdout and of its stderr is kept, in characters. Enough
 * for a test run's failures or a linter's report; a hook that prints more is
 * cut here, before it reaches the model and costs a round of tokens.
 */
const OUTPUT_CAP = 10_000

/** The exit status that stops the action, with stderr as the reason. */
const BLOCK_EXIT = 2

/**
 * How long the pipes get once a hook has exited. A process the hook left
 * running, a server started with `&`, holds them open for as long as it runs,
 * so the hook's output is whatever arrived by then and the process is left
 * alone.
 */
const PIPE_GRACE_MS = 1_000

/** Every hook running now, so quitting the app can stop them. */
const running = new Set<ChildProcess>()

/** Stop every hook still running, with everything it started. */
export function stopHooks(): void {
  for (const child of running) killTree(child)
}

/** What every hook for one event said, together. */
export interface HookVerdict {
  /** The first refusal, with its reason. The hooks after it do not run. Null when none refused. */
  block: string | null
  /** What the hooks asked the model to see, in the order they ran. */
  context: string[]
  /** Hooks that could not run, ran out of time or failed, each in words for a note. */
  problems: string[]
}

/** What one hook said. */
type Outcome = { kind: 'block'; reason: string } | { kind: 'context'; text: string } | { kind: 'problem'; text: string } | { kind: 'quiet' }

/**
 * The hooks one session runs. Loaded once when the session is built and never
 * re-read inside it, so a file edited halfway through a turn cannot change
 * what the rest of the turn does.
 */
export class Hooks {
  constructor(
    private readonly specs: readonly HookSpec[],
    private readonly cwd: string,
  ) {}

  has(event: HookEvent): boolean {
    return this.specs.some(spec => spec.event === event)
  }

  /**
   * The hooks a subagent runs: the tool hooks and nothing else. A subagent's
   * answer goes back to the agent that started it, which is where a Stop hook
   * already runs, and its session start is the parent's.
   */
  forSubagent(): Hooks {
    return new Hooks(
      this.specs.filter(spec => spec.event === 'PreToolUse' || spec.event === 'PostToolUse'),
      this.cwd,
    )
  }

  /**
   * Run every hook for `event`, one after another in the order the files list
   * them, global first. `tool` is the tool name the `match` patterns test.
   * The hook reads `event`, `sessionId`, `cwd` and `fields` as one JSON object
   * on stdin. `signal` is the turn's: stopping the turn stops the hook running
   * and skips the rest, quietly, since the user asked for it.
   */
  async run(
    event: HookEvent,
    sessionId: string,
    fields: Record<string, unknown>,
    options: { tool?: string; signal?: AbortSignal } = {},
  ): Promise<HookVerdict> {
    const { tool, signal } = options
    const verdict: HookVerdict = { block: null, context: [], problems: [] }
    const input = JSON.stringify({ event, sessionId, cwd: this.cwd, ...fields })
    for (const spec of this.specs) {
      if (signal?.aborted === true) break
      if (spec.event !== event) continue
      if (spec.match !== undefined && (tool === undefined || !spec.match.test(tool))) continue
      const outcome = await runOne(spec, input, this.cwd, signal)
      if (outcome.kind === 'block') {
        verdict.block = outcome.reason
        break
      }
      if (outcome.kind === 'context') verdict.context.push(outcome.text)
      else if (outcome.kind === 'problem') verdict.problems.push(outcome.text)
    }
    return verdict
  }
}

/**
 * What the agent is told about the hooks, for its system prompt: that they
 * exist and how their words reach it, and what the SessionStart hooks printed.
 * Nothing when the session has no hooks.
 */
export function hooksBlock(hooks: Hooks, started: readonly string[]): string[] {
  const lines: string[] = []
  const tools = hooks.has('PreToolUse') || hooks.has('PostToolUse')
  const stop = hooks.has('Stop')
  if (tools || stop) lines.push('', 'The user has hooks: commands of theirs that run at set points in your work. Treat what they say as the user\'s own checks.')
  if (tools) lines.push('A tool result can end with lines marked [PreToolUse hook] or [PostToolUse hook]. A call a hook refused stays refused.')
  if (stop) lines.push('When you finish an answer, a Stop hook can reply in place of the user. Its message is work still to do.')
  if (started.length > 0) lines.push('', 'The SessionStart hooks printed this when the session opened:', ...started)
  return lines
}

/** A hook as a note names it: its first line, shortened, and the file it is in. */
function label(spec: HookSpec): string {
  const line = spec.command.trim().split('\n')[0] ?? ''
  const short = line.length > 60 ? `${line.slice(0, 57)}...` : line
  return `${spec.event} hook "${short}" (${spec.source})`
}

/** Collects a stream's text up to the cap and drops the rest. */
function collector(): { add(chunk: Buffer): void; text(): string } {
  let text = ''
  let cut = false
  return {
    add(chunk) {
      if (text.length >= OUTPUT_CAP) {
        cut = true
        return
      }
      text += chunk.toString('utf8')
      if (text.length > OUTPUT_CAP) {
        text = text.slice(0, OUTPUT_CAP)
        cut = true
      }
    },
    text: () => (cut ? `${text}\n[hook output cut at ${OUTPUT_CAP} characters]` : text),
  }
}

/**
 * End a hook and everything it started. Whatever the script ran holds its
 * pipes open, so ending bash alone would leave the harness waiting on a
 * `sleep` or a test run. POSIX kills the process group the hook leads;
 * Windows has `taskkill` walk the tree.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined)
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The group has already gone.
  }
}

function runOne(spec: HookSpec, input: string, cwd: string, signal?: AbortSignal): Promise<Outcome> {
  const launch = shellLaunch()
  if (launch === null) return Promise.resolve({ kind: 'problem', text: `${label(spec)} did not run: there is no bash to run it with` })

  return new Promise<Outcome>(resolve => {
    const child = spawn(launch.bin, [...launch.args, '-c', spec.command], {
      cwd,
      env: launch.env,
      windowsHide: true,
      // Its own process group on POSIX, so a timeout can end all of it.
      detached: process.platform !== 'win32',
    })
    running.add(child)
    const stdout = collector()
    const stderr = collector()
    let settled = false
    let grace: NodeJS.Timeout | undefined
    const settle = (outcome: Outcome): void => {
      clearTimeout(timer)
      clearTimeout(grace)
      signal?.removeEventListener('abort', abort)
      running.delete(child)
      if (settled) return
      settled = true
      resolve(outcome)
    }
    // The timeout and a stop settle at once and do not wait for `close`, which
    // waits for every process holding the pipes to let go.
    const timer = setTimeout(() => {
      settle({ kind: 'problem', text: `${label(spec)} ran out of time after ${spec.timeoutMs / 1000}s and was stopped` })
      killTree(child)
    }, spec.timeoutMs)
    const abort = (): void => {
      settle({ kind: 'quiet' })
      killTree(child)
    }
    signal?.addEventListener('abort', abort)

    child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk))
    // A hook that exits without reading its input closes the pipe under the
    // write. That is its choice to make, and not an error.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)

    child.on('error', err => settle({ kind: 'problem', text: `${label(spec)} could not start: ${err.message}` }))

    const finish = (code: number | null): void => {
      if (settled) return
      const out = stdout.text().trim()
      const err = stderr.text().trim()
      if (code === BLOCK_EXIT) {
        settle({ kind: 'block', reason: err || out || `${label(spec)} refused without saying why` })
        return
      }
      if (code !== 0) {
        const first = (err || out).split('\n')[0] ?? ''
        settle({ kind: 'problem', text: `${label(spec)} exited ${code ?? 'on a signal'}${first === '' ? '' : `: ${first}`}` })
        return
      }
      settle(readOutput(out))
    }
    child.on('exit', code => {
      grace = setTimeout(() => {
        finish(code)
        child.stdout.destroy()
        child.stderr.destroy()
      }, PIPE_GRACE_MS)
    })
    child.on('close', code => finish(code))
  })
}

/**
 * What a hook that exited 0 printed. A JSON object is read for `block` and
 * `context`; anything else that is not blank is context as it stands.
 */
function readOutput(out: string): Outcome {
  if (out === '') return { kind: 'quiet' }
  if (!out.startsWith('{')) return { kind: 'context', text: out }
  let parsed: { block?: unknown; context?: unknown }
  try {
    // Text that opens with a brace and parses is an object.
    parsed = JSON.parse(out) as { block?: unknown; context?: unknown }
  } catch {
    return { kind: 'context', text: out }
  }
  const { block, context } = parsed
  if (typeof block === 'string' && block.trim() !== '') return { kind: 'block', reason: block.trim() }
  if (typeof context === 'string' && context.trim() !== '') return { kind: 'context', text: context.trim() }
  return { kind: 'quiet' }
}
