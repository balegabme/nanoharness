// doc: docs/harness/ui.md
import type { AppEvent, ContextLedger, ToolStats, TurnUsage } from '../core/types.js'
import type { JobView } from '../core/jobs.js'
import type { NanoBridge } from '../ipc/contract.js'

/**
 * The subagents that are running right now, and what they have streamed. This
 * module holds no UI: a subagent is opened from whatever started it and drawn
 * in the same view the main agent is, so this is the bookkeeping behind it.
 *
 * Events arrive under the job id as `sessionId` and are kept per subagent, so
 * one nobody is watching can still be opened mid-run and read from the start.
 * Only running subagents are held; a finished one is already on disk.
 */

let jobs: JobView[] = []

/** An event that belongs to one agent's stream and not to the job list. */
export type StreamEvent = Extract<AppEvent, { sessionId: string }>

export interface JobHandlers {
  /** One live event from a subagent, already folded into its buffer. */
  event(event: StreamEvent): void
  /** A job's state, note or cost changed. */
  changed(job: JobView): void
  /** True while this subagent is the one on screen, so it is not forgotten under the reader. */
  viewing(id: string): boolean
}

let handlers: JobHandlers | null = null

/**
 * What each subagent has said, as the events that said it. Consecutive text or
 * thinking deltas are merged, so a long answer is one event and not one per
 * token. That keeps the buffer the size of the answer, where otherwise it
 * would be the size of the stream.
 */
const buffers = new Map<string, AppEvent[]>()

/** Events kept per subagent. A long one would otherwise grow without end. */
const BUFFER_KEEP = 3000

/** What each subagent has spent, from its own usage events as they arrive. */
const spending = new Map<string, TurnUsage>()

/**
 * Each subagent's context as of its last ledger. Kept apart from the buffer,
 * because a ledger arrives with every message and only the newest one means
 * anything.
 */
const contexts = new Map<string, ContextLedger>()

const LABEL: Record<JobView['state'], string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/**
 * How the subagent was made, in the two words that decide what it can see: a
 * `clone` carries the parent's history, a `distinct` one starts from nothing
 * but its task. That is worth a glance before reading anything it says.
 */
export function identity(job: { role: JobView['role']; mode: JobView['mode'] }): string {
  return `${agentName(job.role)} · ${job.mode}`
}

/** Roles are ids on the wire and names on screen. */
export function agentName(role: JobView['role']): string {
  return role === 'harness-editor' ? 'harness editor' : role
}

export function stateLabel(state: JobView['state']): string {
  return LABEL[state]
}

/**
 * What a subagent did to reach its answer, as the line under its card.
 * `docs/harness/agents.md` says why an answer alone is not enough to go on.
 *
 * `tools/spawn.ts` writes the same line for the model. The renderer is its own
 * bundle and takes no runtime import from `core/`, so this exists twice.
 * Change one and change the other.
 */
export function toolsText(tools: ToolStats): string {
  if (tools.calls === 0) return 'no tool calls'
  const stopped = tools.prevented === 0 ? '' : `, ${tools.prevented} prevented`
  return `${tools.calls} tool call${tools.calls === 1 ? '' : 's'}, ${tools.ok} ok, ${tools.failed} failed${stopped}`
}

/** True when this id is a subagent's, so its stream is not the open session's. */
export function isSubagent(sessionId: string): boolean {
  return jobs.some(job => job.id === sessionId)
}

export function jobById(id: string): JobView | undefined {
  return jobs.find(job => job.id === id)
}

/** One subagent's stream, oldest first, back as far as the buffer cap keeps. */
export function bufferOf(id: string): readonly AppEvent[] {
  return buffers.get(id) ?? []
}

/** What one subagent has spent, as of its last usage event. */
export function spendingOf(id: string): TurnUsage {
  return spending.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** One subagent's context, or null before its first ledger. */
export function contextOf(id: string): ContextLedger | null {
  return contexts.get(id) ?? null
}

/**
 * Drop a finished subagent. Its transcript is on disk by the time it finishes,
 * so nothing is lost: the next time it is opened it is read from there.
 * A running one is never forgotten, because its stream is still arriving.
 */
export function forget(id: string): void {
  const job = jobById(id)
  if (job !== undefined && job.state === 'running') return
  jobs = jobs.filter(entry => entry.id !== id)
  buffers.delete(id)
  spending.delete(id)
  contexts.delete(id)
}

/**
 * The longest a merged delta grows before the next one starts another event.
 * Without it one answer is one string that is rewritten on every token, and the
 * cost of that climbs with the length of the answer.
 */
const DELTA_MAX = 1500

/** Fold one event into a subagent's buffer, merging it with the last where it can. */
function buffer(event: StreamEvent): void {
  const events = buffers.get(event.sessionId) ?? []
  const last = events.at(-1)
  if (
    (event.type === 'text_delta' || event.type === 'thinking_delta') &&
    last !== undefined &&
    last.type === event.type &&
    (last.type === 'text_delta' || last.type === 'thinking_delta') &&
    last.text.length < DELTA_MAX
  ) {
    last.text += event.text
  } else {
    events.push(event)
  }
  if (events.length > BUFFER_KEEP) events.splice(0, events.length - BUFFER_KEEP)
  buffers.set(event.sessionId, events)
}

/**
 * A subagent's own stream. The caller has already established that the event
 * belongs to one of these and not to the conversation on screen.
 */
export function handleSubagentEvent(event: AppEvent): void {
  if (!('sessionId' in event)) return
  if (event.type === 'usage') spending.set(event.sessionId, event.usage)
  if (event.type === 'context') contexts.set(event.sessionId, event.ledger)
  else buffer(event)
  handlers?.event(event)
}

/** Fold a job event into what is being tracked. Anything else is not ours. */
export function handleJobEvent(event: AppEvent): void {
  if (event.type === 'job.started') {
    jobs = [event.job, ...jobs]
    handlers?.changed(event.job)
  } else if (event.type === 'job.finished') {
    jobs = jobs.map(job => (job.id === event.job.id ? event.job : job))
    handlers?.changed(event.job)
    // The one on screen is kept until the reader leaves it, so a subagent that
    // finishes while being watched does not blink out from under them.
    if (handlers?.viewing(event.job.id) !== true) forget(event.job.id)
  } else if (event.type === 'job.update') {
    jobs = jobs.map(job => (job.id === event.jobId ? { ...job, note: event.note } : job))
    const job = jobById(event.jobId)
    if (job !== undefined) handlers?.changed(job)
  }
}

/**
 * A background subagent outlives the turn that started it, so a reloaded window
 * asks the main process what is still running, so it does not start empty and
 * miss a stream that is already in flight.
 */
export async function initJobs(bridge: NanoBridge, next: JobHandlers): Promise<void> {
  handlers = next
  jobs = await bridge.jobs().catch(() => [])
}
