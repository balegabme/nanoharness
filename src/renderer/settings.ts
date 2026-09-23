// doc: docs/harness/ui.md
import { ask } from './confirm.js'
import { el, GLYPH, icon, message, must, relativeTime } from './dom.js'
import { EFFORTS, factGaps, gapText, isProviderKind, PRICE_LABEL, PRICES, priceText, resolveFacts, WARN } from './facts.js'
import { matches } from './match.js'
import type { ApprovalCandidate, ApprovalConfig } from '../core/approval.js'
import type { ConfigStatus, NanoBridge, ProviderSaveRequest, ProviderView, SecretView } from '../ipc/contract.js'
import type { KnownProvider } from '../providers/profiles.js'
import type { Effort, ModelFacts, PriceKey, ProviderKind } from '../core/config.js'

/**
 * Settings is a sheet over the app, not a screen the app falls back to: the
 * conversation stays where it was. It opens by itself only when nothing can
 * run: no provider saved, or a saved one that no longer resolves.
 */

const dialog = must<HTMLDialogElement>('settings-dialog')
const closeButton = must<HTMLButtonElement>('settings-close')
const navProviders = must<HTMLButtonElement>('pane-providers')
const navSecrets = must<HTMLButtonElement>('pane-secrets')
const navApproval = must<HTMLButtonElement>('pane-approval')
const navAbout = must<HTMLButtonElement>('pane-about')
const providersPane = must<HTMLElement>('providers-pane')
const secretsPane = must<HTMLElement>('secrets-pane')
const secretList = must<HTMLElement>('secret-list')
const secretsEmpty = must<HTMLElement>('secrets-empty')
const approvalPane = must<HTMLElement>('approval-pane')
const approvalProvider = must<HTMLSelectElement>('approval-provider')
const approvalModel = must<HTMLSelectElement>('approval-model')
const approvalAdd = must<HTMLButtonElement>('approval-add')
const approvalList = must<HTMLElement>('approval-list')
const approvalEmpty = must<HTMLElement>('approval-empty')
const approvalEffort = must<HTMLSelectElement>('approval-effort')
const approvalNote = must<HTMLElement>('approval-note')
const aboutPane = must<HTMLElement>('about-pane')
const aboutVersion = must<HTMLElement>('about-version')

const providers = must<HTMLElement>('providers')
const providerList = must<HTMLElement>('provider-list')
const providerAdd = must<HTMLButtonElement>('provider-add')
const setupStart = must<HTMLElement>('setup-start')
const setupKnown = must<HTMLSelectElement>('setup-known')
const setupKnownNote = must<HTMLElement>('setup-known-note')
const setupFields = must<HTMLElement>('setup-fields')
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
const setupAllLabel = must<HTMLElement>('setup-all-label')
const setupAllCount = must<HTMLElement>('setup-all-count')
const setupFilter = must<HTMLInputElement>('setup-filter')
const setupModelsEmpty = must<HTMLElement>('setup-models-empty')
const aboutLink = must<HTMLAnchorElement>('about-x')

let bridge: NanoBridge | null = null
let onConfig: (status: ConfigStatus) => void = () => {}
let lastStatus: ConfigStatus | null = null
/** Which saved provider the form is editing. `null` means a new one. */
let editing: string | null = null
// What the endpoint offers, and which of those the user allows. A session may
// only run something in `allowed`, which is why the picker is a list of
// checkboxes and not a free-text field once a fetch has succeeded.
let available: string[] = []
let allowed = new Set<string>()
/** What is typed in the box over the model list, narrowing what it draws. */
let filter = ''
/** How many models an endpoint has to offer before the box is worth drawing. */
const FILTER_FROM = 10

/** Empty the box, and put back the list it was narrowing. */
function clearFilter(): void {
  filter = ''
  setupFilter.value = ''
}
// What the last fetch learned about each model, and what the user typed over
// it. Most endpoints say nothing about prices or effort levels, which is why
// the second map exists at all.
let reported: Record<string, ModelFacts> = {}
let overrides: Record<string, ModelFacts> = {}
/**
 * True while the fields point at an endpoint the two maps do not describe. The
 * maps are kept, because an address typed over by accident comes back with
 * everything on it; a save made while the flag is up leaves both out, so main
 * drops what the endpoint that is gone had stored.
 */
let factsStale = false
/**
 * The last fetch for a saved provider, and what the note said about it. A save
 * reloads the form from disk, and disk knows only the models that were ticked;
 * this is what puts the rest of the offered list back on screen.
 */
let fetched: { providerId: string; ids: string[]; note: string } | null = null
/** Which rows have their editor open. Closed is the normal state. */
let opened = new Set<string>()

export function latestConfig(): ConfigStatus | null {
  return lastStatus
}

export function openSettings(pane: SettingsPane = 'providers'): void {
  showPane(pane)
  if (!dialog.open) dialog.showModal()
  if (pane === 'providers') setupBase.focus()
}

export type SettingsPane = 'providers' | 'secrets' | 'approval' | 'about'

export function closeSettings(): void {
  if (dialog.open) dialog.close()
}

function showPane(pane: SettingsPane): void {
  providersPane.hidden = pane !== 'providers'
  secretsPane.hidden = pane !== 'secrets'
  approvalPane.hidden = pane !== 'approval'
  aboutPane.hidden = pane !== 'about'
  navProviders.classList.toggle('current', pane === 'providers')
  navSecrets.classList.toggle('current', pane === 'secrets')
  navApproval.classList.toggle('current', pane === 'approval')
  navAbout.classList.toggle('current', pane === 'about')
  if (pane === 'secrets') void refreshSecrets()
  if (pane === 'approval') drawApproval()
}

/**
 * The approval ladder: which models auto mode may ask, in the order it tries
 * them.
 *
 * Held here while the pane is open and written through on every change, so
 * there is nothing to leave unsaved.
 */
let ladder: ApprovalCandidate[] = []

function drawApproval(): void {
  const status = lastStatus
  if (status === null) return
  ladder = [...(status.approval?.candidates ?? [])]

  // Only providers with a key: a rung that cannot authenticate fails on the
  // first question.
  const usable = status.providers.filter(p => p.hasKey)
  approvalProvider.replaceChildren()
  for (const provider of usable) {
    const option = el('option')
    option.value = provider.id
    option.textContent = provider.name
    approvalProvider.append(option)
  }
  approvalProvider.disabled = usable.length === 0
  drawApprovalModels()

  approvalEffort.replaceChildren()
  for (const effort of EFFORTS) {
    const option = el('option')
    option.value = effort
    option.textContent = effort
    approvalEffort.append(option)
  }
  approvalEffort.value = status.approval?.effort ?? 'low'

  approvalList.replaceChildren()
  approvalEmpty.hidden = ladder.length > 0
  ladder.forEach((candidate, index) => {
    const provider = status.providers.find(p => p.id === candidate.providerId)
    const row = el('div', 'entry-row')
    const text = el('div', 'entry-text')
    text.append(
      el('code', 'entry-name', candidate.model),
      // A provider that has been deleted leaves a rung nothing can climb. It
      // is shown as broken and never dropped from the list.
      el('span', 'entry-hint', provider === undefined ? `${WARN} this provider is gone` : `${index + 1}. ${provider.name}`),
    )

    const actions = el('div', 'entry-actions')
    if (index > 0) {
      const up = el('button', 'btn sm outline')
      up.type = 'button'
      up.textContent = 'Move up'
      up.addEventListener('click', () => {
        const [moved] = ladder.splice(index, 1)
        if (moved !== undefined) ladder.splice(index - 1, 0, moved)
        void writeApproval()
      })
      actions.append(up)
    }
    const remove = el('button', 'btn sm outline danger-text')
    remove.type = 'button'
    remove.textContent = 'Remove'
    remove.addEventListener('click', () => {
      ladder.splice(index, 1)
      void writeApproval()
    })
    actions.append(remove)

    row.append(text, actions)
    approvalList.append(row)
  })

  approvalNote.textContent = status.approvalProblem === undefined ? '' : `${WARN} ${status.approvalProblem}, so auto-approve cannot be turned on.`
}

/** The models of whichever provider is selected in the add row. */
function drawApprovalModels(): void {
  const provider = lastStatus?.providers.find(p => p.id === approvalProvider.value)
  approvalModel.replaceChildren()
  for (const model of provider?.models ?? []) {
    const option = el('option')
    option.value = model
    option.textContent = model
    approvalModel.append(option)
  }
  const none = (provider?.models.length ?? 0) === 0
  approvalModel.disabled = none
  approvalAdd.disabled = none
}

async function writeApproval(): Promise<void> {
  if (bridge === null) return
  const effort = approvalEffort.value
  const next: ApprovalConfig = { candidates: ladder, ...(isEffortValue(effort) ? { effort } : {}) }
  const rules = lastStatus?.approval?.rules
  if (rules !== undefined) next.rules = rules
  try {
    applyConfig(await bridge.saveApproval(next))
    drawApproval()
  } catch (err) {
    // Never silently: the ladder on screen would then disagree with the one
    // that will actually be asked.
    approvalNote.textContent = `${WARN} ${message(err)}`
  }
}

function isEffortValue(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value)
}

/**
 * What the vault holds. Names and vendors only: the value never crosses the
 * bridge, not even here. There is nothing this pane could do with it that
 * would not amount to putting the key back on screen.
 *
 * The pane exists because capture is automatic and pattern-based, so it will
 * occasionally take something that was not a key, and that has to be undoable.
 */
async function refreshSecrets(): Promise<void> {
  if (bridge === null) return
  const held = await bridge.secrets().catch(() => [])
  drawSecrets(held)
}

function drawSecrets(held: readonly SecretView[]): void {
  secretList.replaceChildren()
  secretsEmpty.hidden = held.length > 0
  for (const secret of held) {
    const row = el('div', 'entry-row')
    const text = el('div', 'entry-text')
    text.append(el('code', 'entry-name', `{{secret:${secret.name}}}`), el('span', 'entry-hint', `${secret.hint} · added ${relativeTime(secret.at)}`))

    const forget = el('button', 'btn sm outline danger-text')
    forget.type = 'button'
    forget.textContent = 'Forget'
    // A reference in an old transcript outlives the key it names, so say what
    // forgetting costs before it happens, and not after.
    forget.title = 'Drop the key. Messages that already reference it stop working.'
    forget.addEventListener('click', () => void forgetSecret(secret.name))

    row.append(text, forget)
    secretList.append(row)
  }
}

async function forgetSecret(name: string): Promise<void> {
  if (bridge === null) return
  const go = await ask({
    title: `Forget ${name}?`,
    detail: 'The key is deleted. Anything that already references it, this session or an old one, will send the reference itself.',
    confirmLabel: 'Forget',
  })
  if (!go) return
  drawSecrets(await bridge.forgetSecret(name).catch(() => []))
}

/**
 * Which model a save leaves the provider running. There is no field for it:
 * the composer's model chip is where a model is chosen, so settings only has
 * to keep a working answer: what is running now if it is still allowed, and
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
  return isProviderKind(setupKind.value) ? setupKind.value : 'openai'
}

/**
 * Which half of the URL to paste. The two ecosystems disagree about who owns
 * the version segment, and nobody can tell from an empty field whether the
 * endpoint path belongs in it, so the field says so.
 *
 * The text lives here and not in `core/config.ts` because the renderer is
 * served over `app://` and may only load modules from its own directory: a
 * runtime import from `../core/` fails to fetch and takes the whole page down.
 */
const BASE_HINT: Record<ProviderKind, string> = {
  anthropic:
    'Everything before /messages, with or without the version segment. ' +
    'A gateway path counts as part of it: https://host/v1, https://host/api/anthropic, https://host/provider.',
  openai:
    'Everything before /chat/completions, with or without the version segment. ' +
    'A gateway path counts as part of it: https://host/v1, https://host/api/paas/v4, http://localhost:11434/v1.',
  responses:
    'Everything before /responses, with or without the version segment. ' +
    'A gateway path counts as part of it: https://host/v1, https://host/api/openai.',
}

function renderBaseHint(): void {
  const kind = currentKind()
  setupBaseHint.textContent = BASE_HINT[kind]
  setupBase.placeholder = kind === 'anthropic' ? 'https://api.example.com/provider' : 'https://api.example.com/v1'
}

/**
 * The picker's options, past the blank one the markup ships with. An entry is a
 * starting point and nothing more: it writes the fields and the record that
 * gets saved is an ordinary one, editable and deletable like any other.
 */
function renderKnown(known: readonly KnownProvider[]): void {
  while (setupKnown.options.length > 1) setupKnown.remove(1)
  for (const entry of known) setupKnown.add(new Option(entry.label, entry.id))
}

/**
 * Show what the picker did not already answer. An entry decides the name, the
 * wire and the address, so all three fold away and the form asks for the two
 * things left: the key, and which models to allow. Going back to setting it up
 * by hand brings them out again, holding whatever the entry put there.
 */
function renderPicked(): void {
  const entry = lastStatus?.knownProviders.find(known => known.id === setupKnown.value)
  setupKnownNote.textContent = entry?.note ?? ''
  setupFields.hidden = entry !== undefined
  // Reachability is the question a typed address raises. An entry's address is
  // right by construction, and fetching answers the key as well as the host,
  // so the picked path is one button and not two of equal weight.
  setupTest.hidden = entry !== undefined
}

/**
 * The rows to draw: what the endpoint offered, in an order a person can scan,
 * narrowed to whatever the filter asks for. Sorting happens here and not on
 * the way in, because the order the list is stored in is the endpoint's to
 * decide and this one is only about reading it. Digits sort as numbers, so
 * `gpt-5.2` comes before `gpt-5.10`.
 */
function shownModels(): string[] {
  return available.filter(id => matches(filter, id)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** What the tick at the top of the list would do, given what is under it. */
function allText(shown: number, offered: number): string {
  if (shown === offered || shown === 0) return 'Select all'
  return shown === 1 ? 'Select the one shown' : `Select these ${shown}`
}

function renderModels(): void {
  setupModels.hidden = available.length === 0
  // Worth its own line once the list is longer than a glance holds. Below that
  // the box is a control asking to be used on six rows already on screen.
  setupFilter.hidden = available.length < FILTER_FROM
  const shown = shownModels()
  setupModelList.replaceChildren()

  for (const id of shown) {
    setupModelList.append(modelRow(id))
    if (opened.has(id)) setupModelList.append(modelEditor(id))
  }

  setupModelsEmpty.hidden = shown.length > 0 || available.length === 0
  setupModelsEmpty.textContent = `Nothing offered here is called anything like “${filter.trim()}”.`

  // The tick at the top answers for the rows under it. With a filter on, the
  // models it is hiding are not what the user was just asked about.
  const ticked = shown.filter(id => allowed.has(id)).length
  setupAll.checked = shown.length > 0 && ticked === shown.length
  setupAll.indeterminate = ticked > 0 && ticked < shown.length
  setupAll.disabled = shown.length === 0
  setupAllLabel.textContent = allText(shown.length, available.length)
  setupAllCount.textContent = `${allowed.size} of ${available.length} ticked`

  // The next step carries the weight. A provider with no model it may run is
  // refused, so until something has been fetched there is nothing to save and
  // asking the endpoint is the only move on the screen worth making.
  const nothingYet = available.length === 0
  setupFetch.classList.toggle('primary', nothingYet)
  setupFetch.classList.toggle('outline', !nothingYet)
  setupSave.classList.toggle('primary', !nothingYet)
  setupSave.classList.toggle('outline', nothingYet)
}

/** What is known about one model right now, endpoint answer plus corrections. */
function factsFor(id: string): ModelFacts {
  // What the endpoint the maps belong to said is not an answer about the one
  // in the fields, so the rows read unknown while the form is pointed away.
  return factsStale ? {} : resolveFacts({ facts: reported, overrides }, id)
}

/**
 * One model: whether the harness may run it, and what it costs to. A model the
 * endpoint described reads its own line; one it did not gets the warning mark,
 * which opens the same editor either way.
 */
function modelRow(id: string): HTMLElement {
  // The tick and the cogwheel are two controls, so only the tick is wrapped in
  // the <label>. A button inside it would be read out as part of the
  // checkbox's name, and clicking it would tick the box on the way past.
  const row = el('div', 'model-row')
  const pick = el('label', 'model-pick')
  const box = el('input', 'model-tick')
  box.type = 'checkbox'
  box.value = id
  box.dataset.model = id
  box.checked = allowed.has(id)
  box.addEventListener('change', () => {
    if (box.checked) allowed.add(id)
    else allowed.delete(id)
    // The redraw throws this row away, so the tick keeps the keyboard the same
    // way the cogwheel below does.
    renderModels()
    focusOn(`.model-tick[data-model="${CSS.escape(id)}"]`)
  })

  const facts = factsFor(id)
  const gaps = factGaps(facts)
  const detail = el('span', 'model-detail')
  const price = priceText(facts)
  const efforts = facts.efforts?.join(', ') ?? ''
  detail.textContent = [price, efforts].filter(part => part !== '').join(' · ')
  if (gaps.length > 0) {
    detail.classList.add('unknown')
    detail.textContent = `${detail.textContent === '' ? '' : `${detail.textContent} · `}${WARN} ${gaps.join(' and ')} unknown`
    detail.title = gapText(gaps)
  }

  const edit = el('button', 'icon-btn model-edit-open')
  edit.type = 'button'
  edit.dataset.model = id
  edit.append(icon(GLYPH.gear, 15))
  edit.title = opened.has(id) ? 'Close the settings for this model' : 'Set this model’s effort levels and prices by hand'
  edit.setAttribute('aria-label', edit.title)
  edit.setAttribute('aria-expanded', String(opened.has(id)))
  edit.classList.toggle('on', opened.has(id))
  edit.addEventListener('click', () => {
    if (opened.has(id)) opened.delete(id)
    else opened.add(id)
    // The row the click landed on is thrown away and built again, so the focus
    // is put back where it was. Without this the keyboard user who opened the
    // editor is returned to the top of the page.
    renderModels()
    focusOn(`.model-edit-open[data-model="${CSS.escape(id)}"]`)
  })

  pick.append(box, el('span', 'model-id', id), detail)
  row.append(pick, edit)
  return row
}

/** Put the keyboard back on a control that a redraw has just replaced. */
function focusOn(selector: string): void {
  const again = setupModelList.querySelector(selector)
  if (again instanceof HTMLElement) again.focus()
}

/**
 * The manual half. Nothing here is guessed for the user: an endpoint that
 * publishes neither prices nor effort levels leaves the fields blank, and blank
 * means every level stays on offer and no cost is shown.
 */
function modelEditor(id: string): HTMLElement {
  const wrap = el('div', 'model-edit')
  const typed = factsStale ? {} : (overrides[id] ?? {})
  const facts = factsFor(id)

  const levels = el('div', 'model-efforts')
  levels.append(el('span', 'model-edit-label', 'Effort levels it takes'))
  for (const effort of EFFORTS) {
    const label = el('label', 'effort-box')
    const box = el('input', 'effort-input')
    box.type = 'checkbox'
    box.checked = facts.efforts?.includes(effort) ?? false
    box.dataset.model = id
    box.dataset.effort = effort
    box.addEventListener('change', () => {
      const current = new Set(overrides[id]?.efforts ?? facts.efforts ?? [])
      if (box.checked) current.add(effort)
      else current.delete(effort)
      writeOverride(id, { efforts: [...EFFORTS].filter(e => current.has(e)) })
      // The redraw throws the box away, so the keyboard comes back to it.
      focusOn(`.effort-input[data-model="${CSS.escape(id)}"][data-effort="${effort}"]`)
    })
    label.append(box, el('span', undefined, effort))
    levels.append(label)
  }

  const costs = el('div', 'model-costs')
  costs.append(el('span', 'model-edit-label', 'US dollars per million tokens'))
  for (const key of PRICES) costs.append(priceField(id, key, PRICE_LABEL[key], typed[key] ?? facts[key]))

  const reset = el('button', 'btn sm outline model-edit-reset')
  reset.type = 'button'
  reset.dataset.model = id
  reset.textContent = 'Clear what I typed'
  reset.title = 'Drop the corrections for this model and go back to whatever the fetch found.'
  reset.addEventListener('click', () => {
    delete overrides[id]
    renderModels()
    focusOn(`.model-edit-reset[data-model="${CSS.escape(id)}"]`)
  })

  wrap.append(levels, costs, windowField(id, typed.context ?? facts.context), visionField(id, facts.vision), reset)
  return wrap
}

/**
 * The model's context window. Without one the meter has no percentage and
 * nothing compacts on its own, so an endpoint that does not publish it leaves
 * the field for the user.
 */
function windowField(id: string, value: number | undefined): HTMLElement {
  const wrap = el('div', 'model-window')
  const field = el('label', 'price-field')
  const box = el('input')
  box.type = 'number'
  box.min = '1'
  box.step = '1000'
  box.value = value === undefined ? '' : String(value)
  box.placeholder = 'unknown'
  box.addEventListener('change', () => {
    const parsed = Number(box.value.trim())
    writeOverride(id, { context: Number.isInteger(parsed) && parsed > 0 ? parsed : undefined })
  })
  field.append(el('span', undefined, 'tokens'), box)
  wrap.append(el('span', 'model-edit-label', 'Context window'), field)
  return wrap
}

/**
 * Whether the model takes images. Three answers and not a checkbox: an
 * endpoint that published nothing has not said no, and a box left unticked
 * would say it had.
 */
function visionField(id: string, value: boolean | undefined): HTMLElement {
  const wrap = el('div', 'model-vision')
  wrap.append(el('span', 'model-edit-label', 'Takes images'))
  const pick = el('select', 'vision-select')
  pick.dataset.model = id
  for (const [option, label] of [['', 'not said'], ['yes', 'yes'], ['no', 'no']] as const) {
    const choice = el('option', undefined, label)
    choice.value = option
    pick.append(choice)
  }
  pick.value = value === undefined ? '' : value ? 'yes' : 'no'
  pick.addEventListener('change', () => {
    writeOverride(id, { vision: pick.value === '' ? undefined : pick.value === 'yes' })
    focusOn(`.vision-select[data-model="${CSS.escape(id)}"]`)
  })
  wrap.append(pick)
  return wrap
}

function priceField(id: string, key: PriceKey, label: string, value: number | undefined): HTMLElement {
  const wrap = el('label', 'price-field')
  const box = el('input')
  box.type = 'number'
  box.min = '0'
  box.step = '0.01'
  box.value = value === undefined ? '' : String(value)
  box.placeholder = key === 'cacheRead' || key === 'cacheWrite' ? 'same as in' : 'unknown'
  // No focus restore here, unlike the checkboxes: `change` fires when the field
  // is left, and pulling the caret back would fight the tab key.
  box.addEventListener('change', () => {
    const typed = box.value.trim()
    const parsed = Number(typed)
    // An emptied field is not a price of zero. Zero is what a free model costs,
    // and the two have to stay tellable apart or a free model reads as unknown.
    if (typed === '' || !Number.isFinite(parsed) || parsed < 0) writeOverride(id, { [key]: undefined })
    else writeOverride(id, { [key]: parsed })
  })
  wrap.append(el('span', undefined, label), box)
  return wrap
}

/** Fold one field into this model's corrections and redraw. */
function writeOverride(id: string, patch: Partial<Record<'efforts' | 'vision' | 'context' | PriceKey, Effort[] | number | boolean | undefined>>): void {
  const next: ModelFacts = { ...overrides[id] }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key as keyof ModelFacts]
    else Object.assign(next, { [key]: value })
  }
  if (Object.keys(next).length === 0) delete overrides[id]
  else overrides[id] = next
  renderModels()
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
    // card and not at the foot of the form.
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

/**
 * The address the facts on screen were fetched from, so editing the field can
 * tell a changed endpoint from a cursor moved through it.
 */
let savedBase = ''
/** The wire the facts on screen describe, alongside the address. */
let savedKind: ProviderKind = 'openai'

/** Fill the form from a saved provider, or blank it for a new one. */
function loadForm(provider: ProviderView | null): void {
  // The picker fills the fields and then stops describing them: what is on
  // screen after an edit is the form's, not the entry's. A saved provider is
  // not offered it at all, since picking would write over the record on screen.
  setupKnown.value = ''
  setupStart.hidden = provider !== null || (lastStatus?.knownProviders.length ?? 0) === 0
  renderPicked()
  savedBase = provider?.baseURL ?? ''
  savedKind = provider?.kind ?? 'openai'
  // Whatever is loaded next describes the endpoint in the fields.
  factsStale = false
  setupName.value = provider?.name ?? ''
  setupKind.value = provider?.kind ?? 'openai'
  setupBase.value = provider?.baseURL ?? ''
  setupKey.value = ''
  setupKey.placeholder = provider?.hasKey === true ? 'stored - leave blank to keep it' : 'stored encrypted, never written in plain text'

  // A fetch of this same provider is still on screen, so the form keeps what it
  // is showing: the whole offered list, the rows opened for editing, and the
  // note. Any other provider starts from what is stored.
  const shown = provider !== null && fetched?.providerId === provider.id ? fetched : null
  if (shown === null) {
    fetched = null
    available = provider?.models ?? []
    allowed = new Set(available)
    reported = { ...provider?.facts }
    overrides = { ...provider?.overrides }
    opened = new Set()
  } else {
    available = shown.ids
  }
  setupProbeNote.textContent = shown?.note ?? ''
  // The box narrowed a list that is not on screen any more.
  clearFilter()
  renderBaseHint()
  renderModels()
}

export function applyConfig(status: ConfigStatus): void {
  lastStatus = status
  renderKnown(status.knownProviders)

  setupTitle.textContent = status.configured ? 'Providers' : 'Set up a provider'
  setupHint.textContent = status.configured
    ? 'Pick a provider to edit, or add another. Test the endpoint, fetch what it offers, and tick the models this harness may run. Leave the key blank to keep the stored one.'
    : 'NanoHarness ships with no endpoint and no model built in. Pick one below and paste a key, or set up any OpenAI-compatible or Anthropic API yourself. The key is encrypted by your OS and stored outside this repo; the rest lands in a plain settings file.'

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
  // Which provider this answer belongs to. The sheet stays live while the
  // request is out, so a user who picks another row mid-fetch gets that row,
  // not a list of some other endpoint's models written over it.
  const asked = editing
  setupTest.disabled = true
  setupFetch.disabled = true
  setupProbeNote.textContent = intent === 'test' ? 'testing...' : 'fetching...'
  try {
    const result = await bridge.probeProvider(request)
    if (editing !== asked) return
    // The address or the wire can change while the answer is out, so what came
    // back can be about an endpoint the form has left. None of it belongs to
    // the field now, and storing it would price one endpoint as another.
    if (currentKind() !== request.kind || setupBase.value.trim() !== request.baseURL) {
      setupProbeNote.textContent = 'The endpoint changed while the request was out. Try again.'
      return
    }
    if (!result.ok) {
      setupProbeNote.textContent = result.error
      return
    }
    const ids = result.models.map(offer => offer.id)
    const count = `${ids.length} model${ids.length === 1 ? '' : 's'}`
    if (intent === 'test') {
      setupProbeNote.textContent = `Connected. ${count} available.`
      return
    }
    const previous = allowed
    available = ids
    reported = Object.fromEntries(result.models.filter(offer => Object.keys(offer.facts).length > 0).map(offer => [offer.id, offer.facts]))
    factsStale = false
    // Keep an existing selection where it still exists. A first fetch selects
    // everything, since the user has not ruled anything out yet.
    allowed = previous.size === 0 ? new Set(ids) : new Set(ids.filter(id => previous.has(id)))
    const blind = ids.filter(id => factGaps(resolveFacts({ facts: reported, overrides }, id)).length > 0).length
    const said =
      blind === 0
        ? ''
        : ` ${WARN} ${blind} of them went undescribed by the endpoint; set those by hand, or leave every level on offer.`
    const note = `${count} offered. Tick the ones this harness may use.${said}`
    setupProbeNote.textContent = note
    clearFilter()
    renderModels()
    // A fetch of a saved endpoint stores what it learned right away, so the
    // prices and effort levels are in place without a second click. It stores
    // the form as it stands, endpoint and key included, because those are what
    // the fetch just went out with and what the answer belongs to. A provider
    // that has never been saved is left alone until Save is pressed.
    if (asked !== null) {
      // What was just fetched belongs to the address it was fetched from, which
      // is the one in the form now.
      savedBase = setupBase.value.trim()
      savedKind = currentKind()
      fetched = { providerId: asked, ids, note }
      // A fetch is a look at an endpoint and not a choice to run it, so the
      // write it makes on its own does not move the active selection.
      const saved = await saveSetup(true)
      // A refusal is repeated here, next to the list it applies to. A
      // provider switch or an edit during the write nulls `fetched`, and the
      // answer belongs to a form that is no longer on screen.
      if (fetched === null) return
      if (!saved) fetched.note = `${note} ${WARN} Not stored: ${setupNote.textContent}`
      if (editing === asked) setupProbeNote.textContent = fetched.note
    }
  } catch (err) {
    // Same rule as the answer above: a failure belongs to the row it was asked
    // for, and the user may be looking at another one by now.
    if (editing === asked) setupProbeNote.textContent = message(err)
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

/**
 * Write the form to disk. False when nothing was stored, and why is in
 * `setupNote`. `keepActive` is what a fetch uses: it stores what the endpoint
 * said without moving the active selection, which only a press of Save is a
 * decision about.
 */
async function saveSetup(keepActive = false): Promise<boolean> {
  if (bridge === null) return false
  const request: ProviderSaveRequest = {
    name: setupName.value.trim(),
    kind: currentKind(),
    baseURL: setupBase.value.trim(),
    models: [...allowed],
    // After a move off the endpoint these maps describe, both are left out and
    // main drops what that endpoint had stored. An empty map would be the
    // clear signal, and typing the old address back would then lose what it
    // still described.
    ...(factsStale
      ? {}
      : {
          facts: reported,
          // The form is what the user is looking at, so it decides: a model it
          // holds no correction for is sent as `null`, which clears a
          // correction typed before and leaves no stale one behind the new
          // screen.
          overrides: Object.fromEntries(available.map(id => [id, overrides[id] ?? null])),
        }),
  }
  if (editing !== null) request.id = editing
  const apiKey = setupKey.value.trim()
  if (apiKey !== '') request.apiKey = apiKey
  if (!keepActive) {
    const model = activeModel()
    if (model !== '') request.activeModel = model
  }

  setupSave.disabled = true
  setupNote.textContent = 'saving...'
  try {
    const status = await bridge.saveProvider(request)
    applyConfig(status)
    if (status.configured) setupNote.textContent = 'Saved.'
    return true
  } catch (err) {
    setupNote.textContent = message(err)
    return false
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
  navSecrets.addEventListener('click', () => showPane('secrets'))
  navApproval.addEventListener('click', () => showPane('approval'))
  navAbout.addEventListener('click', () => showPane('about'))
  approvalProvider.addEventListener('change', () => drawApprovalModels())
  approvalEffort.addEventListener('change', () => void writeApproval())
  approvalAdd.addEventListener('click', () => {
    const providerId = approvalProvider.value
    const model = approvalModel.value
    if (providerId === '' || model === '') return
    // The same model twice is a ladder with a rung that can never be reached.
    if (ladder.some(c => c.providerId === providerId && c.model === model)) return
    ladder.push({ providerId, model })
    void writeApproval()
  })
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
  // Prices and effort levels describe the endpoint they were fetched from, and
  // the same model id at two addresses of one vendor is two different prices.
  // An address or wire typed over therefore holds them out of the save rather
  // than sending them, and a field put back takes them up again; main drops
  // what the old endpoint stored when the save lands on the new one.
  const onSavedEndpoint = (): boolean => setupBase.value.trim() === savedBase && currentKind() === savedKind
  const dropFacts = (): void => {
    // The offered list belongs to the endpoint it was fetched from too, so a
    // provider switch does not bring the old fetch back with it.
    fetched = null
    if (factsStale) return
    factsStale = true
    if (Object.keys(reported).length === 0 && Object.keys(overrides).length === 0) return
    setupProbeNote.textContent = 'Fetch the models again: what this endpoint charges is not what the last one did.'
    renderModels()
  }
  const onEndpointEdit = (): void => {
    if (!onSavedEndpoint()) {
      dropFacts()
      return
    }
    if (!factsStale) return
    factsStale = false
    setupProbeNote.textContent = ''
    renderModels()
  }
  setupBase.addEventListener('input', onEndpointEdit)
  setupKind.addEventListener('change', () => {
    renderBaseHint()
    onEndpointEdit()
  })
  setupKnown.addEventListener('change', () => {
    const entry = lastStatus?.knownProviders.find(known => known.id === setupKnown.value)
    renderPicked()
    if (entry === undefined) return
    // Everything the endpoint decides, filled in; everything after it is the
    // user's, which is the key and which models to allow.
    setupName.value = entry.label
    setupKind.value = entry.kind
    setupBase.value = entry.baseURL
    setupNote.textContent = ''
    renderBaseHint()
    onEndpointEdit()
    setupKey.focus()
  })
  setupTest.addEventListener('click', () => void probe('test'))
  setupFetch.addEventListener('click', () => void probe('fetch'))
  setupAll.addEventListener('change', () => {
    for (const id of shownModels()) {
      if (setupAll.checked) allowed.add(id)
      else allowed.delete(id)
    }
    renderModels()
  })
  setupFilter.addEventListener('input', () => {
    filter = setupFilter.value
    renderModels()
  })
  setupFilter.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || setupFilter.value === '') return
    // Escape closes the sheet. A box with something in it is the nearer thing
    // to leave, and the second press still closes.
    event.preventDefault()
    clearFilter()
    renderModels()
  })
  setupKey.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    // Whatever the form is waiting for. A key typed against an endpoint nobody
    // has asked yet goes out and asks it, because saving here would store a
    // provider with no model it is allowed to run.
    if (available.length === 0) void probe('fetch')
    else void saveSetup()
  })
  renderBaseHint()
  showPane('providers')
}
