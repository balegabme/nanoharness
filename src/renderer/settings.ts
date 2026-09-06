// doc: docs/harness/ui.md
import { ask } from './confirm.js'
import { el, GLYPH, icon, message, must } from './dom.js'
import type { ConfigStatus, NanoBridge, ProviderSaveRequest, ProviderView } from '../ipc/contract.js'
import type { ProviderKind } from '../core/config.js'

/**
 * Settings is a sheet over the app, not a screen the app falls back to: the
 * conversation stays where it was. It opens by itself only when nothing can
 * run — no provider saved, or a saved one that no longer resolves.
 */

const dialog = must<HTMLDialogElement>('settings-dialog')
const closeButton = must<HTMLButtonElement>('settings-close')
const navProviders = must<HTMLButtonElement>('pane-providers')
const navAbout = must<HTMLButtonElement>('pane-about')
const providersPane = must<HTMLElement>('providers-pane')
const aboutPane = must<HTMLElement>('about-pane')
const aboutVersion = must<HTMLElement>('about-version')

const providers = must<HTMLElement>('providers')
const providerList = must<HTMLElement>('provider-list')
const providerAdd = must<HTMLButtonElement>('provider-add')
const setupName = must<HTMLInputElement>('setup-name')
const setupKind = must<HTMLSelectElement>('setup-kind')
const setupBase = must<HTMLInputElement>('setup-base')
const setupBaseHint = must<HTMLElement>('setup-base-hint')
const setupKey = must<HTMLInputElement>('setup-key')
const setupSave = must<HTMLButtonElement>('setup-save')
const setupNote = must<HTMLElement>('setup-note')
const setupTitle = must<HTMLElement>('setup-title')
const setupHint = must<HTMLElement>('setup-hint')
const setupTest = must<HTMLButtonElement>('setup-test')
const setupFetch = must<HTMLButtonElement>('setup-fetch')
const setupProbeNote = must<HTMLElement>('setup-probe-note')
const setupModels = must<HTMLElement>('setup-models')
const setupModelList = must<HTMLElement>('setup-model-list')
const setupAll = must<HTMLInputElement>('setup-all')
const aboutLink = must<HTMLAnchorElement>('about-x')

let bridge: NanoBridge | null = null
let onConfig: (status: ConfigStatus) => void = () => {}
let lastStatus: ConfigStatus | null = null
/** Which saved provider the form is editing. `null` means a new one. */
let editing: string | null = null
// What the endpoint offers, and which of those the user allows. A session may
// only run something in `allowed`, which is why the picker is a list of
// checkboxes rather than a free-text field once a fetch has succeeded.
let available: string[] = []
let allowed = new Set<string>()

export function latestConfig(): ConfigStatus | null {
  return lastStatus
}

export function openSettings(pane: 'providers' | 'about' = 'providers'): void {
  showPane(pane)
  if (!dialog.open) dialog.showModal()
  if (pane === 'providers') setupBase.focus()
}

export function closeSettings(): void {
  if (dialog.open) dialog.close()
}

function showPane(pane: 'providers' | 'about'): void {
  providersPane.hidden = pane !== 'providers'
  aboutPane.hidden = pane !== 'about'
  navProviders.classList.toggle('current', pane === 'providers')
  navAbout.classList.toggle('current', pane === 'about')
}

/**
 * Which model a save leaves the provider running. There is no field for it:
 * the composer's model chip is where a model is chosen, so settings only has
 * to keep a working answer — what is running now if it is still allowed, and
 * otherwise the first model ticked.
 */
function activeModel(): string {
  const picks = [...allowed]
  const active = lastStatus?.active
  const current = active !== undefined && active.providerId === editing ? active.model : ''
  if (current !== '' && picks.includes(current)) return current
  return picks[0] ?? current
}

function currentKind(): ProviderKind {
  return setupKind.value === 'anthropic' ? 'anthropic' : 'openai'
}

/**
 * Which half of the URL to paste. The two ecosystems disagree about who owns
 * the version segment, and nobody can tell from an empty field whether the
 * endpoint path belongs in it, so the field says so.
 *
 * The text lives here rather than in `core/config.ts` because the renderer is
 * served over `app://` and may only load modules from its own directory: a
 * runtime import from `../core/` fails to fetch and takes the whole page down.
 */
const BASE_HINT: Record<ProviderKind, string> = {
  anthropic:
    'Everything before /messages — with or without the version segment. ' +
    'Examples: https://api.z.ai/api/anthropic, https://api.commandcode.ai/provider, https://api.anthropic.com/v1',
  openai:
    'Everything before /chat/completions — with or without the version segment. ' +
    'Examples: https://api.deepseek.com/v1, https://api.z.ai/api/paas/v4, http://localhost:11434/v1',
}

function renderBaseHint(): void {
  const kind = currentKind()
  setupBaseHint.textContent = BASE_HINT[kind]
  setupBase.placeholder = kind === 'anthropic' ? 'https://api.example.com/provider' : 'https://api.example.com/v1'
}

function renderModels(): void {
  setupModels.hidden = available.length === 0
  setupModelList.replaceChildren()

  for (const id of available) {
    const row = el('label', 'model-row')
    const box = el('input')
    box.type = 'checkbox'
    box.value = id
    box.checked = allowed.has(id)
    box.addEventListener('change', () => {
      if (box.checked) allowed.add(id)
      else allowed.delete(id)
      renderModels()
    })
    row.append(box, el('span', undefined, id))
    setupModelList.append(row)
  }

  setupAll.checked = available.length > 0 && allowed.size === available.length
  setupAll.indeterminate = allowed.size > 0 && allowed.size < available.length
}

/** The saved endpoints, one row each, so switching between them is one click. */
function renderProviders(status: ConfigStatus): void {
  providers.hidden = status.providers.length === 0
  providerList.replaceChildren()

  for (const provider of status.providers) {
    const row = el('div', 'provider-row')
    row.classList.toggle('editing', provider.id === editing)
    row.classList.toggle('active', provider.id === status.active?.providerId)

    const count = `${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`
    const open = el('button', 'provider-open')
    open.type = 'button'
    open.append(
      el('span', 'provider-name', provider.name),
      el('span', 'provider-detail', `${provider.kind} · ${count}${provider.hasKey ? '' : ' · no key'}`),
    )
    open.addEventListener('click', () => {
      editing = provider.id
      loadForm(provider)
      renderProviders(status)
    })

    // Removing a provider is an act on one card, so the control is on that
    // card. As a button at the foot of the form it named nothing in particular.
    const remove = el('button', 'icon-btn tiny danger provider-remove')
    remove.type = 'button'
    remove.append(icon(GLYPH.close, 12))
    remove.title = `Remove ${provider.name}`
    remove.setAttribute('aria-label', `Remove ${provider.name}`)
    remove.addEventListener('click', () => void removeProvider(provider.id, provider.name))

    row.append(open, remove)
    providerList.append(row)
  }
}

/** Fill the form from a saved provider, or blank it for a new one. */
function loadForm(provider: ProviderView | null): void {
  setupName.value = provider?.name ?? ''
  setupKind.value = provider?.kind ?? 'openai'
  setupBase.value = provider?.baseURL ?? ''
  setupKey.value = ''
  setupKey.placeholder = provider?.hasKey === true ? 'stored - leave blank to keep it' : 'stored encrypted, never written in plain text'

  available = provider?.models ?? []
  allowed = new Set(available)
  setupProbeNote.textContent = ''
  renderBaseHint()
  renderModels()
}

export function applyConfig(status: ConfigStatus): void {
  lastStatus = status

  setupTitle.textContent = status.configured ? 'Providers' : 'Set up a provider'
  setupHint.textContent = status.configured
    ? 'Pick a provider to edit, or add another. Test the endpoint, fetch what it offers, and tick the models this harness may run. Leave the key blank to keep the stored one.'
    : 'NanoHarness ships with no endpoint and no model built in. Point it at any OpenAI-compatible or Anthropic API. The key is encrypted by your OS and stored outside this repo; the rest lands in a plain settings file.'

  // Keep editing whatever row the user was on; otherwise follow the active
  // provider, and fall back to a blank form when nothing is saved yet.
  const target = status.providers.find(p => p.id === editing) ?? status.providers.find(p => p.id === status.active?.providerId) ?? null
  editing = target?.id ?? null
  loadForm(target)
  renderProviders(status)

  const notes: string[] = []
  if (status.problem !== undefined) notes.push(status.problem)
  if (status.keyStorage === 'unavailable') {
    notes.push('This OS has no secret store, so a key cannot be saved here. Install a keyring and reopen settings.')
  }
  setupNote.textContent = notes.join(' ')

  // Nothing can run: the sheet is the only useful thing on screen.
  if (!status.configured) openSettings('providers')
  onConfig(status)
}

async function probe(intent: 'test' | 'fetch'): Promise<void> {
  if (bridge === null) return
  const key = setupKey.value.trim()
  const request = {
    kind: currentKind(),
    baseURL: setupBase.value.trim(),
    ...(key === '' ? {} : { apiKey: key }),
    ...(editing === null ? {} : { providerId: editing }),
  }
  setupTest.disabled = true
  setupFetch.disabled = true
  setupProbeNote.textContent = intent === 'test' ? 'testing...' : 'fetching...'
  try {
    const result = await bridge.probeProvider(request)
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

export async function refreshConfig(): Promise<void> {
  if (bridge === null) return
  try {
    applyConfig(await bridge.config())
  } catch (err) {
    setupNote.textContent = message(err)
    openSettings('providers')
  }
}

async function saveSetup(): Promise<void> {
  if (bridge === null) return
  const request: ProviderSaveRequest = {
    name: setupName.value.trim(),
    kind: currentKind(),
    baseURL: setupBase.value.trim(),
    models: [...allowed],
  }
  if (editing !== null) request.id = editing
  const apiKey = setupKey.value.trim()
  if (apiKey !== '') request.apiKey = apiKey
  const model = activeModel()
  if (model !== '') request.activeModel = model

  setupSave.disabled = true
  setupNote.textContent = 'saving...'
  try {
    const status = await bridge.saveProvider(request)
    applyConfig(status)
    if (status.configured) setupNote.textContent = 'Saved.'
  } catch (err) {
    setupNote.textContent = message(err)
  } finally {
    setupSave.disabled = false
  }
}

async function removeProvider(id: string, name: string): Promise<void> {
  if (bridge === null) return
  const go = await ask({ title: `Remove ${name}?`, detail: 'Its key is deleted with it. Sessions already started keep running until they end.' })
  if (!go) return
  try {
    if (editing === id) editing = null
    applyConfig(await bridge.deleteProvider(id))
  } catch (err) {
    setupNote.textContent = message(err)
  }
}

export interface SettingsHandlers {
  bridge: NanoBridge
  onConfig(status: ConfigStatus): void
  version: string
}

export function initSettings(handlers: SettingsHandlers): void {
  bridge = handlers.bridge
  onConfig = handlers.onConfig
  aboutVersion.textContent = `nanoharness v${handlers.version}`

  navProviders.addEventListener('click', () => showPane('providers'))
  navAbout.addEventListener('click', () => showPane('about'))
  closeButton.addEventListener('click', () => closeSettings())
  // Esc closes a <dialog> on its own, which would strand a user with no
  // provider on an app that cannot run. Reopen unless something can run.
  dialog.addEventListener('close', () => {
    if (lastStatus !== null && !lastStatus.configured) openSettings('providers')
  })

  setupSave.addEventListener('click', () => void saveSetup())
  // The window itself may not navigate, so the one link in the app is handed
  // to the OS browser.
  aboutLink.addEventListener('click', event => {
    event.preventDefault()
    void handlers.bridge.openExternal(aboutLink.href)
  })
  providerAdd.addEventListener('click', () => {
    editing = null
    loadForm(null)
    if (lastStatus) renderProviders(lastStatus)
    setupName.focus()
  })
  // The saved-state complaint stops being true the moment the user starts typing.
  for (const field of [setupBase, setupKey, setupName]) {
    field.addEventListener('input', () => {
      setupNote.textContent = ''
    })
  }
  setupKind.addEventListener('change', renderBaseHint)
  setupTest.addEventListener('click', () => void probe('test'))
  setupFetch.addEventListener('click', () => void probe('fetch'))
  setupAll.addEventListener('change', () => {
    allowed = setupAll.checked ? new Set(available) : new Set()
    renderModels()
  })
  setupKey.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveSetup()
    }
  })
  renderBaseHint()
  showPane('providers')
}
