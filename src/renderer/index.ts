// doc: docs/harness/ui.md
import type { ConfigSetRequest, ConfigStatus, NanoBridge } from '../ipc/contract.js'
import type { AppEvent, ToolCall, ToolResult, TurnUsage } from '../core/types.js'

declare global {
  interface Window {
    nanoharness: NanoBridge
  }
}

const nh = window.nanoharness
const stream = must<HTMLElement>('stream')
const input = must<HTMLTextAreaElement>('input')
const sendButton = must<HTMLButtonElement>('send')
const modelChip = must<HTMLElement>('model')
const statusChip = must<HTMLElement>('status')
const composer = must<HTMLElement>('composer')
const setup = must<HTMLElement>('setup')
const setupBase = must<HTMLInputElement>('setup-base')
const setupModelInput = must<HTMLInputElement>('setup-model')
const setupKey = must<HTMLInputElement>('setup-key')
const setupSave = must<HTMLButtonElement>('setup-save')
const setupCancel = must<HTMLButtonElement>('setup-cancel')
const setupNote = must<HTMLElement>('setup-note')
const setupTitle = must<HTMLElement>('setup-title')
const setupHint = must<HTMLElement>('setup-hint')
const setupTest = must<HTMLButtonElement>('setup-test')
const setupFetch = must<HTMLButtonElement>('setup-fetch')
const setupProbeNote = must<HTMLElement>('setup-probe-note')
const setupModels = must<HTMLElement>('setup-models')
const setupModelList = must<HTMLElement>('setup-model-list')
const setupAll = must<HTMLInputElement>('setup-all')
const setupModelSelect = must<HTMLSelectElement>('setup-model-select')
const settingsButton = must<HTMLButtonElement>('settings')

const toolCards = new Map<string, HTMLDetailsElement>()
let assistantBody: HTMLElement | null = null
let thinkingBody: HTMLElement | null = null
let usageLine: HTMLElement | null = null
let configured = false
let lastStatus: ConfigStatus | null = null
// What the provider offers, and which of those the user allows. A session may
// only run something in `allowed`, which is why the picker is a list of
// checkboxes rather than a free-text field once a fetch has succeeded.
let available: string[] = []
let allowed = new Set<string>()

function must<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`renderer: #${id} is missing from index.html`)
  return found as T
}

function block(kind: string, label: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = `block ${kind}`
  const tag = document.createElement('div')
  tag.className = 'label'
  tag.textContent = label
  const body = document.createElement('div')
  body.className = 'body'
  wrapper.append(tag, body)
  append(wrapper)
  return body
}

function append(node: HTMLElement): void {
  const pinned = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80
  stream.append(node)
  if (pinned) stream.scrollTop = stream.scrollHeight
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

function toolCard(call: ToolCall): HTMLDetailsElement {
  const card = document.createElement('details')
  card.className = 'block tool'
  const summary = document.createElement('summary')
  summary.textContent = call.name
  summary.dataset.state = 'running'
  const args = document.createElement('pre')
  args.textContent = pretty(call.args)
  card.append(summary, args)
  append(card)
  return card
}

function finishToolCard(card: HTMLDetailsElement, result: ToolResult): void {
  card.classList.add(result.ok ? 'ok' : 'failed')
  const summary = card.querySelector('summary')
  if (summary instanceof HTMLElement) summary.dataset.state = result.ok ? 'done' : 'failed'
  const output = document.createElement('pre')
  output.textContent = result.content ?? result.summary
  card.append(output)
}

function usageText(usage: TurnUsage): string {
  const seen = usage.cacheRead + usage.input
  const hit = seen === 0 ? 'n/a' : `${((usage.cacheRead / seen) * 100).toFixed(0)}%`
  return `in ${usage.input} · out ${usage.output} · cached ${usage.cacheRead} · hit ${hit}${usage.reasoning > 0 ? ` · reasoning ${usage.reasoning}` : ''}`
}

function setBusy(busy: boolean): void {
  input.disabled = busy
  sendButton.disabled = busy
  statusChip.textContent = busy ? 'working' : 'idle'
  statusChip.classList.toggle('busy', busy)
  if (!busy) input.focus()
}

function handle(event: AppEvent): void {
  switch (event.type) {
    case 'thinking_delta':
      if (!thinkingBody) {
        const card = document.createElement('details')
        card.className = 'block'
        const summary = document.createElement('summary')
        summary.textContent = 'thinking'
        thinkingBody = document.createElement('pre')
        card.append(summary, thinkingBody)
        append(card)
      }
      thinkingBody.textContent += event.text
      break
    case 'text_delta':
      assistantBody ??= block('assistant', 'assistant')
      assistantBody.textContent += event.text
      break
    case 'tool_call':
      toolCards.set(event.call.id, toolCard(event.call))
      assistantBody = null
      break
    case 'tool_result': {
      const card = toolCards.get(event.callId)
      if (card) finishToolCard(card, event.result)
      break
    }
    case 'usage': {
      usageLine ??= block('usage', 'usage')
      usageLine.textContent = usageText(event.usage)
      // Rounds interleave, so keep the running total at the foot of the turn.
      const line = usageLine.parentElement
      if (line) append(line)
      break
    }
    case 'session.error':
      block('error', 'error').textContent = event.message
      break
    case 'session.started':
    case 'session.finished':
      break
  }
}

// Electron wraps a rejected invoke as "Error invoking remote method 'x': Error: y".
// The reader only wants y.
function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

function activeModel(): string {
  return setupModelSelect.hidden ? setupModelInput.value.trim() : setupModelSelect.value
}

function renderModels(): void {
  setupModels.hidden = available.length === 0
  setupModelList.replaceChildren()

  for (const id of available) {
    const row = document.createElement('label')
    row.className = 'model-row'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.value = id
    box.checked = allowed.has(id)
    box.addEventListener('change', () => {
      if (box.checked) allowed.add(id)
      else allowed.delete(id)
      renderModels()
    })
    const name = document.createElement('span')
    name.textContent = id
    row.append(box, name)
    setupModelList.append(row)
  }

  setupAll.checked = available.length > 0 && allowed.size === available.length
  setupAll.indeterminate = allowed.size > 0 && allowed.size < available.length

  // With a list to choose from, the active model is a pick rather than a guess.
  // Without one (a proxy with no /v1/models) the text field stays the way in.
  const picks = [...allowed]
  const wanted = activeModel()
  setupModelSelect.hidden = picks.length === 0
  setupModelInput.hidden = picks.length > 0
  setupModelSelect.replaceChildren()
  for (const id of picks) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = id
    setupModelSelect.append(option)
  }
  if (picks.length > 0) setupModelSelect.value = picks.includes(wanted) ? wanted : (picks[0] ?? '')
}

/** Setup is the whole window on a first run, and a panel over it afterwards. */
function showSetup(open: boolean): void {
  setup.hidden = !open
  stream.hidden = open
  composer.hidden = open
  setupCancel.hidden = !configured
  setupTitle.textContent = configured ? 'Provider settings' : 'Set up a provider'
  setupHint.textContent = configured
    ? 'Test the endpoint, fetch what it offers, and tick the models this harness may run. Only ticked models can be the active one. Leave the key blank to keep the stored one.'
    : 'NanoHarness ships with no endpoint and no model built in. Point it at any OpenAI-compatible API. The key is encrypted by your OS and stored outside this repo; the rest lands in a plain settings file.'
  setupSave.textContent = configured ? 'Save' : 'Save and start'
  if (open) setupBase.focus()
  else input.focus()
}

function applyConfig(status: ConfigStatus): void {
  lastStatus = status
  configured = status.configured
  showSetup(!status.configured)

  modelChip.textContent = status.configured ? status.model : 'not configured'
  setupBase.value = status.baseURL
  setupModelInput.value = status.model
  setupKey.value = ''
  setupKey.placeholder = status.hasKey ? 'stored - leave blank to keep it' : 'stored encrypted, never written in plain text'

  // A saved selection is the list until a fetch replaces it, so reopening
  // settings shows what the harness may run without another round trip.
  available = status.models
  allowed = new Set(status.models)
  setupProbeNote.textContent = ''
  renderModels()

  const notes: string[] = []
  if (status.problem !== undefined) notes.push(status.problem)
  if (status.keyStorage === 'unavailable') {
    notes.push('This OS has no secret store, so a key cannot be saved here. Install a keyring and reopen settings.')
  }
  setupNote.textContent = notes.join(' ')
}

async function probe(intent: 'test' | 'fetch'): Promise<void> {
  const baseURL = setupBase.value.trim()
  const key = setupKey.value.trim()
  setupTest.disabled = true
  setupFetch.disabled = true
  setupProbeNote.textContent = intent === 'test' ? 'testing...' : 'fetching...'
  try {
    const result = await nh.probeProvider(key === '' ? { baseURL } : { baseURL, apiKey: key })
    if (!result.ok) {
      setupProbeNote.textContent = result.error
      return
    }
    const count = `${result.models.length} model${result.models.length === 1 ? '' : 's'}`
    if (intent === 'test') {
      setupProbeNote.textContent = `Connected. ${count} available.`
      return
    }
    const previous = allowed
    available = result.models
    // Keep an existing selection where it still exists. A first fetch selects
    // everything, since the user has not ruled anything out yet.
    allowed = previous.size === 0 ? new Set(result.models) : new Set(result.models.filter(id => previous.has(id)))
    setupProbeNote.textContent = `${count} offered. Tick the ones this harness may use.`
    renderModels()
  } catch (err) {
    setupProbeNote.textContent = message(err)
  } finally {
    setupTest.disabled = false
    setupFetch.disabled = false
  }
}

async function refreshConfig(): Promise<void> {
  try {
    applyConfig(await nh.config())
  } catch (err) {
    configured = false
    showSetup(true)
    setupNote.textContent = message(err)
  }
}

async function saveSetup(): Promise<void> {
  const settings: ConfigSetRequest = {
    baseURL: setupBase.value.trim(),
    model: activeModel(),
    models: [...allowed],
  }
  const apiKey = setupKey.value.trim()
  if (apiKey !== '') settings.apiKey = apiKey

  setupSave.disabled = true
  setupNote.textContent = 'saving...'
  try {
    applyConfig(await nh.saveConfig(settings))
  } catch (err) {
    setupNote.textContent = message(err)
  } finally {
    setupSave.disabled = false
  }
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '' || sendButton.disabled || !configured) return

  block('user', 'you').textContent = text
  input.value = ''
  assistantBody = null
  thinkingBody = null
  usageLine = null
  toolCards.clear()
  setBusy(true)

  try {
    await nh.send(text)
  } catch (err) {
    block('error', 'error').textContent = message(err)
    // The settings may have gone stale mid-session (a key that no longer
    // decrypts, a config file edited underneath). Re-check, and reopen setup if
    // that is the cause.
    await refreshConfig()
  } finally {
    setBusy(false)
  }
}

input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
})
sendButton.addEventListener('click', () => void send())
setupSave.addEventListener('click', () => void saveSetup())
setupCancel.addEventListener('click', () => {
  if (lastStatus) applyConfig(lastStatus)
})
// The saved-state complaint stops being true the moment the user starts typing.
for (const field of [setupBase, setupKey, setupModelInput]) {
  field.addEventListener('input', () => {
    setupNote.textContent = ''
  })
}
setupTest.addEventListener('click', () => void probe('test'))
setupFetch.addEventListener('click', () => void probe('fetch'))
setupAll.addEventListener('change', () => {
  allowed = setupAll.checked ? new Set(available) : new Set()
  renderModels()
})
// `hidden` widened to string | boolean for hidden="until-found"; only
// booleans are ever assigned here.
settingsButton.addEventListener('click', () => showSetup(setup.hidden !== false))
setupKey.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void saveSetup()
  }
})
nh.onEvent(handle)

nh.ping().then(
  info => {
    statusChip.title = `nanoharness v${info.version}`
  },
  () => {
    statusChip.textContent = 'offline'
  },
)
void refreshConfig()
