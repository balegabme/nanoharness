// doc: docs/harness/ui.md
import { clearChat, errorBlock, handleEvent, renderTranscript, startTurn, userBlock } from './chat.js'
import { message, must } from './dom.js'
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
import type { ConfigStatus, NanoBridge } from '../ipc/contract.js'
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
const heroAdd = must<HTMLButtonElement>('hero-add')
const heroSettings = must<HTMLButtonElement>('hero-settings')
const composer = must<HTMLElement>('composer')
const input = must<HTMLTextAreaElement>('input')
const sendButton = must<HTMLButtonElement>('send')
const modelSelect = must<HTMLSelectElement>('model-select')
const effortSelect = must<HTMLSelectElement>('effort-select')
const accessChip = must<HTMLElement>('access-chip')
const statusChip = must<HTMLElement>('status')
const titleLabel = must<HTMLElement>('session-title')
const scopeChip = must<HTMLElement>('scope-chip')
const settingsButton = must<HTMLButtonElement>('settings')

let activeSessionId: string | null = null
let busy = false

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
  renderShell()
}

/** Either a session is open, or the window is the hero that starts one. */
function renderShell(): void {
  const open = activeSessionId !== null
  stream.hidden = !open
  composer.hidden = !open
  hero.hidden = open

  if (!open) {
    const status = currentStatus()
    const workspace = status.workspaces.find(w => w.id === selectedWorkspaceId())
    const configured = latestConfig()?.configured === true
    heroNote.textContent = !configured
      ? 'No provider yet. Add one in settings, then start a session.'
      : workspace === undefined
        ? 'Add a folder to work in. A session can only touch the folder it was started in.'
        : `Start a session in ${workspace.name}. It will be scoped to that folder.`
    heroAdd.textContent = workspace === undefined ? 'Add folder' : 'New session'
    titleLabel.textContent = 'No session'
    scopeChip.hidden = true
    return
  }

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
  sendButton.textContent = busy ? 'Stop' : 'Send'
  sendButton.classList.toggle('stop', busy)
  sendButton.title = busy ? 'End this turn' : 'Send (Enter)'
}

function setBusy(next: boolean): void {
  busy = next
  statusChip.textContent = next ? 'working' : 'idle'
  statusChip.classList.toggle('busy', next)
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
  const sessionId = activeSessionId
  if (text === '' || busy || sessionId === null) return
  if (latestConfig()?.configured !== true) {
    openSettings('providers')
    return
  }

  userBlock(text)
  input.value = ''
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
sendButton.addEventListener('click', () => (busy ? stop() : void send()))
modelSelect.addEventListener('change', () => void switchActive())
effortSelect.addEventListener('change', () => void switchActive())
settingsButton.addEventListener('click', () => openSettings('providers'))
heroSettings.addEventListener('click', () => openSettings('providers'))
heroAdd.addEventListener('click', () => void startSession())

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
    statusChip.textContent = 'offline'
  }

  initSettings({ bridge: nh, onConfig: renderActive, version })
  await refreshConfig()
  await refreshSidebar()

  // Pick up where the last launch left off: the most recently used session.
  const recent = currentStatus().sessions[0]
  if (recent !== undefined) await openSession(recent.id)
  else renderShell()
}

void boot()
