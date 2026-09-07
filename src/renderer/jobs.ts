// doc: docs/harness/ui.md
import { el, must, relativeTime } from './dom.js'
import { usageText } from './chat.js'
import type { AppEvent } from '../core/types.js'
import type { JobView } from '../core/jobs.js'
import type { NanoBridge } from '../ipc/contract.js'

/**
 * Background subagents. A job has no stream of its own — it is not the
 * conversation on screen — so the strip is a row per job with its last line,
 * and clicking a row opens the whole of it: the task as the parent phrased it,
 * the full note or result, and what it cost.
 *
 * The strip hides itself when there is nothing running and nothing finished,
 * which is most of the time.
 */

const panel = must<HTMLElement>('jobs')
const list = must<HTMLElement>('job-list')

const sheet = must<HTMLDialogElement>('job-dialog')
const sheetTitle = must<HTMLElement>('job-dialog-title')
const sheetState = must<HTMLElement>('job-dialog-state')
const sheetMeta = must<HTMLElement>('job-dialog-meta')
const sheetTask = must<HTMLElement>('job-dialog-task')
const sheetNoteLabel = must<HTMLElement>('job-dialog-note-label')
const sheetNote = must<HTMLElement>('job-dialog-note')
const sheetCopy = must<HTMLButtonElement>('job-dialog-copy')
const sheetClose = must<HTMLButtonElement>('job-dialog-close')

let jobs: JobView[] = []
/** The job the sheet is showing, so a live update redraws it in place. */
let open: string | null = null
/** Ticks the elapsed time of a running job while its sheet is open. */
let tick: number | null = null
/** Set while the copy button is showing what happened, so a redraw leaves it alone. */
let copyNote = false

const LABEL: Record<JobView['state'], string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/** What the job's last line actually is, which depends on how it ended. */
const NOTE_LABEL: Record<JobView['state'], string> = {
  running: 'Last update',
  done: 'Result',
  failed: 'Error',
  stopped: 'Last update',
}

/** The copy button says what it will copy, which is not always a result. */
const COPY_LABEL: Record<JobView['state'], string> = {
  running: 'Copy update',
  done: 'Copy result',
  failed: 'Copy error',
  stopped: 'Copy update',
}

function render(): void {
  panel.hidden = jobs.length === 0
  list.replaceChildren()
  for (const job of jobs) {
    const row = el('button', `job-row ${job.state}`)
    row.type = 'button'
    row.setAttribute('aria-label', `${job.role} job, ${LABEL[job.state]}`)
    const head = el('div', 'job-head')
    head.append(el('span', 'job-role', job.role), el('span', 'job-state', LABEL[job.state]))
    row.append(head, el('p', 'job-note', job.note))
    row.addEventListener('click', () => inspect(job.id))
    list.append(row)
  }
}

function ran(job: JobView): string {
  const end = job.endedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - job.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * The sheet is redrawn rather than rebuilt, so a job that finishes while the
 * user is reading it turns into its own result under their eyes.
 */
function draw(job: JobView): void {
  sheetTitle.textContent = `${job.role} · ${job.mode}`
  sheetState.textContent = LABEL[job.state]
  sheetState.className = `job-state ${job.state}`

  const spent = job.usage.input + job.usage.output + job.usage.cacheRead
  const parts = [
    `started ${relativeTime(job.startedAt)}`,
    `${job.state === 'running' ? 'running for' : 'ran'} ${ran(job)}`,
  ]
  if (spent > 0) parts.push(usageText(job.usage))
  sheetMeta.textContent = parts.join(' · ')

  sheetTask.textContent = job.task
  sheetNoteLabel.textContent = NOTE_LABEL[job.state]
  sheetNote.textContent = job.note
  // Nothing to copy until the job has said something worth keeping.
  sheetCopy.hidden = job.state === 'running'
  // "Copied" is the button answering the user. A redraw a moment later must not
  // take that answer away before they have read it.
  if (!copyNote) sheetCopy.textContent = COPY_LABEL[job.state]
}

function inspect(id: string): void {
  const job = jobs.find(entry => entry.id === id)
  if (job === undefined) return
  open = id
  copyNote = false
  draw(job)
  if (!sheet.open) sheet.showModal()
  sheetClose.focus()
  // A running job has nothing to say between updates, and a stopped clock next
  // to something that is still working reads as something that has stalled.
  if (tick === null) tick = window.setInterval(() => redraw(), 1000)
}

function redraw(): void {
  if (open === null) return
  const showing = jobs.find(job => job.id === open)
  if (showing !== undefined) draw(showing)
}

sheetClose.addEventListener('click', () => sheet.close())
sheet.addEventListener('close', () => {
  open = null
  if (tick !== null) {
    window.clearInterval(tick)
    tick = null
  }
})

sheetCopy.addEventListener('click', () => {
  copyNote = true
  void navigator.clipboard
    .writeText(sheetNote.textContent ?? '')
    .then(() => {
      sheetCopy.textContent = 'Copied'
    })
    .catch(() => {
      sheetCopy.textContent = 'Copy failed'
    })
})

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
  redraw()
}

/**
 * Jobs live in the main process for as long as the app runs, so a reloaded
 * window asks for the list rather than starting empty and pretending.
 */
export async function initJobs(bridge: NanoBridge): Promise<void> {
  jobs = await bridge.jobs().catch(() => [])
  render()
}
