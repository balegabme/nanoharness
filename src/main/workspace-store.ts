// doc: docs/harness/sessions.md
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { isAgentRole } from '../core/agents.js'
import { realResolve } from '../core/scope.js'
import { userDataDir } from '../core/usage-log.js'
import type { AgentRole } from '../core/agents.js'
import type { ChatMessage, TurnUsage } from '../core/types.js'
import type { SessionView, TranscriptMessage, WorkspaceStatus, WorkspaceView } from '../ipc/contract.js'

/**
 * Sessions belong to folders. A workspace *is* a folder on disk, a session is
 * started inside one, and the folder is the session's root for the rest of its
 * life — that root is what the scope guard enforces (`src/core/scope.ts`).
 *
 * The index (which workspaces, which sessions, what they are called) is one
 * small JSON file; a transcript is a file per session, because transcripts grow
 * and the sidebar should not have to read any of them to draw itself.
 */

interface StoredWorkspace {
  id: string
  name: string
  root: string
}

interface StoredSession {
  id: string
  workspaceId: string
  title: string
  role: AgentRole
  createdAt: number
  updatedAt: number
  /** Every turn this session has ever run, added up. */
  usage?: TurnUsage
}

interface WorkspaceState {
  workspaces: StoredWorkspace[]
  sessions: StoredSession[]
}

export function workspacesPath(): string {
  return join(userDataDir(), 'workspaces.json')
}

function transcriptPath(id: string): string {
  return join(userDataDir(), 'sessions', `${id}.json`)
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Anything unreadable is treated as "nothing saved yet", never as a crash. */
export function parseState(parsed: unknown): WorkspaceState {
  const empty: WorkspaceState = { workspaces: [], sessions: [] }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const raw = parsed as { workspaces?: unknown; sessions?: unknown }

  const workspaces: StoredWorkspace[] = []
  if (Array.isArray(raw.workspaces)) {
    for (const entry of raw.workspaces) {
      if (typeof entry !== 'object' || entry === null) continue
      const { id, name, root } = entry as Record<string, unknown>
      const [i, n, r] = [str(id), str(name), str(root)]
      if (i !== null && n !== null && r !== null) workspaces.push({ id: i, name: n, root: r })
    }
  }

  const sessions: StoredSession[] = []
  if (Array.isArray(raw.sessions)) {
    for (const entry of raw.sessions) {
      if (typeof entry !== 'object' || entry === null) continue
      const { id, workspaceId, title, role, createdAt, updatedAt, usage } = entry as Record<string, unknown>
      const [i, w] = [str(id), str(workspaceId)]
      if (i === null || w === null) continue
      // A session whose workspace is gone would be unreachable in the sidebar.
      if (!workspaces.some(space => space.id === w)) continue
      const created = typeof createdAt === 'number' ? createdAt : Date.now()
      sessions.push({
        id: i,
        workspaceId: w,
        title: str(title) ?? 'New session',
        // Sessions written before roles existed are builders, which is what
        // they were talking to.
        role: isAgentRole(role) ? role : 'builder',
        createdAt: created,
        updatedAt: typeof updatedAt === 'number' ? updatedAt : created,
        // Sessions written before usage was stored have spent something the
        // file cannot say, so they start the count again rather than claim a
        // total that is not true.
        ...(isUsage(usage) ? { usage } : {}),
      })
    }
  }

  return { workspaces, sessions }
}

const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const

function isUsage(value: unknown): value is TurnUsage {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return USAGE_KEYS.every(key => typeof raw[key] === 'number')
}

async function readState(): Promise<WorkspaceState> {
  const text = await readFile(workspacesPath(), 'utf8').catch(() => null)
  if (text === null) return { workspaces: [], sessions: [] }
  try {
    return parseState(JSON.parse(text))
  } catch {
    return { workspaces: [], sessions: [] }
  }
}

async function writeState(state: WorkspaceState): Promise<void> {
  await mkdir(userDataDir(), { recursive: true })
  await writeFile(workspacesPath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/** The whole sidebar, newest session first inside each workspace. */
export async function workspaceStatus(): Promise<WorkspaceStatus> {
  const state = await readState()
  const sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  return { workspaces: state.workspaces, sessions }
}

/**
 * Adopt a folder. The same folder is never added twice — two entries pointing
 * at one directory would split its sessions across two sidebar groups for no
 * reason — so an existing one is returned instead.
 */
export async function addWorkspace(dir: string): Promise<WorkspaceView> {
  const root = await realResolve(dir)
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`${dir} is not a directory`)

  const state = await readState()
  const existing = state.workspaces.find(w => w.root === root)
  if (existing !== undefined) return existing

  const workspace: StoredWorkspace = { id: randomUUID(), name: basename(root) || root, root }
  state.workspaces.push(workspace)
  await writeState(state)
  return workspace
}

/** Drop a folder and everything opened inside it. Files on disk are untouched. */
export async function removeWorkspace(id: string): Promise<void> {
  const state = await readState()
  state.workspaces = state.workspaces.filter(w => w.id !== id)
  const orphans = state.sessions.filter(s => s.workspaceId === id)
  state.sessions = state.sessions.filter(s => s.workspaceId !== id)
  await writeState(state)
  for (const session of orphans) await rm(transcriptPath(session.id), { force: true })
}

export async function createSession(workspaceId: string): Promise<SessionView> {
  const state = await readState()
  if (!state.workspaces.some(w => w.id === workspaceId)) throw new Error('that folder is not in the sidebar any more')
  const now = Date.now()
  const session: StoredSession = { id: randomUUID(), workspaceId, title: 'New session', role: 'builder', createdAt: now, updatedAt: now }
  state.sessions.push(session)
  await writeState(state)
  return session
}

export async function deleteSession(id: string): Promise<void> {
  const state = await readState()
  state.sessions = state.sessions.filter(s => s.id !== id)
  await writeState(state)
  await rm(transcriptPath(id), { force: true })
}

/** Switch which agent a session talks to. The transcript is untouched. */
export async function setSessionRole(id: string, role: AgentRole): Promise<SessionView> {
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  if (session === undefined) throw new Error('that session is gone; start a new one from the sidebar')
  session.role = role
  await writeState(state)
  return session
}

/** What a session has spent so far, for seeding it when it is rebuilt. */
export async function sessionUsage(id: string): Promise<TurnUsage | null> {
  const state = await readState()
  return state.sessions.find(s => s.id === id)?.usage ?? null
}

/** Which agent a session is talking to, or null once the session is gone. */
export async function sessionRole(id: string): Promise<AgentRole | null> {
  const state = await readState()
  return state.sessions.find(s => s.id === id)?.role ?? null
}

/** The root a session is scoped to, or null once its workspace is gone. */
export async function sessionRoot(id: string): Promise<string | null> {
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  if (session === undefined) return null
  return state.workspaces.find(w => w.id === session.workspaceId)?.root ?? null
}

const TITLE_MAX = 60

/**
 * A session is named after the first thing asked of it, which is what the user
 * will recognise in the sidebar. Later messages only move it up the list.
 */
export async function noteTurn(id: string, firstText: string, usage?: TurnUsage): Promise<SessionView | null> {
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  if (session === undefined) return null
  session.updatedAt = Date.now()
  // The session's own running total, so re-opening it shows what it has cost
  // rather than starting the count at zero.
  if (usage !== undefined) session.usage = usage
  if (session.title === 'New session') {
    const line = firstText.trim().replace(/\s+/g, ' ')
    if (line !== '') session.title = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
  }
  await writeState(state)
  return session
}

export async function loadTranscript(id: string): Promise<ChatMessage[]> {
  const text = await readFile(transcriptPath(id), 'utf8').catch(() => null)
  if (text === null) return []
  try {
    const parsed: unknown = JSON.parse(text)
    const messages = (parsed as { messages?: unknown }).messages
    return Array.isArray(messages) ? (messages as ChatMessage[]) : []
  } catch {
    return []
  }
}

export async function saveTranscript(id: string, messages: ChatMessage[]): Promise<void> {
  const path = transcriptPath(id)
  await mkdir(join(userDataDir(), 'sessions'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ messages }, null, 2)}\n`, 'utf8')
}

/**
 * The transcript as the chat view wants it. Thinking is not stored — it is not
 * part of the conversation sent to the model — so a re-opened session shows the
 * messages and the tool calls, and no thinking blocks.
 */
export function toTranscriptView(messages: ChatMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        text: message.content,
        callId: message.toolCallId,
        ...(message.failed === true ? { failed: true } : {}),
      })
      continue
    }
    if (message.role === 'system') continue
    const view: TranscriptMessage = { role: message.role, text: message.content }
    // Only signed thinking survives a round trip, so only that is stored, and
    // a re-opened session shows exactly what the next request would send.
    const thought = (message.thinking ?? [])
      .map(block => (block.kind === 'thinking' ? block.text : ''))
      .filter(text => text !== '')
      .join('\n')
    if (thought !== '') view.thinking = thought
    const calls = message.toolCalls
    if (calls !== undefined && calls.length > 0) {
      view.tools = calls.map(call => ({ id: call.id, name: call.name, args: call.args }))
    }
    out.push(view)
  }
  return out
}
