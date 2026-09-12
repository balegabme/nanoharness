// doc: docs/harness/sessions.md
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { isAgentRole } from '../core/agents.js'
import { realResolve } from '../core/scope.js'
import { userDataDir } from '../core/usage-log.js'
import type { AgentRole } from '../core/agents.js'
import type { JobState } from '../core/jobs.js'
import type { SpawnMode } from '../core/spawn.js'
import type { ChatMessage, SessionNote, TurnUsage } from '../core/types.js'
import type { SessionView, TranscriptMessage, WorkspaceStatus, WorkspaceView } from '../ipc/contract.js'

/**
 * Sessions belong to folders. A workspace *is* a folder on disk, a session is
 * started inside one, and the folder is the session's root for the rest of its
 * life, and that root is what the scope guard enforces (`src/core/scope.ts`).
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

const TITLE_MAX = 60

export function transcriptPath(id: string): string {
  return join(userDataDir(), 'sessions', `${id}.json`)
}

/**
 * Where a session's subagents keep their own conversations: one folder beside
 * the session's file, one file per subagent, named by the job id the tool
 * result quotes back to the model.
 *
 * A subagent is a second conversation, not a stretch of the first, so it is
 * stored as one. Folding its rounds into the parent's transcript would make
 * the parent's file unreadable and its replay wrong. Leaving it unwritten
 * leaves the only trace of a minute's work by another agent as the paragraph
 * it chose to end with.
 */
export function subagentDir(sessionId: string): string {
  return join(userDataDir(), 'sessions', sessionId, 'subagents')
}

export function subagentPath(sessionId: string, jobId: string): string {
  return join(subagentDir(sessionId), `${jobId}.json`)
}

/** One subagent as it is stored: the job's facts, and its whole conversation. */
export interface StoredSubagent {
  id: string
  /** The session whose turn started it. */
  sessionId: string
  role: AgentRole
  mode: SpawnMode
  task: string
  background: boolean
  state: JobState
  note: string
  usage: TurnUsage
  startedAt: number
  endedAt: number
  messages: ChatMessage[]
  notes: SessionNote[]
}

export async function saveSubagent(record: StoredSubagent): Promise<string> {
  const path = subagentPath(record.sessionId, record.id)
  await mkdir(subagentDir(record.sessionId), { recursive: true })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return path
}

/** A stored subagent, or null when this launch is the first to look for it. */
export async function loadSubagent(sessionId: string, jobId: string): Promise<StoredSubagent | null> {
  const text = await readFile(subagentPath(sessionId, jobId), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as StoredSubagent
    return typeof parsed.id === 'string' && Array.isArray(parsed.messages) ? parsed : null
  } catch {
    return null
  }
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
 * Adopt a folder. The same folder is never added twice, because two entries
 * pointing at one directory would split its sessions across two sidebar groups
 * for no reason, so an existing one is returned instead.
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
  for (const session of orphans) await forgetFiles(session.id)
}

/** A session's transcript and every subagent transcript underneath it. */
async function forgetFiles(id: string): Promise<void> {
  await rm(transcriptPath(id), { force: true })
  await rm(join(userDataDir(), 'sessions', id), { recursive: true, force: true })
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
  await forgetFiles(id)
}

/**
 * Rename a session. The auto-title is the first thing that was asked, which is
 * a good default and a bad name for a session that ran all afternoon. So the
 * name becomes the user's once they set one, and `noteTurn` stops overwriting
 * it the moment it stops saying "New session".
 */
export async function renameSession(id: string, title: string): Promise<SessionView> {
  const name = title.trim().replace(/\s+/g, ' ')
  if (name === '') throw new Error('a session needs a name')
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  if (session === undefined) throw new Error('that session is gone; start a new one from the sidebar')
  session.title = name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name
  await writeState(state)
  return session
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

/**
 * Write a session's running total without touching anything else about it.
 *
 * A background subagent finishes after the turn that started it, so its tokens
 * land on the parent's counter with no turn left to store them: without this
 * the window and the file disagree until the next message is sent.
 */
export async function setSessionUsage(id: string, usage: TurnUsage): Promise<void> {
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  if (session === undefined) return
  session.usage = usage
  await writeState(state)
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

async function readSession(id: string): Promise<{ messages: ChatMessage[]; notes: SessionNote[] }> {
  const text = await readFile(transcriptPath(id), 'utf8').catch(() => null)
  if (text === null) return { messages: [], notes: [] }
  try {
    const parsed = JSON.parse(text) as { messages?: unknown; notes?: unknown }
    return {
      messages: Array.isArray(parsed.messages) ? (parsed.messages as ChatMessage[]) : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter(isNote) : [],
    }
  } catch {
    return { messages: [], notes: [] }
  }
}

const NOTE_KINDS: readonly string[] = ['error', 'stopped', 'note']

/** A note from an older or a corrupt file is dropped rather than rendered raw. */
function isNote(value: unknown): value is SessionNote {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return typeof raw.kind === 'string' && NOTE_KINDS.includes(raw.kind) && typeof raw.text === 'string' && typeof raw.after === 'number'
}

export async function loadTranscript(id: string): Promise<ChatMessage[]> {
  return (await readSession(id)).messages
}

/** What the window showed that was not a message, for the session it belongs to. */
export async function loadNotes(id: string): Promise<SessionNote[]> {
  return (await readSession(id)).notes
}

/**
 * The stored session: the conversation, and the lines the window showed
 * alongside it. Both, because a file that holds only the messages re-opens as a
 * session where a stopped turn, a failed one and a finished one all look the
 * same.
 */
export async function saveTranscript(id: string, messages: ChatMessage[], notes: readonly SessionNote[] = []): Promise<void> {
  const path = transcriptPath(id)
  await mkdir(join(userDataDir(), 'sessions'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ messages, notes }, null, 2)}\n`, 'utf8')
}

/**
 * The transcript as the chat view wants it: the messages, their tool calls and
 * results, and the thinking the provider signed and handed back, which is the
 * only thinking stored, because it is the only kind the next request may send.
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
    // Signed or not, the thinking is what explains the turn, so a re-opened
    // session shows it. Whether it goes back on the wire is the provider's
    // business, not the transcript's.
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
