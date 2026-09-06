// doc: docs/harness/ui.md
import { el, must } from './dom.js'
import type { AppEvent } from '../core/types.js'
import type { JobView } from '../core/jobs.js'
import type { NanoBridge } from '../ipc/contract.js'

/**
 * Background subagents. A job has no stream of its own — it is not the
 * conversation on screen — so this strip is the whole of what the user sees of
 * it: which agent, what it was asked, and its last line.
 *
 * The strip hides itself when there is nothing running and nothing finished,
 * which is most of the time.
 */

const panel = must<HTMLElement>('jobs')
const list = must<HTMLElement>('job-list')

let jobs: JobView[] = []

const LABEL: Record<JobView['state'], string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

function render(): void {
  panel.hidden = jobs.length === 0
  list.replaceChildren()
  for (const job of jobs) {
    const row = el('div', `job-row ${job.state}`)
    row.title = `${job.role} · ${job.mode}\n${job.task}\n\n${job.note}`
    const head = el('div', 'job-head')
    head.append(el('span', 'job-role', job.role), el('span', 'job-state', LABEL[job.state]))
    row.append(head, el('p', 'job-note', job.note))
    list.append(row)
  }
}

/** Fold a job event into the list. Anything else is not ours. */
export function handleJobEvent(event: AppEvent): void {
  if (event.type === 'job.started') {
    jobs = [event.job, ...jobs]
  } else if (event.type === 'job.finished') {
    jobs = jobs.map(job => (job.id === event.job.id ? event.job : job))
  } else if (event.type === 'job.update') {
    jobs = jobs.map(job => (job.id === event.jobId ? { ...job, note: event.note } : job))
  } else {
    return
  }
  render()
}

/**
 * Jobs live in the main process for as long as the app runs, so a reloaded
 * window asks for the list rather than starting empty and pretending.
 */
export async function initJobs(bridge: NanoBridge): Promise<void> {
  jobs = await bridge.jobs().catch(() => [])
  render()
}
