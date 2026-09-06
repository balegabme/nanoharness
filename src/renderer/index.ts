// doc: docs/harness/ui.md
import { clearChat, errorBlock, handleEvent, renderTranscript, setActivity, showStoredUsage, startTurn, userBlock } from './chat.js'
import { autoGrow, initComposer, seat } from './composer.js'
import { message, must } from './dom.js'
import { handleJobEvent, initJobs } from './jobs.js'
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

let activeSessionId: string | null = null
let busy = false
let agents: AgentSummary[] = []

/**
 * A native select sizes itself to its widest option, so the chips used to shove
 * each other along the row whenever a model had a long id. The select is now
 * invisible and laid over the chip; this writes what it says onto the label the
 * chip actually draws.
 */
function syncChips(): void {
  for (const [select, label] of chipValues) {
    label.textContent = select.selectedOptions[0]?.textContent ?? ''
    label.title = label.textContent
  }
}

/** The composer chips: what a turn will run, switchable without opening settings. */
function renderActive(status: ConfigStatus): void {
  const active = status.active
  const provider = status.providers.find(p => p.id === active?.providerId)
  const models = provider?.models ?? []
  const list = models.length > 0 ? models : active === undefined ? [] : [active.model]

  modelSelect.replaceChildren()
  for (const id of list) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = id
    modelSelect.append(option)
  }
  if (active !== undefined) modelSelect.value = active.model
  modelSelect.disabled = list.length === 0
  if (list.length === 0) {
    const option = document.createElement('option')
    option.textContent = 'not configured'
    modelSelect.append(option)
  }
  modelSelect.title = provider === undefined ? 'Active model' : `${provider.name} · ${provider.baseURL}`
  effortSelect.value = active?.effort ?? 'medium'
  effortSelect.disabled = active === undefined
  syncChips()
  renderShell()
}

/**
 * Either a session is open, or the window is the hero that starts one — and the
 * composer is the same element in both, so a message written on the hero is
 * still there once the session it started exists.
 */
function renderShell(): void {
  const open = activeSessionId !== null
  stream.hidden = !open
  hero.hidden = open
  seat(open)

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
  agentSelect.title = current === undefined ? 'Agent' : `${current.name} — ${current.purpose}`
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
    errorBlock(message(err))
    renderAgents()
  }
}

function setBusy(next: boolean): void {
  busy = next
  setActivity(next)
  renderShell()
  if (!next) input.focus()
}

/** End the running turn. The request is aborted; the transcript is kept. */
function stop(): void {
  const sessionId = activeSessionId
  if (!busy || sessionId === null) return
  sendButton.disabled = true
  nh.stop(sessionId)
    .catch((err: unknown) => errorBlock(message(err)))
    .finally(() => {
      sendButton.disabled = false
    })
}

async function openSession(id: string): Promise<void> {
  try {
    const opened = await nh.openSession(id)
    activeSessionId = id
    select(id)
    renderTranscript(opened.messages)
    // What this session has already spent. Without it a re-opened session reads
    // as one that has cost nothing.
    showStoredUsage(opened.session.usage)
    renderShell()
    input.focus()
  } catch (err) {
    // The session went away underneath us (deleted, or its folder removed).
    // Fall back to the hero rather than a composer that cannot send.
    activeSessionId = null
    await refreshSidebar()
    renderShell()
    errorBlock(message(err))
  }
}

/** Switch model or effort from the composer, without opening settings. */
async function switchActive(): Promise<void> {
  const active = latestConfig()?.active
  if (active === undefined) return
  try {
    applyConfig(await nh.setActive({ providerId: active.providerId, model: modelSelect.value, effort: effortSelect.value as Effort }))
  } catch (err) {
    errorBlock(message(err))
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

  userBlock(text)
  input.value = ''
  autoGrow()
  startTurn()
  setBusy(true)

  try {
    const result = await nh.send(sessionId, text)
    // The first message names the session, so the sidebar has to be re-read.
    setStatus(await nh.workspaces())
    select(result.session.id)
  } catch (err) {
    errorBlock(message(err))
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
settingsButton.addEventListener('click', () => openSettings('providers'))
heroSettings.addEventListener('click', () => openSettings('providers'))

initComposer()
initNotify()
initPermission({ bridge: nh, report: errorBlock })
initSidebar({
  bridge: nh,
  openSession,
  changed: () => {
    // A folder or session just went away; the open one may have been it.
    if (activeSessionId !== null && sessionById(activeSessionId) === undefined) {
      activeSessionId = null
      clearChat()
    }
    renderShell()
  },
  report: errorBlock,
})

nh.onEvent(event => {
  if (event.type === 'session.finished' || event.type === 'session.stopped' || event.type === 'session.error') {
    const outcome = event.type === 'session.finished' ? 'finished' : event.type === 'session.stopped' ? 'stopped' : 'error'
    announce(outcome, sessionById(event.sessionId)?.title ?? 'Session')
  }
  if (event.type === 'job.started' || event.type === 'job.update' || event.type === 'job.finished') {
    handleJobEvent(event)
    if (event.type === 'job.finished') announce(event.job.state === 'done' ? 'finished' : 'error', `${event.job.role} job`)
    return
  }
  if (event.type === 'permission.request') {
    if (event.sessionId === activeSessionId) enqueue(event)
    // A prompt for a session nobody is looking at cannot be answered
    // meaningfully; deny it rather than park that turn forever.
    else void nh.respondToPermission(event.id, 'deny')
    return
  }
  handleEvent(event, activeSessionId)
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
  await initJobs(nh)
  await refreshConfig()
  await refreshSidebar()

  // Pick up where the last launch left off: the most recently used session.
  const recent = currentStatus().sessions[0]
  if (recent !== undefined) await openSession(recent.id)
  else renderShell()
}

void boot()
