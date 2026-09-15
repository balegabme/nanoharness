// doc: docs/harness/ui.md
import { ChatView } from './chat.js'
import { autoGrow, initComposer, seat, showDock } from './composer.js'
import { el, message, must, relativeTime } from './dom.js'
import {
  bufferOf,
  forget,
  handleJobEvent,
  handleSubagentEvent,
  identity,
  initJobs,
  isSubagent,
  jobById,
  spendingOf,
  stateLabel,
  toolsText,
} from './jobs.js'
import { announce, initNotify } from './notify.js'
import { enqueue, initPermission } from './permission.js'
import { applyConfig, initSettings, latestConfig, openSettings, refreshConfig } from './settings.js'
import {
  currentStatus,
  initSidebar,
  refresh as refreshSidebar,
  select,
  selectedWorkspaceId,
  sessionById,
  setStatus,
  startSession,
  workspaceOf,
} from './sidebar.js'
import type { AgentSummary, ConfigStatus, NanoBridge } from '../ipc/contract.js'
import type { DiffOpen } from './chat.js'
import type { JobView } from '../core/jobs.js'
import type { McpServerStatus, ToolStats } from '../core/types.js'
import type { AgentRole } from '../core/agents.js'
import type { Effort } from '../core/config.js'

declare global {
  interface Window {
    nanoharness: NanoBridge
  }
}

const nh = window.nanoharness
const stream = must<HTMLElement>('stream')
const hero = must<HTMLElement>('hero')
const heroNote = must<HTMLElement>('hero-note')
const heroSettings = must<HTMLButtonElement>('hero-settings')
const composer = must<HTMLFormElement>('composer')
const input = must<HTMLTextAreaElement>('input')
const sendButton = must<HTMLButtonElement>('send')
const modelSelect = must<HTMLSelectElement>('model-select')
const effortSelect = must<HTMLSelectElement>('effort-select')
const agentSelect = must<HTMLSelectElement>('agent-select')
const chipValues = new Map<HTMLSelectElement, HTMLElement>([
  [must<HTMLSelectElement>('agent-select'), must<HTMLElement>('agent-value')],
  [must<HTMLSelectElement>('model-select'), must<HTMLElement>('model-value')],
  [must<HTMLSelectElement>('effort-select'), must<HTMLElement>('effort-value')],
])
const accessChip = must<HTMLElement>('access-chip')
const statusChip = must<HTMLElement>('status')
const titleLabel = must<HTMLElement>('session-title')
const scopeChip = must<HTMLElement>('scope-chip')
const settingsButton = must<HTMLButtonElement>('settings')
const mcpChip = must<HTMLElement>('mcp-chip')
const mcpOk = must<HTMLElement>('mcp-ok')
const mcpBad = must<HTMLElement>('mcp-bad')
const backButton = must<HTMLButtonElement>('back')
const subView = must<HTMLElement>('sub-view')
const subKind = must<HTMLElement>('sub-kind')
const subState = must<HTMLElement>('sub-state')
const subMeta = must<HTMLElement>('sub-meta')
const subTask = must<HTMLElement>('sub-task')
const subCopy = must<HTMLButtonElement>('sub-copy')
const diffView = must<HTMLElement>('diff-view')
const diffPath = must<HTMLElement>('diff-path')
const diffStat = must<HTMLElement>('diff-stat')
const diffStream = must<HTMLElement>('diff-stream')
const diffCopy = must<HTMLButtonElement>('diff-copy')

let activeSessionId: string | null = null
let busy = false
let agents: AgentSummary[] = []
/** The subagent on screen, or null when the conversation itself is. */
let viewing: string | null = null
/** The diff on screen, or null. It sits over whichever flow opened it. */
let showing: DiffOpen | null = null

/**
 * The conversation, and the subagent the user opened. Two views of the same
 * kind, because a subagent is an agent: it thinks, calls tools and answers, and
 * a second, smaller way of drawing that was a second thing to keep right.
 */
const chat = new ChatView({
  stream,
  tail: must<HTMLElement>('stream-tail'),
  mark: must<HTMLElement>('stream-mark'),
  usageLine: must<HTMLElement>('usage-line'),
  openSubagent: id => void openSubagent(id),
  openDiff,
})

const sub = new ChatView({
  stream: must<HTMLElement>('sub-stream'),
  tail: must<HTMLElement>('sub-tail'),
  usageLine: must<HTMLElement>('sub-usage'),
  openDiff,
})

/**
 * One diff, drawn a line at a time so the pane can colour what changed. The
 * text came from `core/diff.ts` by way of the tool result, so the shapes here
 * are the ones a unified diff has and nothing else has to be guessed.
 */
function drawDiff(diff: DiffOpen): void {
  diffPath.textContent = diff.path
  let added = 0
  let removed = 0
  const rows = document.createDocumentFragment()
  for (const line of diff.text.split('\n')) {
    const kind = lineKind(line)
    if (kind === 'add') added += 1
    if (kind === 'del') removed += 1
    // An empty line with nothing in it collapses to no height, which breaks the
    // column of the diff; a space keeps the row.
    rows.append(el('div', `diff-line ${kind}`, line === '' ? ' ' : line))
  }
  diffStat.textContent = `+${added} −${removed}`
  diffStream.replaceChildren(rows)
  diffStream.scrollTop = 0
}

function lineKind(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'same'
}

function openDiff(diff: DiffOpen): void {
  showing = diff
  diffCopy.textContent = 'Copy diff'
  drawDiff(diff)
  renderShell()
}

/** Back to the flow the diff was opened from, subagent or conversation. */
function closeDiff(): void {
  showing = null
  renderShell()
}

/**
 * The MCP chip: how many servers this session is actually talking to, and how
 * many are configured but not answering. Two numbers, because "MCP is on" and
 * "MCP works" are different claims and only the second one matters when a tool
 * is missing.
 *
 * A session's servers are dialled on its first message, so before that the
 * counts are what the config asks for rather than what is up, which the tooltip
 * says outright instead of showing a red count for something nobody tried yet.
 */
function renderMcp(status: { live: boolean; servers: McpServerStatus[] } | null): void {
  mcpChip.hidden = status === null || status.servers.length === 0
  if (status === null || status.servers.length === 0) return

  const connected = status.servers.filter(server => server.connected)
  const failed = status.servers.filter(server => !server.connected)
  mcpChip.classList.toggle('pending', !status.live)
  // Nothing has been dialled, so there is no split to draw: every server counts
  // as "not connected" until the first message, and showing that as a failure
  // count beside a nought made a session that has not started yet look broken.
  // One number, the one that is true: how many this folder is configured for.
  mcpOk.textContent = String(status.live ? connected.length : status.servers.length)
  mcpBad.textContent = String(failed.length)
  // A red nought is not good news drawn in red, it is a colour the eye stops on
  // for nothing. Nothing failed, so nothing is shown.
  mcpChip.classList.toggle('all-well', status.live && failed.length === 0)

  const lines = status.servers.map(server => {
    if (!status.live) return `${server.name}: not started yet`
    if (server.connected) return `${server.name}: ${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`
    return `${server.name}: ${server.error ?? 'not connected'}`
  })
  const head = status.live
    ? `${connected.length} connected, ${failed.length} not`
    : 'Configured for this folder. Servers start with the first message.'
  mcpChip.title = [head, ...lines].join('\n')
}

/** The open session's MCP state, asked for rather than waited for. */
async function refreshMcp(sessionId: string | null): Promise<void> {
  if (sessionId === null) {
    renderMcp(null)
    return
  }
  const status = await nh.mcpStatus(sessionId).catch(() => null)
  // A slow answer for a session the user has already left is not an answer.
  if (sessionId === activeSessionId) renderMcp(status)
}

/**
 * One subagent as the head above its flow draws it. A live one comes from the
 * job registry and a finished one from its stored transcript, and the two carry
 * the same facts, which is the point: opening a subagent from a turn that ran
 * last week looks exactly like opening one that is running now.
 */
interface SubagentHead {
  id: string
  role: JobView['role']
  mode: JobView['mode']
  task: string
  background: boolean
  state: JobView['state']
  note: string
  /** Absent for a subagent stored before the harness counted tool calls. */
  tools?: ToolStats
  startedAt: number
  endedAt?: number
}

let subHead: SubagentHead | null = null
/** Ticks the elapsed time while a running subagent is on screen. */
let subClock: number | null = null
/** Set while the copy button is showing what happened, so a redraw leaves it alone. */
let copied = false

function ran(head: SubagentHead): string {
  const end = head.endedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - head.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The head is redrawn in place, so a subagent that finishes under the reader's
 * eyes turns into its own result rather than going stale. */
function drawSubHead(head: SubagentHead): void {
  subHead = head
  subKind.textContent = identity(head)
  subState.textContent = stateLabel(head.state)
  subState.className = `job-state ${head.state}`
  const parts = [
    head.background ? 'background' : 'the parent turn is waiting',
    `started ${relativeTime(head.startedAt)}`,
    `${head.state === 'running' ? 'running for' : 'ran'} ${ran(head)}`,
  ]
  // What it did, rather than only how long it took. The count is settled when
  // the job ends, so a running agent is not given a line reading nought.
  if (head.tools !== undefined && head.state !== 'running') parts.push(toolsText(head.tools))
  subMeta.textContent = parts.join(' · ')
  subTask.textContent = head.task
  subCopy.hidden = head.state === 'running'
  if (!copied) subCopy.textContent = head.state === 'failed' ? 'Copy error' : 'Copy result'
  titleLabel.textContent = `${identity(head)} subagent`

  // A stopped clock beside something that is still working reads as something
  // that has stalled.
  if (head.state === 'running' && subClock === null) {
    subClock = window.setInterval(() => {
      if (subHead !== null) drawSubHead(subHead)
    }, 1000)
  }
  if (head.state !== 'running' && subClock !== null) {
    window.clearInterval(subClock)
    subClock = null
  }
}

/**
 * Show one subagent's own conversation in the place the main agent's is drawn.
 *
 * Live, it is replayed from the events this window has been keeping and then
 * followed as they arrive; finished and gone from this launch's job list, it is
 * read back from the transcript the main process stored beside the session's.
 */
async function openSubagent(id: string): Promise<void> {
  copied = false
  const live = jobById(id)
  if (live !== undefined) {
    viewing = id
    sub.clear()
    for (const event of bufferOf(id)) sub.handleEvent(event)
    // The buffer keeps only the last stretch of a long job, so replaying it
    // rebuilds the window but not the whole count. The total comes from the
    // usage events the window kept for this job, and the rate starts over
    // rather than being divided out of whatever part of the stream survived
    // the cap.
    sub.showStoredUsage(spendingOf(id))
    sub.setActivity(live.state === 'running')
    drawSubHead(live)
    renderShell()
    return
  }

  const sessionId = activeSessionId
  if (sessionId === null) return
  const stored = await nh.subagent(sessionId, id).catch(() => null)
  if (stored === null) {
    chat.noteBlock('That subagent ran in an earlier launch and its transcript is gone.')
    return
  }
  viewing = id
  sub.renderTranscript(stored.messages, stored.notes)
  sub.showStoredUsage(stored.usage)
  sub.setActivity(false)
  drawSubHead({ ...stored, endedAt: stored.endedAt })
  renderShell()
}

/** Back to the conversation that started it. The subagent keeps running. */
function closeSubagent(): void {
  // A subagent that finished while it was on screen was held back from being
  // forgotten so it would not vanish under the reader. It can go now: opening
  // it again reads its transcript.
  if (viewing !== null) forget(viewing)
  viewing = null
  subHead = null
  if (subClock !== null) {
    window.clearInterval(subClock)
    subClock = null
  }
  sub.setActivity(false)
  renderShell()
}

/**
 * A native select sizes itself to its widest option, so a visible one would
 * shove the chips along the row whenever a model had a long id. The select is
 * invisible and laid over the chip; this writes what it says onto the label
 * the chip actually draws.
 */
function syncChips(): void {
  for (const [select, label] of chipValues) {
    const picked = select.selectedOptions[0]
    label.textContent = picked?.textContent ?? ''
    // The model chip shows a model id and nothing about where it runs, so the
    // option's own title, which names the provider, is the one worth keeping.
    // An option that carries no title of its own leaves the label's own text as
    // the tooltip, which is what a chip clipped by a narrow window needs.
    const title = picked?.title ?? ''
    label.title = title === '' ? (label.textContent ?? '') : title
  }
}

/**
 * A picked model, and the provider that runs it. Two providers can offer the
 * same model id, so the option's value has to carry both; the separator is a
 * control character because a model id can hold anything a URL path can.
 */
const PICK = '\u001f'

function modelKey(providerId: string, model: string): string {
  return `${providerId}${PICK}${model}`
}

function modelPick(value: string): { providerId: string; model: string } | null {
  const cut = value.indexOf(PICK)
  return cut === -1 ? null : { providerId: value.slice(0, cut), model: value.slice(cut + 1) }
}

/**
 * The composer chips: what a turn will run, switchable without opening settings.
 *
 * Every configured provider is in the model list, grouped by name. Switching
 * provider is not a separate step taken somewhere else first: the thing being
 * chosen is a model, and which endpoint serves it follows from the pick.
 */
function renderActive(status: ConfigStatus): void {
  const active = status.active

  modelSelect.replaceChildren()
  let count = 0
  for (const provider of status.providers) {
    const models = new Set(provider.models)
    // A provider with nothing ticked still runs the model it is active on, so
    // that one is its group rather than an empty heading.
    if (active !== undefined && provider.id === active.providerId) models.add(active.model)
    if (models.size === 0) continue
    const group = document.createElement('optgroup')
    group.label = provider.name
    for (const id of models) {
      const option = document.createElement('option')
      option.value = modelKey(provider.id, id)
      option.textContent = id
      option.title = `${provider.name} · ${provider.baseURL}`
      group.append(option)
      count += 1
    }
    modelSelect.append(group)
  }
  if (active !== undefined) modelSelect.value = modelKey(active.providerId, active.model)
  modelSelect.disabled = count === 0
  if (count === 0) {
    const option = document.createElement('option')
    option.textContent = 'not configured'
    modelSelect.append(option)
  }
  modelSelect.title = 'The model a turn runs on, from any provider you have configured'
  effortSelect.value = active?.effort ?? 'medium'
  effortSelect.disabled = active === undefined
  syncChips()
  renderShell()
}

/**
 * Either a session is open, or the window is the hero that starts one. The
 * composer is the same element in both, so a message written on the hero is
 * still there once the session it started exists.
 */
function renderShell(): void {
  const open = activeSessionId !== null
  // A diff sits over whichever flow opened it, so back from one goes to that
  // flow rather than all the way home.
  const onDiff = open && showing !== null
  const sideways = open && viewing !== null && !onDiff
  stream.hidden = !open || sideways || onDiff
  subView.hidden = !sideways
  diffView.hidden = !onDiff
  hero.hidden = open
  seat(open)
  // Neither of these can be messaged: a subagent was given its whole task when
  // it started and answers once, and a diff is a thing that already happened.
  // Leaving the composer over either would offer to send a message into it.
  showDock(!sideways && !onDiff)
  backButton.hidden = !sideways && !onDiff

  if (onDiff && showing !== null) {
    titleLabel.textContent = showing.path
    return
  }

  if (sideways) {
    const job = subHead
    titleLabel.textContent = job === null ? 'Subagent' : `${identity(job)} subagent`
    return
  }

  if (!open) {
    const status = currentStatus()
    const workspace = status.workspaces.find(w => w.id === selectedWorkspaceId())
    const configured = latestConfig()?.configured === true
    // Nothing to send to yet: the card is a "start here" target rather than a
    // composer that would take a message and then refuse it.
    const blocked = !configured || workspace === undefined
    heroNote.textContent = !configured
      ? 'No provider yet. Add one in settings, then start a session.'
      : workspace === undefined
        ? 'Add a folder to work in. A session can only touch the folder it was started in.'
        : `Type below and a session starts in ${workspace.name}, scoped to that folder.`
    composer.classList.toggle('trigger', blocked)
    input.readOnly = blocked
    input.placeholder = !configured
      ? 'Add a provider to get started'
      : workspace === undefined
        ? 'Add a folder to work in'
        : 'Message the agent. Enter sends, Shift+Enter makes a newline.'
    sendButton.disabled = blocked
    titleLabel.textContent = 'No session'
    scopeChip.hidden = true
    renderAgents()
    return
  }

  composer.classList.remove('trigger')
  input.readOnly = false
  input.placeholder = 'Message the agent. Enter sends, Shift+Enter makes a newline.'
  sendButton.disabled = false

  const session = activeSessionId === null ? undefined : sessionById(activeSessionId)
  const workspace = activeSessionId === null ? undefined : workspaceOf(activeSessionId)
  titleLabel.textContent = session?.title ?? 'Session'
  scopeChip.hidden = workspace === undefined
  if (workspace !== undefined) {
    scopeChip.textContent = workspace.name
    scopeChip.title = `Scoped to ${workspace.root}`
    accessChip.title = `Tools are limited to ${workspace.root}`
  }
  // The composer stays live during a turn: the next message can be written
  // while this one runs, and Send is the stop button until the turn ends.
  renderAgents()
  sendButton.classList.toggle('stop', busy)
  sendButton.title = busy ? 'End this turn (Esc)' : 'Send (Enter)'
  sendButton.setAttribute('aria-label', busy ? 'Stop' : 'Send')
}

/** The role chip: what this session is talking to, switchable mid-session. */
function renderAgents(): void {
  agentSelect.replaceChildren()
  for (const agent of agents) {
    const option = document.createElement('option')
    option.value = agent.role
    option.textContent = agent.name
    option.title = agent.purpose
    agentSelect.append(option)
  }
  const session = activeSessionId === null ? undefined : sessionById(activeSessionId)
  // With no session there is nothing whose role could change: the next one
  // starts as a builder, which is what the chip shows.
  agentSelect.value = session?.role ?? 'builder'
  agentSelect.disabled = session === undefined
  const current = agents.find(a => a.role === agentSelect.value)
  agentSelect.title = current === undefined ? 'Agent' : `${current.name}: ${current.purpose}`
  syncChips()
}

/**
 * Switching agent rebuilds the session's prompt and tool list on the next turn.
 * The effort chip is left alone: how hard to think is the user's setting, and
 * a role that moved it would overwrite an answer they had already given.
 */
async function switchAgent(): Promise<void> {
  const sessionId = activeSessionId
  if (sessionId === null) return
  const role = agentSelect.value as AgentRole
  try {
    await nh.setSessionRole(sessionId, role)
    setStatus(await nh.workspaces())
    select(sessionId)
    renderShell()
  } catch (err) {
    chat.errorBlock(message(err))
    renderAgents()
  }
}

function setBusy(next: boolean): void {
  busy = next
  chat.setActivity(next)
  renderShell()
  if (!next) input.focus()
}

/** End the running turn. The request is aborted; the transcript is kept. */
function stop(): void {
  const sessionId = activeSessionId
  if (!busy || sessionId === null) return
  sendButton.disabled = true
  nh.stop(sessionId)
    .catch((err: unknown) => chat.errorBlock(message(err)))
    .finally(() => {
      sendButton.disabled = false
    })
}

async function openSession(id: string): Promise<void> {
  try {
    const opened = await nh.openSession(id)
    activeSessionId = id
    select(id)
    // A subagent and a diff both belong to the session that started them, so
    // opening another session is leaving both.
    showing = null
    closeSubagent()
    chat.renderTranscript(opened.messages, opened.notes)
    renderMcp(null)
    void refreshMcp(id)
    // What this session has already spent. Without it a re-opened session reads
    // as one that has cost nothing.
    chat.showStoredUsage(opened.session.usage, opened.session.subagentUsage)
    renderShell()
    input.focus()
  } catch (err) {
    // The session went away underneath us (deleted, or its folder removed).
    // Fall back to the hero rather than a composer that cannot send.
    activeSessionId = null
    renderMcp(null)
    await refreshSidebar()
    renderShell()
    chat.errorBlock(message(err))
  }
}

/**
 * Switch model, provider or effort from the composer, without opening settings.
 * The pick carries the provider, so choosing a model from another one moves the
 * session there in the same call.
 */
async function switchActive(): Promise<void> {
  const active = latestConfig()?.active
  const picked = modelPick(modelSelect.value)
  const providerId = picked?.providerId ?? active?.providerId
  const model = picked?.model ?? active?.model
  if (providerId === undefined || model === undefined) return
  try {
    applyConfig(await nh.setActive({ providerId, model, effort: effortSelect.value as Effort }))
  } catch (err) {
    chat.errorBlock(message(err))
    await refreshConfig()
  }
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '' || busy) return
  if (latestConfig()?.configured !== true) {
    openSettings('providers')
    return
  }
  // Sending from the hero is how a session starts: the message names it, so
  // there is no separate "new session" step to take first.
  if (activeSessionId === null) await startSession()
  const sessionId = activeSessionId
  if (sessionId === null) return

  // A key pasted into the composer is taken out of the message here, before the
  // window draws it: from this point on the text carries a `{{secret:name}}`
  // reference, and the real value lives only in the main process. The same swap
  // happens again in the main process, so nothing depends on this call for the
  // secret to be caught. This is what keeps it off the screen.
  const captured = await nh.captureSecrets(text).catch(() => ({ text, captured: [] }))
  const safe = captured.text

  chat.userBlock(safe)
  if (captured.captured.length > 0) {
    const names = captured.captured.map(name => `{{secret:${name}}}`).join(', ')
    chat.noteBlock(`Kept out of the transcript: ${names}. Tools get the real value; the model never sees it.`)
  }
  input.value = ''
  autoGrow()
  chat.startTurn()
  setBusy(true)

  try {
    const result = await nh.send(sessionId, safe)
    // The first message names the session, so the sidebar has to be re-read.
    setStatus(await nh.workspaces())
    select(result.session.id)
    // The hub is dialled on the first message, so this is when there is
    // something real to show.
    void refreshMcp(sessionId)
  } catch (err) {
    chat.errorBlock(message(err))
    // The settings may have gone stale mid-session (a key that no longer
    // decrypts, a config file edited underneath). Re-check, and reopen settings
    // if that is the cause.
    await refreshConfig()
  } finally {
    setBusy(false)
    renderShell()
  }
}

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
  // Esc from the composer is the keyboard way to stop, the way it is in a shell.
  if (event.key === 'Escape' && busy) {
    event.preventDefault()
    stop()
  }
})
composer.addEventListener('submit', event => {
  event.preventDefault()
  if (busy) stop()
  else void send()
})
// In the blocked state the whole card is one pick target: the click does the
// thing that would unblock it rather than nothing at all.
composer.addEventListener('click', () => {
  if (!composer.classList.contains('trigger')) return
  if (latestConfig()?.configured !== true) openSettings('providers')
  else void startSession()
})
modelSelect.addEventListener('change', () => void switchActive())
effortSelect.addEventListener('change', () => void switchActive())
agentSelect.addEventListener('change', () => void switchAgent())
backButton.addEventListener('click', () => {
  if (showing !== null) closeDiff()
  else closeSubagent()
})
diffCopy.addEventListener('click', () => {
  void navigator.clipboard
    .writeText(showing?.text ?? '')
    .then(() => {
      diffCopy.textContent = 'Copied'
    })
    .catch(() => {
      diffCopy.textContent = 'Copy failed'
    })
})
subCopy.addEventListener('click', () => {
  copied = true
  void navigator.clipboard
    .writeText(subHead?.note ?? '')
    .then(() => {
      subCopy.textContent = 'Copied'
    })
    .catch(() => {
      subCopy.textContent = 'Copy failed'
    })
})
settingsButton.addEventListener('click', () => openSettings('providers'))
heroSettings.addEventListener('click', () => openSettings('providers'))

initComposer()
initNotify()
initPermission({ bridge: nh, report: text => chat.errorBlock(text) })
initSidebar({
  bridge: nh,
  openSession,
  changed: () => {
    // A folder or session just went away; the open one may have been it.
    if (activeSessionId !== null && sessionById(activeSessionId) === undefined) {
      activeSessionId = null
      chat.clear()
      renderMcp(null)
    }
    renderShell()
  },
  report: text => chat.errorBlock(text),
})

nh.onEvent(event => {
  if (event.type === 'job.started' || event.type === 'job.update' || event.type === 'job.finished') {
    handleJobEvent(event)
    // A foreground subagent has no note of its own, since its answer arrives
    // as the spawn tool's result, so the card for that call is where it is
    // opened from while it runs.
    if (event.type === 'job.started' && !event.job.background && event.job.sessionId === activeSessionId) {
      chat.liveSubagent(event.job.id)
    }
    if (event.type === 'job.finished') announce(event.job.state === 'done' ? 'finished' : 'error', `${event.job.role} job`)
    return
  }
  if (event.type === 'mcp.status') {
    if (event.sessionId === activeSessionId) renderMcp({ live: event.live, servers: event.servers })
    return
  }
  // A subagent's stream comes in under its own session id, which is its job id.
  // It belongs in that subagent's view, not in the conversation on screen, and
  // it is checked before anything announces, or a turn with three subagents in
  // it would ring the bell four times, three of them for a session nobody
  // opened.
  if (isSubagent(event.sessionId)) {
    handleSubagentEvent(event)
    return
  }
  if (event.type === 'session.finished' || event.type === 'session.stopped' || event.type === 'session.error') {
    const outcome = event.type === 'session.finished' ? 'finished' : event.type === 'session.stopped' ? 'stopped' : 'error'
    announce(outcome, sessionById(event.sessionId)?.title ?? 'Session')
  }
  if (event.type === 'permission.request') {
    if (event.sessionId === activeSessionId) enqueue(event)
    // A prompt for a session nobody is looking at cannot be answered
    // meaningfully; deny it rather than park that turn forever.
    else void nh.respondToPermission(event.id, 'deny')
    return
  }
  if (!('sessionId' in event) || event.sessionId === activeSessionId) chat.handleEvent(event)
})

async function boot(): Promise<void> {
  let version = ''
  try {
    version = (await nh.ping()).version
    statusChip.title = `nanoharness v${version}`
  } catch {
    // The chip is for states worth reading, and this is the only one there is.
    statusChip.hidden = false
    statusChip.textContent = 'offline'
  }

  initSettings({ bridge: nh, onConfig: renderActive, version })
  agents = await nh.agents().catch(() => [])
  renderAgents()
  await initJobs(nh, {
    viewing: id => viewing === id,
    // The events a subagent streams reach its view only while it is the one on
    // screen; the rest of the time they go into its buffer and are replayed the
    // moment it is opened.
    event: streamed => {
      if (viewing === streamed.sessionId) sub.handleEvent(streamed)
    },
    changed: job => {
      if (viewing !== job.id) return
      drawSubHead(job)
      sub.setActivity(job.state === 'running')
    },
  })
  await refreshConfig()
  await refreshSidebar()

  // Pick up where the last launch left off: the most recently used session.
  const recent = currentStatus().sessions[0]
  if (recent !== undefined) await openSession(recent.id)
  else renderShell()
}

void boot()
