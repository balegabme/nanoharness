// doc: docs/harness/agents.md
import { randomUUID } from 'node:crypto'
import { emptyUsage } from './types.js'
import type { EventBus } from './event-bus.js'
import type { ToolStats, TurnUsage } from './types.js'
import type { AgentRole } from './agents.js'
import type { SpawnMode } from './spawn.js'

/**
 * The subagents that are running right now: what each was asked, and its last
 * line. Background and foreground spawns both get an entry: a foreground spawn
 * blocks the parent's turn, and the window has to be able to say what it is
 * waiting for.
 *
 * A job's id is also the subagent's session id, which is how its stream events
 * find the window (`src/core/spawn.ts`).
 *
 * An entry is dropped the moment its subagent finishes. By then the child's
 * whole conversation has been written to disk, so the record is the transcript
 * and this is only ever a list of what is in flight. That is also why nothing
 * here is persisted: a job that was running when the app closed died with the
 * process and cannot be resumed.
 */

export type JobState = 'running' | 'done' | 'failed' | 'stopped'

export interface JobView {
  id: string
  /** The session whose turn asked for this job. */
  sessionId: string
  role: AgentRole
  mode: SpawnMode
  /** What it was asked to do, as the parent phrased it. */
  task: string
  /** False when the parent's turn is blocked waiting for this one. */
  background: boolean
  state: JobState
  /** The job's own last word: a `job_update` note, or how it ended. */
  note: string
  usage: TurnUsage
  /**
   * Its own tool calls: how many, how many worked. Absent until the job ends,
   * and still absent when it ended without the count reaching here, such as a
   * job abandoned at app close. A zero count is a claim that it did nothing,
   * which for a job that ran for a minute is the wrong thing to say.
   */
  tools?: ToolStats
  startedAt: number
  endedAt?: number
}

export interface JobStart {
  sessionId: string
  role: AgentRole
  mode: SpawnMode
  task: string
  background: boolean
}

export interface JobEnd {
  state: Exclude<JobState, 'running'>
  note: string
  usage?: TurnUsage
  tools?: ToolStats
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobView>()

  constructor(private readonly bus: EventBus) {}

  start(spec: JobStart): JobView {
    const job: JobView = {
      id: randomUUID(),
      ...spec,
      state: 'running',
      note: 'started',
      usage: emptyUsage(),
      startedAt: Date.now(),
    }
    this.jobs.set(job.id, job)
    this.bus.emit({ type: 'job.started', job: { ...job }, at: job.startedAt })
    return job
  }

  /** A line of progress from the job itself, through the `job_update` tool. */
  update(id: string, note: string): boolean {
    const job = this.jobs.get(id)
    if (job === undefined || job.state !== 'running') return false
    job.note = note
    this.bus.emit({ type: 'job.update', jobId: id, note, at: Date.now() })
    return true
  }

  finish(id: string, end: JobEnd): void {
    const job = this.jobs.get(id)
    if (job === undefined) return
    job.state = end.state
    job.note = end.note
    if (end.usage !== undefined) job.usage = end.usage
    if (end.tools !== undefined) job.tools = end.tools
    job.endedAt = Date.now()
    this.bus.emit({ type: 'job.finished', job: { ...job }, at: job.endedAt })
    // The event carries everything the entry held, and the transcript on disk
    // holds the rest. Keeping it here as well would be a list that only grows.
    this.jobs.delete(id)
  }

  /**
   * Everything still running, ended as `stopped` because the process that was
   * running it is going away. The job's answer will never arrive, and the
   * conversation has to carry that: the returned views are what the caller
   * needs to say so in the transcript, so the last word is not a promise
   * nothing will keep.
   */
  abandon(note: string): JobView[] {
    const running = [...this.jobs.values()].filter(job => job.state === 'running')
    for (const job of running) this.finish(job.id, { state: 'stopped', note })
    return running.map(job => ({ ...job }))
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id)
    return job === undefined ? undefined : { ...job }
  }

  /** What is running, newest first: what a reloaded window asks for. */
  list(): JobView[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(job => ({ ...job }))
  }
}
