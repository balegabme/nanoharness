// doc: docs/harness/agents.md
import { costOf } from './cost.js'
import { EventBus } from './event-bus.js'
import { Session } from './session.js'
import type { Tool } from './session.js'
import type { AccessGate } from './scope.js'
import type { ChatProvider } from './provider.js'
import type { ChatMessage, SessionNote, ToolStats, TurnUsage } from './types.js'
import type { Effort, ModelFacts } from './config.js'
import type { AgentRole } from './agents.js'
import type { JobRegistry, JobView } from './jobs.js'
import type { SecretVault } from './secrets.js'

/**
 * Three ways to hand work to another agent, cheapest last (plan §5):
 *
 * - `distinct`: its own system prompt and its own tools. Nothing of the
 *   parent's prefix is reusable, so every token is paid at the uncached rate.
 *   Worth it when the isolation is the point, such as a harness edit that must
 *   not see the project's conversation.
 * - `clone`: the parent's exact prompt, tools and history. The prefix bytes
 *   match, so the provider's cache answers most of it, and the clone differs
 *   only in the task appended at the end.
 * - Staying in the main loop. There is no mode for it because it is what
 *   happens when nobody calls `spawn`. It is the right answer for sequential
 *   work, and the tool description says so.
 */
export type SpawnMode = 'distinct' | 'clone'

export const SPAWN_MODES: readonly SpawnMode[] = ['distinct', 'clone']

export function isSpawnMode(value: unknown): value is SpawnMode {
  return typeof value === 'string' && (SPAWN_MODES as readonly string[]).includes(value)
}

export interface SpawnRequest {
  role: AgentRole
  mode: SpawnMode
  task: string
}

/**
 * A subagent that threw, carrying what it had already spent and done. The job
 * row and the conversation on disk are written from two different places, and
 * the child session is gone by the time the row is finished; without this the
 * row says "no tool calls" for an agent whose stored conversation shows forty.
 * The message is the original failure's, since that is what the parent reads.
 */
class SubagentFailure extends Error {
  constructor(
    cause: unknown,
    readonly usage: TurnUsage,
    readonly tools: ToolStats,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'SubagentFailure'
  }
}

export interface SpawnResult {
  /**
   * The job's id, which is also the subagent's session id and the name of its
   * stored transcript. It goes back to the parent inside the tool result, so
   * the conversation itself says where the subagent's own conversation is.
   */
  id: string
  summary: string
  /** The mode it actually ran in, which is not always the one asked for. */
  mode: SpawnMode
  usage: TurnUsage
  /** How much tool work went into the summary above. */
  tools: ToolStats
  /** How long the parent waited for it, start to answer. */
  ms: number
  /** Priced at the model the parent is on, or null when nobody priced it. */
  costUsd: number | null
  /** True when the user's stop ended it, so the agent never finished. */
  stopped: boolean
}

export interface SpawnHost {
  /** Run the subagent now; the parent's turn waits for the summary. */
  run(request: SpawnRequest): Promise<SpawnResult>
  /** Start it and return the job; the parent's turn carries on without it. */
  background(request: SpawnRequest): JobView
  /**
   * End every subagent this session still has running. The user's stop is a
   * stop of the whole session: a background job nothing is waiting on would
   * otherwise keep spending after the window said it had stopped.
   */
  stopAll(): void
}

/** One subagent's own conversation, for storing beside the parent's. */
export interface SubagentRecord {
  request: SpawnRequest
  state: 'done' | 'failed' | 'stopped'
  /** Its last word: the answer, or why it ended. */
  note: string
  usage: TurnUsage
  tools: ToolStats
  messages: ChatMessage[]
  notes: SessionNote[]
}

/** One subagent's identity while it runs: its job entry, and how it was started. */
export interface SubagentSlot {
  id: string
  background: boolean
}

/** What one subagent needs to exist, minus everything it inherits. */
export interface SubagentSetup {
  systemPrompt: string
  tools: Tool[]
  history?: ChatMessage[]
  effort?: Effort
}

export interface SpawnDeps {
  /** The session whose turn is spawning. Jobs are listed under it. */
  sessionId: string
  /** The parent's own role, which is the only role a clone can have. */
  role: AgentRole
  cwd: string
  model: string
  /** What is known about that model, so a subagent's turns are priced and capped like the parent's. */
  facts?: ModelFacts
  provider: ChatProvider
  /** The parent's gate: a subagent is held to exactly the parent's boundary. */
  access: AccessGate
  jobs: JobRegistry
  /**
   * The subagent's prompt and tools. `slot.background` says whether the parent
   * is waiting, which is what decides whether the child gets `job_update`: a
   * foreground child reports by finishing, and has nobody to report to before
   * that.
   */
  setup(request: SpawnRequest, slot: SubagentSlot): Promise<SubagentSetup>
  /**
   * A bus for one subagent's own stream. The window listens to it, so a
   * subagent can be watched while it works: its thinking, its tool calls and
   * its answer arrive as the same events the main agent emits, under the job's
   * id instead of the session's.
   */
  bus?(slot: SubagentSlot): EventBus
  /** The session's vault, so a subagent can use the same keys the parent can. */
  secrets?: SecretVault
  /**
   * Write the subagent's own conversation down, once it has stopped running.
   *
   * A subagent's stream is a second conversation. Folding it into the parent's
   * would make the parent's file unreadable, so it is stored beside it and
   * referenced from the tool result. Without this a subagent is the one thing
   * in the app nobody can go back and read: the summary survives and everything
   * it did to arrive at it is gone.
   *
   * A failure to write must not fail the turn, since the parent is waiting on
   * an answer that is already in hand, so it goes to `problem` instead of being
   * thrown.
   */
  save?(slot: SubagentSlot, record: SubagentRecord): Promise<void> | void
  /**
   * The harness broke around a subagent whose own work was fine. Today that
   * means one thing: its transcript could not be written.
   *
   * The write can fail without failing the turn, and it still has to be said
   * out loud. The tool result carries `[subagent:<id>]`, so the window goes on
   * offering to open a conversation that was never saved, and the user would
   * find that out by clicking it. The app points this at the session's notes,
   * where the user is already looking. With no handler it goes to stderr.
   */
  problem?(text: string): void
  /**
   * A background subagent has finished, with the whole of what it answered.
   *
   * A foreground spawn needs nothing like this: its answer is the tool result.
   * A background one has no tool result to come back to. Without this callback
   * its answer would reach the window and never the model, and three background
   * jobs followed by "now combine what they found" would be an impossible
   * request.
   *
   * So the answer goes to the parent's conversation, and the parent decides
   * when to fold it in, because a message cannot be inserted between a tool
   * call and its result. `state` is 'failed' when it threw, since a job that
   * died is a fact the parent is planning around.
   */
  finished?(slot: SubagentSlot, outcome: { request: SpawnRequest; state: SubagentRecord['state']; answer: string }): void
}

/** How a subagent ended, worded to drop into a sentence about it. */
const ENDED: Record<SubagentRecord['state'], string> = {
  done: 'finished',
  failed: 'failed',
  stopped: 'was stopped',
}

/**
 * A job row is a label, and one click away is the answer it labels.
 *
 * This is the only length limit in this file. The answer itself is handed over
 * whole, bounded only by the model's own output limit.
 */
const HEADLINE_CAP = 200

export function createSpawnHost(deps: SpawnDeps): SpawnHost {
  /**
   * The subagents that are running right now, so the stop button can reach
   * them. A finished one is dropped: stopping it would do nothing, and holding
   * it would hold its whole conversation for as long as the parent lives.
   */
  const live = new Map<string, Session>()

  /**
   * A clone is the parent one message later: the parent's prompt, the parent's
   * tool list. Cloning "as a planner" would relabel the job and change nothing
   * the agent can do, because the clone still has the parent's role and the
   * parent's tools. Asking for another role is asking for a distinct agent, so
   * that is what it gets, under its own name.
   */
  function resolve(request: SpawnRequest): SpawnRequest {
    if (request.mode !== 'clone' || request.role === deps.role) return request
    return { ...request, mode: 'distinct' }
  }

  async function execute(request: SpawnRequest, slot: SubagentSlot): Promise<SpawnResult> {
    const setup = await deps.setup(request, slot)
    // A subagent's stream is a separate conversation, so it stays out of the
    // transcript the user is reading. It runs under the job's id, and the
    // window watches that id, which turns "something is happening" into a
    // stream you can open.
    const child = new Session(
      {
        sessionId: slot.id,
        cwd: deps.cwd,
        model: deps.model,
        systemPrompt: setup.systemPrompt,
        ...(deps.facts === undefined ? {} : { facts: deps.facts }),
        access: deps.access,
        ...(setup.effort === undefined ? {} : { effort: setup.effort }),
        ...(setup.history === undefined ? {} : { history: setup.history }),
        ...(deps.secrets === undefined ? {} : { secrets: deps.secrets }),
        // A background job can say where it has got to; a foreground subagent
        // has nothing to report to, because the parent is waiting for it.
        ...(slot.background ? { job: { id: slot.id, jobs: deps.jobs } } : {}),
      },
      deps.provider,
      setup.tools,
      deps.bus?.(slot) ?? new EventBus(),
    )

    live.set(slot.id, child)
    const startedAt = Date.now()
    try {
      const usage = await child.run(request.task)
      const answer = lastAnswer(child.transcript)
      const stopped = child.interrupted
      await store(request, slot, child, stopped ? 'stopped' : 'done', stopped ? 'Stopped.' : answer, usage)
      return {
        id: slot.id,
        summary: answer,
        mode: request.mode,
        usage,
        tools: child.toolStats,
        ms: Date.now() - startedAt,
        costUsd: deps.facts === undefined ? null : costOf(usage, deps.facts),
        stopped,
      }
    } catch (err) {
      await store(request, slot, child, 'failed', fail(err), child.spent)
      throw new SubagentFailure(err, child.spent, child.toolStats)
    } finally {
      live.delete(slot.id)
    }
  }

  /** The child's conversation on disk, or a reported problem when that fails. */
  async function store(
    request: SpawnRequest,
    slot: SubagentSlot,
    child: Session,
    state: SubagentRecord['state'],
    note: string,
    usage: TurnUsage,
  ): Promise<void> {
    if (deps.save === undefined) return
    try {
      await deps.save(slot, { request, state, note, usage, tools: child.toolStats, messages: child.transcript, notes: child.notes })
    } catch (err) {
      // This runs on all three ways out, so the sentence says which one it
      // was: a subagent that failed or was stopped is exactly the one whose
      // conversation is worth reading.
      report(
        `The ${request.role} subagent ${ENDED[state]}, but its conversation could not be written: ${fail(err)}. Opening it from the tool call will find nothing.`,
      )
    }
  }

  /** The caller's channel, or stderr when there is none. It always lands somewhere. */
  function report(text: string): void {
    if (deps.problem === undefined) process.stderr.write(`nanoharness: ${text}\n`)
    else deps.problem(text)
  }

  function open(request: SpawnRequest, background: boolean): JobView {
    return deps.jobs.start({ sessionId: deps.sessionId, role: request.role, mode: request.mode, task: request.task, background })
  }

  function fail(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  /**
   * What a failed job had spent and done, when the failure kept a record of it.
   * A failure from anywhere else leaves both out; zeroes would draw as an
   * agent that did nothing.
   */
  function ledger(err: unknown): { usage?: TurnUsage; tools?: ToolStats } {
    if (err instanceof SubagentFailure) return { usage: err.usage, tools: err.tools }
    return {}
  }

  return {
    /**
     * A foreground subagent gets a job entry too, so the blocking case is a row
     * like any other and that row streams. Without one, the parent's turn stops
     * dead while another agent spends money for a minute behind a spinner.
     */
    async run(raw) {
      const request = resolve(raw)
      const job = open(request, false)
      try {
        const result = await execute(request, { id: job.id, background: false })
        deps.jobs.finish(job.id, {
          state: result.stopped ? 'stopped' : 'done',
          note: headline(result.summary),
          usage: result.usage,
          tools: result.tools,
        })
        return result
      } catch (err) {
        deps.jobs.finish(job.id, { state: 'failed', note: fail(err), ...ledger(err) })
        throw err
      }
    },

    background(raw) {
      const request = resolve(raw)
      const job = open(request, true)
      // Deliberately not awaited: the point of a background job is that the
      // parent's turn does not block on it. Every path ends in `finish`, so a
      // job can never be left running in the list.
      const slot = { id: job.id, background: true }
      void execute(request, slot)
        .then(result => {
          const state = result.stopped ? 'stopped' : 'done'
          deps.jobs.finish(job.id, { state, note: headline(result.summary), usage: result.usage, tools: result.tools })
          // After `finish`, so the row is already in its final state when the
          // parent is handed the thing that row is about.
          deps.finished?.(slot, { request, state, answer: result.summary })
        })
        .catch((err: unknown) => {
          deps.jobs.finish(job.id, { state: 'failed', note: fail(err), ...ledger(err) })
          deps.finished?.(slot, { request, state: 'failed', answer: fail(err) })
        })
      return job
    },

    stopAll() {
      for (const child of live.values()) child.stop()
    },
  }
}

/**
 * The parent's history as a clone may see it: everything before the turn that
 * is still in flight.
 *
 * The spawning assistant message is the last thing in the parent's transcript,
 * and its tool calls have no results yet, because the parent is inside one of
 * them. A provider will not take a conversation that ends on an unanswered tool
 * call: OpenAI rejects it outright ("an assistant message with 'tool_calls'
 * must be followed by tool messages"). Cutting the in-flight turn leaves the
 * clone starting from the user's own last message, which is what it is being
 * asked about.
 */
export function cloneHistory(transcript: readonly ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>()
  for (const message of transcript) if (message.role === 'tool') answered.add(message.toolCallId)
  const cut = transcript.findIndex(
    message => message.role === 'assistant' && (message.toolCalls ?? []).some(call => !answered.has(call.id)),
  )
  return [...(cut < 0 ? transcript : transcript.slice(0, cut))]
}

/** The subagent's last word, whole. What the parent is given is decided above. */
function lastAnswer(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i]
    if (message?.role !== 'assistant') continue
    const text = message.content.trim()
    if (text === '') continue
    return text
  }
  return '(the subagent finished without an answer)'
}

/** The first line of an answer, for a row in a list. */
function headline(answer: string): string {
  const line = answer.trim().split('\n')[0] ?? ''
  return line.length > HEADLINE_CAP ? `${line.slice(0, HEADLINE_CAP - 1)}…` : line
}
