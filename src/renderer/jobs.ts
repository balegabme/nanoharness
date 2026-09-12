// doc: docs/harness/ui.md
import type { AppEvent, TurnUsage } from '../core/types.js'
import type { JobView } from '../core/jobs.js'
import type { NanoBridge } from '../ipc/contract.js'

/**
 * The subagents that are running right now, and what they have streamed.
 *
 * A subagent has no place of its own in the window. It is opened from the thing
 * that started it, the `spawn` tool call in the conversation or the note a
 * background job leaves, and shown in the same view the main agent is shown
 * in. So this module holds no UI: it is the bookkeeping behind that view.
 *
 * A subagent's events arrive under its job id as `sessionId`, in the same shape
 * the main agent emits, and are kept here per subagent, so one nobody is
 * watching can still be opened mid-run and read from the beginning.
 *
 * Only running subagents are held. When one finishes, its whole conversation
 * has already been written to disk, so the buffer is dropped and opening it
 * later reads the transcript instead. That is also what makes a subagent from
 * last week open the same way as one that finished a second ago.
 */

let jobs: JobView[] = []

/** An event that belongs to one agent's stream rather than to the job list. */
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
 * thinking deltas are merged, so a long answer is one event rather than one per
 * token, which is what keeps a buffer the size of the answer instead of the
 * size of the stream.
 */
const buffers = new Map<string, AppEvent[]>()

/** Events kept per subagent. A long one would otherwise grow without end. */
const BUFFER_KEEP = 3000

/** What each subagent has spent, from its own usage events as they arrive. */
const spending = new Map<string, TurnUsage>()

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

/** True when this id is a subagent's, so its stream is not the open session's. */
export function isSubagent(sessionId: string): boolean {
  return jobs.some(job => job.id === sessionId)
}

export function jobById(id: string): JobView | undefined {
  return jobs.find(job => job.id === id)
}

/** Everything one subagent has streamed so far, oldest first. */
export function bufferOf(id: string): readonly AppEvent[] {
  return buffers.get(id) ?? []
}

/** What one subagent has spent, as of its last usage event. */
export function spendingOf(id: string): TurnUsage {
  return spending.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
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
 * belongs to one of these rather than to the conversation on screen.
 */
export function handleSubagentEvent(event: AppEvent): void {
  if (!('sessionId' in event)) return
  if (event.type === 'usage') spending.set(event.sessionId, event.usage)
  buffer(event)
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
 * asks the main process what is still running rather than starting empty and
 * missing a stream that is already in flight.
 */
export async function initJobs(bridge: NanoBridge, next: JobHandlers): Promise<void> {
  handlers = next
  jobs = await bridge.jobs().catch(() => [])
}
