// doc: docs/harness/agents.md
import { EventBus } from './event-bus.js'
import { Session } from './session.js'
import { emptyUsage } from './types.js'
import type { Tool } from './session.js'
import type { AccessGate } from './scope.js'
import type { ChatProvider } from './provider.js'
import type { ChatMessage, TurnUsage } from './types.js'
import type { Effort } from './config.js'
import type { AgentRole } from './agents.js'
import type { JobRegistry, JobView } from './jobs.js'

/**
 * Three ways to hand work to another agent, cheapest last (plan §5):
 *
 * - `distinct` — its own system prompt and its own tools. Nothing of the
 *   parent's prefix is reusable, so every token is paid at the uncached rate.
 *   Worth it when the isolation is the point: a harness edit that must not see
 *   the project's conversation.
 * - `clone` — the parent's exact prompt, tools and history. The prefix bytes
 *   match, so the provider's cache answers most of it; the clone differs only
 *   in the task appended at the end.
 * - staying in the main loop, which is not a mode here because it is what
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

export interface SpawnResult {
  summary: string
  /** The mode it actually ran in, which is not always the one asked for. */
  mode: SpawnMode
  usage: TurnUsage
}

export interface SpawnHost {
  /** Run the subagent now; the parent's turn waits for the summary. */
  run(request: SpawnRequest): Promise<SpawnResult>
  /** Start it and return the job; the parent's turn carries on without it. */
  background(request: SpawnRequest): JobView
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
  provider: ChatProvider
  /** The parent's gate: a subagent is held to exactly the parent's boundary. */
  access: AccessGate
  jobs: JobRegistry
  maxToolRounds: number
  /**
   * The subagent's prompt and tools. `jobId` is non-null for a background job,
   * so the caller can hand that child a `job_update` tool bound to it.
   */
  setup(request: SpawnRequest, jobId: string | null): Promise<SubagentSetup>
}

/** A subagent answers with prose, and the parent pays for every word of it. */
const SUMMARY_CAP = 4000

export function createSpawnHost(deps: SpawnDeps): SpawnHost {
  /**
   * A clone is the parent one message later: the parent's prompt, the parent's
   * tool list. Cloning "as a planner" would therefore relabel the job and
   * change nothing the agent can actually do — the clone would still be the
   * parent's role, with the parent's tools. Asking for another role is asking
   * for a distinct agent, so that is what it gets, under its own name.
   */
  function resolve(request: SpawnRequest): SpawnRequest {
    if (request.mode !== 'clone' || request.role === deps.role) return request
    return { ...request, mode: 'distinct' }
  }

  async function execute(request: SpawnRequest, jobId: string | null): Promise<SpawnResult> {
    const setup = await deps.setup(request, jobId)
    // A subagent's own stream is not the parent's conversation: it gets a bus
    // nobody is listening to, and reports through its summary (or, in the
    // background, through job events) instead of scribbling on the transcript
    // the user is reading.
    const child = new Session(
      {
        sessionId: jobId ?? `${deps.sessionId}:sub`,
        cwd: deps.cwd,
        model: deps.model,
        systemPrompt: setup.systemPrompt,
        maxToolRounds: deps.maxToolRounds,
        access: deps.access,
        ...(setup.effort === undefined ? {} : { effort: setup.effort }),
        ...(setup.history === undefined ? {} : { history: setup.history }),
        // A background job can say where it has got to; a foreground subagent
        // has nothing to report to, because the parent is waiting for it.
        ...(jobId === null ? {} : { job: { id: jobId, jobs: deps.jobs } }),
      },
      deps.provider,
      setup.tools,
      new EventBus(),
    )

    const usage = await child.run(request.task)
    return { summary: lastAnswer(child.transcript), mode: request.mode, usage }
  }

  return {
    run: request => execute(resolve(request), null),

    background(raw) {
      const request = resolve(raw)
      const job = deps.jobs.start({ sessionId: deps.sessionId, role: request.role, mode: request.mode, task: request.task })
      // Deliberately not awaited: the point of a background job is that the
      // parent's turn does not block on it. Every path ends in `finish`, so a
      // job can never be left running in the list.
      void execute(request, job.id)
        .then(result => deps.jobs.finish(job.id, { state: 'done', note: result.summary, usage: result.usage }))
        .catch((err: unknown) => {
          deps.jobs.finish(job.id, { state: 'failed', note: err instanceof Error ? err.message : String(err), usage: emptyUsage() })
        })
      return job
    },
  }
}

/**
 * The parent's history as a clone may see it: everything before the turn that
 * is still in flight.
 *
 * The spawning assistant message is the last thing in the parent's transcript,
 * and its tool calls have no results yet — the parent is inside one of them.
 * A conversation that ends on an unanswered tool call is not a conversation a
 * provider will take: OpenAI rejects it outright ("an assistant message with
 * 'tool_calls' must be followed by tool messages"). So the in-flight turn is
 * cut rather than patched with a fake result, which leaves the clone starting
 * from the user's own last message — exactly what it is being asked about.
 */
export function cloneHistory(transcript: readonly ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>()
  for (const message of transcript) if (message.role === 'tool') answered.add(message.toolCallId)
  const cut = transcript.findIndex(
    message => message.role === 'assistant' && (message.toolCalls ?? []).some(call => !answered.has(call.id)),
  )
  return [...(cut < 0 ? transcript : transcript.slice(0, cut))]
}

/** The subagent's last word, which is the whole of what the parent gets back. */
function lastAnswer(transcript: ChatMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i]
    if (message?.role !== 'assistant') continue
    const text = message.content.trim()
    if (text === '') continue
    return text.length > SUMMARY_CAP ? `${text.slice(0, SUMMARY_CAP - 1)}…` : text
  }
  return '(the subagent finished without an answer)'
}
