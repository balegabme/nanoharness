// doc: docs/harness/agents.md
import { randomUUID } from 'node:crypto'
import { emptyUsage } from './types.js'
import type { EventBus } from './event-bus.js'
import type { TurnUsage } from './types.js'
import type { AgentRole } from './agents.js'
import type { SpawnMode } from './spawn.js'

/**
 * A background job is a subagent nobody is waiting on. The turn that started it
 * returns immediately with a job id, and the job reports through events so the
 * window can show it running while the conversation carries on.
 *
 * The registry is deliberately in-memory: a job is a thing that is happening,
 * and a job that was happening when the app was killed is not resumable — its
 * subagent died with the process. What survives is whatever the job wrote to
 * disk before it stopped.
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
  state: JobState
  /** The job's own last word: a `job_update` note, or how it ended. */
  note: string
  usage: TurnUsage
  startedAt: number
  endedAt?: number
}

export interface JobStart {
  sessionId: string
  role: AgentRole
  mode: SpawnMode
  task: string
}

export interface JobEnd {
  state: Exclude<JobState, 'running'>
  note: string
  usage?: TurnUsage
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
    job.endedAt = Date.now()
    this.bus.emit({ type: 'job.finished', job: { ...job }, at: job.endedAt })
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id)
    return job === undefined ? undefined : { ...job }
  }

  /** Newest first, the way the window lists them. */
  list(): JobView[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(job => ({ ...job }))
  }
}
