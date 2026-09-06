// doc: docs/harness/ui.md
import { ask } from './confirm.js'
import { el, GLYPH, icon, message, must, relativeTime } from './dom.js'
import type { NanoBridge, SessionView, WorkspaceStatus, WorkspaceView } from '../ipc/contract.js'

/**
 * The sidebar is the session list, grouped by the folder each session was
 * started in. The grouping is not cosmetic: a folder is the boundary its
 * sessions are held to, so the tree shows exactly what a session may touch.
 */

const tree = must<HTMLElement>('tree')
const search = must<HTMLInputElement>('session-search')
const addButton = must<HTMLButtonElement>('workspace-add')
const newButton = must<HTMLButtonElement>('new-session')
const app = must<HTMLElement>('app')
const toggle = must<HTMLButtonElement>('sidebar-toggle')

export interface SidebarHandlers {
  bridge: NanoBridge
  openSession(id: string): void | Promise<void>
  /** After anything that changes what a session may run. */
  changed(status: WorkspaceStatus): void
  report(text: string): void
}

let handlers: SidebarHandlers | null = null
let status: WorkspaceStatus = { workspaces: [], sessions: [] }
let selectedSession: string | null = null
/** The folder a new session lands in: the one last touched. */
let selectedWorkspace: string | null = null
const collapsed = new Set<string>()
/** Whether the column is a rail. A preference about this machine's screen. */
const RAIL_KEY = 'nanoharness.rail'

export function currentStatus(): WorkspaceStatus {
  return status
}

export function selectedWorkspaceId(): string | null {
  return selectedWorkspace ?? status.workspaces[0]?.id ?? null
}

export function workspaceOf(sessionId: string): WorkspaceView | undefined {
  const session = status.sessions.find(s => s.id === sessionId)
  return status.workspaces.find(w => w.id === session?.workspaceId)
}

export function sessionById(id: string): SessionView | undefined {
  return status.sessions.find(s => s.id === id)
}

/** Reflect a session the caller just opened, created or renamed. */
export function select(sessionId: string | null): void {
  selectedSession = sessionId
  if (sessionId !== null) {
    const session = status.sessions.find(s => s.id === sessionId)
    if (session !== undefined) selectedWorkspace = session.workspaceId
  }
  render()
}

export function setStatus(next: WorkspaceStatus): void {
  status = next
  if (selectedSession !== null && !next.sessions.some(s => s.id === selectedSession)) selectedSession = null
  render()
}

function matches(session: SessionView, needle: string): boolean {
  return needle === '' || session.title.toLowerCase().includes(needle)
}

function render(): void {
  const needle = search.value.trim().toLowerCase()
  tree.replaceChildren()

  if (status.workspaces.length === 0) {
    tree.append(el('p', 'tree-empty', 'No folders yet. Add one to start a session.'))
    return
  }

  for (const workspace of status.workspaces) {
    const sessions = status.sessions.filter(s => s.workspaceId === workspace.id && matches(s, needle))
    const group = el('div', 'group')

    const head = el('div', 'group-head')
    const open = !collapsed.has(workspace.id)
    const twisty = el('button', 'twisty')
    twisty.type = 'button'
    twisty.append(icon(GLYPH.chevronDown, 13))
    twisty.setAttribute('aria-expanded', String(open))
    twisty.title = open ? 'Collapse' : 'Expand'
    twisty.addEventListener('click', () => {
      if (collapsed.has(workspace.id)) collapsed.delete(workspace.id)
      else collapsed.add(workspace.id)
      render()
    })

    const name = el('button', 'group-name')
    name.type = 'button'
    name.title = workspace.root
    name.append(el('span', 'group-label', workspace.name), el('span', 'count', String(sessions.length)))
    name.addEventListener('click', () => {
      selectedWorkspace = workspace.id
      render()
    })

    const remove = el('button', 'icon-btn tiny row-action')
    remove.type = 'button'
    remove.append(icon(GLYPH.close, 13))
    remove.title = `Remove ${workspace.name} from the sidebar`
    remove.setAttribute('aria-label', `Remove ${workspace.name}`)
    remove.addEventListener('click', () => void removeWorkspace(workspace))

    head.append(twisty, name, remove)
    head.classList.toggle('current', workspace.id === selectedWorkspaceId())
    group.append(head)

    if (!collapsed.has(workspace.id)) {
      for (const session of sessions) {
        group.append(sessionRow(session))
      }
      if (sessions.length === 0) {
        group.append(el('p', 'tree-empty', needle === '' ? 'No sessions here yet.' : 'Nothing matches.'))
      }
    }
    tree.append(group)
  }
}

function sessionRow(session: SessionView): HTMLElement {
  const row = el('div', 'session-row')
  row.classList.toggle('selected', session.id === selectedSession)

  const open = el('button', 'session-open')
  open.type = 'button'
  open.title = session.title
  open.append(el('span', 'session-title', session.title), el('span', 'session-time', relativeTime(session.updatedAt)))
  open.addEventListener('click', () => void handlers?.openSession(session.id))

  const remove = el('button', 'icon-btn tiny row-action danger')
  remove.type = 'button'
  remove.append(icon(GLYPH.close, 13))
  remove.title = 'Delete session'
  remove.setAttribute('aria-label', 'Delete session')
  remove.addEventListener('click', () => void deleteSession(session))

  row.append(open, remove)
  return row
}

async function removeWorkspace(workspace: WorkspaceView): Promise<void> {
  if (handlers === null) return
  // Removing a folder takes its sessions with it, so say so before it happens.
  const count = status.sessions.filter(s => s.workspaceId === workspace.id).length
  const warning = count === 0 ? '' : ` and ${count} session${count === 1 ? '' : 's'}`
  const go = await ask({
    title: `Remove ${workspace.name}?`,
    detail: `The folder${warning} leaves the sidebar. Files on disk are not touched.`,
  })
  if (!go) return
  try {
    setStatus(await handlers.bridge.removeWorkspace(workspace.id))
    handlers.changed(status)
  } catch (err) {
    handlers.report(message(err))
  }
}

async function deleteSession(session: SessionView): Promise<void> {
  if (handlers === null) return
  const go = await ask({ title: `Delete "${session.title}"?`, detail: 'Its transcript is removed.', confirmLabel: 'Delete' })
  if (!go) return
  try {
    setStatus(await handlers.bridge.deleteSession(session.id))
    handlers.changed(status)
  } catch (err) {
    handlers.report(message(err))
  }
}

async function addWorkspace(): Promise<void> {
  if (handlers === null) return
  try {
    const next = await handlers.bridge.addWorkspace()
    // A cancelled picker is an answer, not a failure: nothing changes.
    if (next === null) return
    setStatus(next)
    const added = next.workspaces[next.workspaces.length - 1]
    if (added !== undefined) selectedWorkspace = added.id
    handlers.changed(next)
  } catch (err) {
    handlers.report(message(err))
  }
}

/** Start a session in the selected folder and open it. */
export async function startSession(): Promise<void> {
  if (handlers === null) return
  const workspaceId = selectedWorkspaceId()
  if (workspaceId === null) {
    await addWorkspace()
    return
  }
  try {
    const session = await handlers.bridge.createSession(workspaceId)
    setStatus(await handlers.bridge.workspaces())
    select(session.id)
    await handlers.openSession(session.id)
  } catch (err) {
    handlers.report(message(err))
  }
}

export function initSidebar(next: SidebarHandlers): void {
  handlers = next
  addButton.addEventListener('click', () => void addWorkspace())
  newButton.addEventListener('click', () => void startSession())
  search.addEventListener('input', render)
  // Collapsed is a rail, not a hidden column: the brand, New session and
  // Settings stay reachable, so the sidebar never has to be found again.
  toggle.addEventListener('click', () => {
    const rail = app.classList.toggle('rail')
    toggle.title = rail ? 'Expand sidebar' : 'Collapse sidebar'
    toggle.setAttribute('aria-label', toggle.title)
    localStorage.setItem(RAIL_KEY, String(rail))
  })
  if (localStorage.getItem(RAIL_KEY) === 'true') toggle.click()
}

export const addWorkspaceFromUI = addWorkspace

export async function refresh(): Promise<void> {
  if (handlers === null) return
  try {
    setStatus(await handlers.bridge.workspaces())
  } catch (err) {
    handlers.report(message(err))
  }
}
