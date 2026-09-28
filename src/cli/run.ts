// doc: docs/harness/cli.md
import { resolve } from 'node:path'
import { addUsage, emptyUsage } from '../shared/usage.js'
import { isEffort } from '../shared/facts.js'
import { stopHooks } from '../hooks/hooks.js'
import { Terminals, stopTerminals } from '../tools/terminal.js'
import { AGENT_ROLES, isAgentRole } from '../core/agents.js'
import { EventBus } from '../core/event-bus.js'
import { JobRegistry } from '../core/jobs.js'
import { CheckpointStore } from '../core/checkpoints.js'
import { ProjectTrust, projectTrustPath } from '../core/project-trust.js'
import { approvalProblem } from '../core/approval.js'
import { assembleSession, buildJudge, recordTurn } from '../main/assemble.js'
import { loadRunConfig, readStored } from '../main/config-store.js'
import { PermissionBroker, gateState } from '../main/permission.js'
import { flushSecrets, secretVault } from '../main/secret-store.js'
import { addWorkspace, checkpointDir, createSession, saveTranscript, sessionIdentity, setSessionRole, workspaceStatus } from '../main/workspace-store.js'
import type { AgentRole } from '../core/agents.js'
import type { Judge } from '../core/approval.js'
import type { Effort } from '../core/config.js'
import type { Session } from '../core/session.js'
import type { AppEvent, TurnUsage } from '../core/types.js'
import type { PermissionAsk, PermissionDecision } from '../ipc/contract.js'

/**
 * `nh run`: one task, start to finish, with nobody at the keyboard. The session
 * is built the way the window builds one (`src/main/assemble.ts`) and stored
 * where the window keeps its sessions, so a run shows up in the sidebar and a
 * later `nh run -c` or the window can carry it on.
 */

const RUN_HELP = `nh run: run one task in a folder and exit when the agent is done

  nh run [message..]        the task; with no message, it is read from stdin
  nh run - [message..]      stdin as well, after the message

  -m, --model P/M    provider (a saved one's id or name) and model, or a model
                     for the selected provider
  --effort LEVEL     none, minimal, low, medium, high, xhigh or max
  --dir DIR          the folder to work in (default: the current one)
  --role ROLE        ${AGENT_ROLES.join(', ')} (default: builder)
  -c, --continue     carry on the most recent session in that folder
  -s, --session ID   carry on that session, in its own folder
  --approve WHAT     what is allowed that the window would ask about:
                       none   nothing; shell commands and paths outside the
                              folder are refused (default)
                       judge  whatever the approval model allows
                       all    everything
  --format F         text (default): the answer on stdout, the rest on stderr
                     json: every event as one JSON line, then a result line
  --timeout SECONDS  stop the agent this long after its session opens

Exit status: 0 done, 1 failed, 2 bad usage, 3 timed out, 130 stopped by Ctrl+C.

Keys come from the OS credential store the window saved them to. NH_API_KEY
stands in when the store holds none for the provider. NH_BASE_URL, with
NH_API_KIND (openai, anthropic or responses), NH_API_KEY and NH_MODEL, runs on
an endpoint described wholly by the environment and ignores the settings.
`

/** A command typed wrong, answered with the help text. */
class UsageError extends Error {}

type Approve = 'none' | 'judge' | 'all'

interface RunFlags {
  message: string[]
  stdin: boolean
  model?: string
  effort?: Effort
  dir: string
  role?: AgentRole
  continue: boolean
  session?: string
  approve: Approve
  format: 'text' | 'json'
  timeoutMs?: number
}

function parseRunFlags(argv: readonly string[]): RunFlags {
  const flags: RunFlags = { message: [], stdin: false, dir: process.cwd(), continue: false, approve: 'none', format: 'text' }
  const wants = (name: string, value: string | undefined): string => {
    if (value === undefined) throw new UsageError(`${name} needs a value`)
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    if (token === '--') {
      flags.message.push(...argv.slice(i + 1))
      break
    }
    switch (token) {
      case '-':
        flags.stdin = true
        break
      case '-m':
      case '--model':
        flags.model = wants(token, argv[++i])
        break
      case '--effort': {
        const effort = wants(token, argv[++i])
        if (!isEffort(effort)) throw new UsageError(`--effort takes none, minimal, low, medium, high, xhigh or max, not ${effort}`)
        flags.effort = effort
        break
      }
      case '--dir':
        flags.dir = wants(token, argv[++i])
        break
      case '--role': {
        const role = wants(token, argv[++i])
        if (!isAgentRole(role)) throw new UsageError(`--role takes ${AGENT_ROLES.join(', ')}, not ${role}`)
        flags.role = role
        break
      }
      case '-c':
      case '--continue':
        flags.continue = true
        break
      case '-s':
      case '--session':
        flags.session = wants(token, argv[++i])
        break
      case '--approve': {
        const approve = wants(token, argv[++i])
        if (approve !== 'none' && approve !== 'judge' && approve !== 'all') throw new UsageError(`--approve takes none, judge or all, not ${approve}`)
        flags.approve = approve
        break
      }
      case '--format': {
        const format = wants(token, argv[++i])
        if (format !== 'text' && format !== 'json') throw new UsageError(`--format takes text or json, not ${format}`)
        flags.format = format
        break
      }
      case '--timeout': {
        const value = wants(token, argv[++i])
        const seconds = Number(value)
        if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError(`--timeout wants a number of seconds, got "${value}"`)
        flags.timeoutMs = seconds * 1000
        break
      }
      default:
        if (token.startsWith('-')) throw new UsageError(`unknown flag ${token}`)
        flags.message.push(token)
    }
  }
  if (flags.continue && flags.session !== undefined) throw new UsageError('--continue and --session each pick a session; give one')
  return flags
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The message a background job's answer is carried on. A job that outlives the
 * turn delivers its answer between turns, where in the window the user would
 * read it and reply. Here nobody will, so the run replies for them.
 */
const CARRY_ON = 'The background jobs you started have finished, and their answers are above. Carry on with the task.'

/** What the last line of `--format json` says about the run. */
interface RunResult {
  type: 'result'
  sessionId: string
  status: 'done' | 'failed' | 'timeout' | 'stopped'
  turns: number
  usage: TurnUsage
  /** Null when the model has no prices, or a turn's usage could not be read. */
  costUsd: number | null
  /** The agent's last answer. */
  text: string
  error?: string
}

const EXIT: Record<RunResult['status'], number> = { done: 0, failed: 1, timeout: 3, stopped: 130 }

export async function runRun(argv: readonly string[]): Promise<number> {
  const options = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv
  if (options.some(token => token === '--help' || token === '-h')) {
    process.stdout.write(RUN_HELP)
    return 0
  }
  let flags: RunFlags
  try {
    flags = parseRunFlags(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    process.stderr.write(`nh run: ${err.message}\n\n${RUN_HELP}`)
    return 2
  }
  const typed = flags.message.join(' ')
  // A terminal on stdin means nobody piped a task in, and reading it would
  // wait for input nobody knows to type.
  const piped = (flags.stdin || typed === '') && process.stdin.isTTY !== true ? await readStdin() : ''
  const message = [typed, piped.trim()].filter(part => part !== '').join('\n\n')
  if (message === '') {
    process.stderr.write(`nh run: no task given\n\n${RUN_HELP}`)
    return 2
  }

  const config = await loadRunConfig({ ...(flags.model === undefined ? {} : { model: flags.model }), ...(flags.effort === undefined ? {} : { effort: flags.effort }) })
  if (flags.approve === 'judge') {
    const stored = await readStored()
    const gap = approvalProblem(stored.approval, stored.providers)
    if (gap !== undefined) {
      process.stderr.write(`nh run: --approve judge needs an approval model: ${gap}\n`)
      return 2
    }
  }

  const sessionId = await pickSession(flags)
  const identity = await sessionIdentity(sessionId)
  if (identity === null) throw new Error(`session ${sessionId} is gone`)

  const out = new Output(flags.format, sessionId)
  const decision: PermissionDecision = flags.approve === 'all' ? 'session' : 'deny'
  const broker: PermissionBroker = new PermissionBroker(ask => {
    out.permission(ask, decision)
    broker.resolve(ask.id, decision)
  })
  const jobBus = new EventBus()
  const jobs = new JobRegistry(jobBus)
  for (const type of ['job.started', 'job.update', 'job.finished'] as const) jobBus.on(type, event => out.event(event))
  let judge: Promise<Judge> | undefined
  const terminals = new Terminals()
  // A project's hooks and MCP servers run only once the window has approved
  // the file as it reads now. Nobody is here to approve one.
  const trust = new ProjectTrust(projectTrustPath())

  const built = await assembleSession(sessionId, {
    config,
    forward: event => out.event(event),
    trust: (_kind, file) => trust.check(file, () => Promise.resolve(false)),
    broker,
    permissions: gateState(flags.approve === 'judge' ? 'auto' : 'ask'),
    judge: () => (judge ??= buildJudge(sessionId)),
    jobs,
    checkpoints: new CheckpointStore(checkpointDir(sessionId)),
    terminals,
    current: () => true,
  })
  const { session, hub } = built
  for (const problem of built.problems) session.note(problem)

  let timedOut = false
  const timer = flags.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    session.stop()
  }, flags.timeoutMs)
  // A stop between turns, while the run waits on background jobs, ends those
  // jobs and leaves the session itself unmarked, so the run keeps its own flag.
  let interrupted = false
  const interrupt = (): void => {
    if (interrupted) process.exit(130)
    interrupted = true
    session.stop()
  }
  process.on('SIGINT', interrupt)

  const vault = await secretVault()
  const spent = emptyUsage()
  let cost: number | null = 0
  let turns = 0
  let error: string | undefined
  try {
    let text = vault.capture(message).text
    for (;;) {
      await session.run(text)
      turns += 1
      addUsage(spent, session.lastTurn.usage)
      const turnCost = session.lastTurn.costUsd
      cost = cost === null || turnCost === null ? null : cost + turnCost
      await recordTurn(identity, session, text)
      if (timedOut || interrupted || session.interrupted) break
      if (!(await jobsSettled(jobs, jobBus, sessionId))) break
      if (timedOut || interrupted) break
      text = CARRY_ON
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    process.off('SIGINT', interrupt)
    // A job still out when the run ends dies with it, and the transcript says
    // so for whoever carries the session on. A failed turn can leave one
    // running, so the stop comes first.
    session.stop()
    const lost = jobs.abandon('the run ended while it was running').filter(job => job.background)
    for (const job of lost) session.deliver(`Background ${job.role} job ${job.id} never finished: the run ended while it was running, and its answer is gone. It was asked: ${job.task}`)
    if (lost.length > 0) {
      session.settle()
      await saveTranscript(sessionId, session.transcript, session.notes).catch((err: unknown) => {
        process.stderr.write(`nh run: the transcript could not be stored: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    }
    stopHooks()
    terminals.close()
    stopTerminals()
    await Promise.all([hub.close(), flushSecrets()])
  }

  const status: RunResult['status'] = error !== undefined ? 'failed' : timedOut ? 'timeout' : interrupted || session.interrupted ? 'stopped' : 'done'
  out.result({
    type: 'result',
    sessionId,
    status,
    turns,
    usage: spent,
    costUsd: cost,
    text: lastAnswer(session),
    ...(error === undefined ? {} : { error }),
  })
  return EXIT[status]
}

/**
 * Wait for this session's background jobs. True when one or more finished and
 * the agent has answers to read; false when none was running.
 */
async function jobsSettled(jobs: JobRegistry, bus: EventBus, sessionId: string): Promise<boolean> {
  const running = (): boolean => jobs.list().some(job => job.sessionId === sessionId && job.background && job.state === 'running')
  if (!running()) return false
  await new Promise<void>(done => {
    const off = bus.on('job.finished', () => {
      if (running()) return
      off()
      done()
    })
  })
  return true
}

/** The session named, the folder's latest, or a new one; the role set as asked. */
async function pickSession(flags: RunFlags): Promise<string> {
  let id: string | undefined
  if (flags.session !== undefined) {
    id = flags.session
    if ((await sessionIdentity(id)) === null) throw new Error(`no session ${id}`)
    if (flags.role !== undefined) await setSessionRole(id, flags.role)
    return id
  }
  const workspace = await addWorkspace(resolve(flags.dir))
  if (flags.continue) {
    id = (await workspaceStatus()).sessions.find(s => s.workspaceId === workspace.id)?.id
    if (id === undefined) throw new Error(`no session to continue in ${workspace.root}`)
  } else {
    id = (await createSession(workspace.id)).id
  }
  if (flags.role !== undefined) await setSessionRole(id, flags.role)
  return id
}

function lastAnswer(session: Session): string {
  const transcript = session.transcript
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i]
    if (message?.role === 'assistant' && message.content !== '') return message.content
  }
  return ''
}

/**
 * Where the run's events go. JSON prints each one as it comes. Text prints the
 * conversation's answer on stdout and a line per tool call, note and error on
 * stderr, so `nh run ... > answer.md` keeps the answer alone.
 */
class Output {
  private midLine = false

  constructor(
    private readonly format: 'text' | 'json',
    private readonly sessionId: string,
  ) {}

  event(event: AppEvent): void {
    if (this.format === 'json') {
      process.stdout.write(`${JSON.stringify(event)}\n`)
      return
    }
    // A subagent's stream is its own conversation; its answer comes back
    // through the spawn tool's result.
    if ('sessionId' in event && event.sessionId !== this.sessionId) return
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.text)
        this.midLine = !event.text.endsWith('\n')
        break
      case 'tool_call':
        this.log(`> ${event.call.name} ${oneLine(event.call.args)}`)
        break
      case 'tool_result':
        if (event.result.isError === true) this.log(`  ${oneLine(event.result.summary)}`)
        break
      case 'session.note':
        this.log(`note: ${event.text}`)
        break
      case 'session.error':
        this.log(`error: ${event.message}`)
        break
      case 'job.started':
        this.log(`job ${event.job.id} started: ${event.job.role} ${oneLine(event.job.task)}`)
        break
      case 'job.finished':
        this.log(`job ${event.job.id} ${event.job.state}`)
        break
      default:
        break
    }
  }

  permission(ask: PermissionAsk, decision: PermissionDecision): void {
    if (this.format === 'json') {
      process.stdout.write(`${JSON.stringify({ type: 'permission.request', ...ask, decision, at: Date.now() })}\n`)
      return
    }
    const what = ask.command ?? ask.paths.join(', ')
    this.log(`${decision === 'deny' ? 'refused' : 'allowed'}: ${ask.intent} ${oneLine(what)}`)
  }

  result(result: RunResult): void {
    if (this.format === 'json') {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return
    }
    if (this.midLine) process.stdout.write('\n')
    if (result.error !== undefined) this.log(`failed: ${result.error}`)
    if (result.status === 'timeout') this.log('timed out')
  }

  private log(line: string): void {
    process.stderr.write(`${line}\n`)
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat
}
