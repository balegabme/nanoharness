// doc: docs/harness/sessions.md
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { isAgentRole } from '../core/agents.js'
import { realResolve } from '../core/scope.js'
import { userDataDir } from '../core/usage-log.js'
import { dataUrl, emptyUsage, isImageType } from '../core/types.js'
import type { AgentRole } from '../core/agents.js'
import type { JobState } from '../core/jobs.js'
import type { SpawnMode } from '../core/spawn.js'
import type { ChatMessage, CompactionRecord, ContextLedger, ImagePart, ImageType, SessionNote, ToolStats, TurnRate, TurnUsage } from '../core/types.js'
import type { UsageNames } from '../core/usage-report.js'
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
  /** The subagents' share of `usage`, so a re-opened session keeps the split. */
  subagentUsage?: TurnUsage
  /** The harness's own share of `usage`: approval checks and compaction summaries. */
  harnessUsage?: TurnUsage
  /** What that share cost, summed at the prices of the models that ran it. */
  harnessCostUsd?: number
  /**
   * The context as it stood when the session last stopped, so the meter has
   * something to show before the session is built again. The live session
   * measures its own from its first request.
   */
  context?: ContextLedger
  /** The last turn's rate, for the topbar of a re-opened session. */
  rate?: TurnRate
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
 * stored as one and never folded into the parent's rounds.
 */
export function subagentDir(sessionId: string): string {
  return join(userDataDir(), 'sessions', sessionId, 'subagents')
}

export function subagentPath(sessionId: string, jobId: string): string {
  return join(subagentDir(sessionId), `${jobId}.json`)
}

/**
 * Where a session's pictures are kept: one file each, beside its subagents,
 * named by the image's id. The transcript records which image went with which
 * message and leaves the bytes here, so the end of a turn does not rewrite
 * every picture the session has ever been sent.
 */
function imageDir(sessionId: string): string {
  return join(userDataDir(), 'sessions', sessionId, 'images')
}

const IMAGE_EXTENSIONS: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

function imagePath(sessionId: string, image: StoredImage): string {
  return join(imageDir(sessionId), `${image.id}.${IMAGE_EXTENSIONS[image.mediaType]}`)
}

/** An image as the transcript file records it. */
type StoredImage = Omit<ImagePart, 'data'>

/** The form `randomUUID` gives. An id names a file, so nothing else is let through. */
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * How many pictures one message may carry, and how large each may be. The
 * window shrinks a picture to well under the size limit before it sends it, so
 * the limits only stop a picture the user chose to send whole, or a caller
 * that is not the window, from filling the transcript folder.
 */
const IMAGES_PER_MESSAGE = 20
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** A picture's type and size, from a record that may be anything. */
function imageShape(raw: Record<string, unknown>): Omit<StoredImage, 'id'> | null {
  const { mediaType, width, height } = raw
  if (!isImageType(mediaType)) return null
  if (typeof width !== 'number' || typeof height !== 'number') return null
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null
  return { mediaType, width, height }
}

/**
 * The pictures the window sent with a message, each given an id. Anything
 * that is not a picture it could have sent is refused with the reason, and the
 * message is not sent.
 */
export function acceptImages(uploads: unknown): ImagePart[] {
  if (uploads === undefined) return []
  if (!Array.isArray(uploads)) throw new Error('the images did not arrive as a list')
  if (uploads.length > IMAGES_PER_MESSAGE) throw new Error(`one message can carry ${IMAGES_PER_MESSAGE} images at most`)
  return uploads.map((upload: unknown) => {
    if (typeof upload !== 'object' || upload === null) throw new Error('an image arrived without its fields')
    const raw = upload as Record<string, unknown>
    const shape = imageShape(raw)
    if (shape === null) throw new Error('an image arrived with a type or size that cannot be read')
    const data = raw.data
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('an image arrived without its bytes in base64')
    if ((data.length / 4) * 3 > IMAGE_MAX_BYTES) {
      throw new Error(`an image is over ${IMAGE_MAX_BYTES / 1024 / 1024} MB; turn on "Shrink images before sending" in Settings, under General`)
    }
    return { id: randomUUID(), ...shape, data }
  })
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
  /**
   * What its tool calls came to: how many, how many failed. Absent on a
   * subagent stored before the count existed, which is a line the window
   * leaves out instead of making up a zero.
   */
  tools?: ToolStats
  startedAt: number
  endedAt: number
  messages: ChatMessage[]
  notes: SessionNote[]
  /** Its context when it ended. Absent when the stored one cannot be read. */
  context?: ContextLedger
}

/**
 * Write one subagent down. A clone starts from its parent's conversation, so
 * its pictures are the parent's, and they go to the session's own picture
 * folder, where the parent's copy of each is already written.
 */
export async function saveSubagent(record: StoredSubagent): Promise<string> {
  const path = subagentPath(record.sessionId, record.id)
  await mkdir(subagentDir(record.sessionId), { recursive: true })
  const messages: object[] = []
  for (const message of record.messages) messages.push(await storeImages(record.sessionId, message))
  await writeFile(path, `${JSON.stringify({ ...record, messages }, null, 2)}\n`, 'utf8')
  return path
}

/** A stored subagent, or null when this launch is the first to look for it. */
export async function loadSubagent(sessionId: string, jobId: string): Promise<StoredSubagent | null> {
  const text = await readFile(subagentPath(sessionId, jobId), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as StoredSubagent
    if (typeof parsed.id !== 'string' || !Array.isArray(parsed.messages)) return null
    // A file may have no count at all, or three numbers that are not numbers.
    // The window draws whatever is here, so a field that is not three numbers
    // is dropped, and never handed on to be read as a count.
    if (!isToolStats(parsed.tools)) delete parsed.tools
    if (!isLedger(parsed.context)) delete parsed.context
    for (const message of parsed.messages) {
      if (message.role !== 'tool' && message.images !== undefined) await loadImages(sessionId, message)
    }
    return parsed
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
      const { id, workspaceId, title, role, createdAt, updatedAt, usage, subagentUsage, harnessUsage, harnessCostUsd, context, rate } = entry as Record<string, unknown>
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
        // file cannot say, so they start the count again and claim no total
        // that is not true.
        ...(isUsage(usage) ? { usage } : {}),
        ...(isUsage(subagentUsage) ? { subagentUsage } : {}),
        ...(isUsage(harnessUsage) ? { harnessUsage } : {}),
        ...(typeof harnessCostUsd === 'number' && Number.isFinite(harnessCostUsd) && harnessCostUsd >= 0 ? { harnessCostUsd } : {}),
        ...(isLedger(context) ? { context } : {}),
        ...(isRate(rate) ? { rate } : {}),
      })
    }
  }

  return { workspaces, sessions }
}

const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const

function isRate(value: unknown): value is TurnRate {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return isCount(raw.output) && isCount(raw.streamMs)
}

function isUsage(value: unknown): value is TurnUsage {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return USAGE_KEYS.every(key => typeof raw[key] === 'number')
}

const PART_KEYS = ['system', 'tools', 'user', 'assistant', 'thinking', 'toolResults', 'summary'] as const
const REASONS: readonly unknown[] = ['auto', 'manual', 'overflow']

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * A stored ledger is drawn as it is, so every field the meter reads has to be
 * the kind of value it expects. One that is not is dropped whole, and the meter
 * waits for the session to measure again.
 */
function isLedger(value: unknown): value is ContextLedger {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  const counts = [raw.tokens, raw.estimated, raw.reserve, raw.at].every(isCount)
  const optional = [raw.measured, raw.window, raw.limit, raw.room, raw.usable, raw.threshold].every(field => field === null || isCount(field))
  if (!counts || !optional || typeof raw.auto !== 'boolean') return false
  if (typeof raw.calibration !== 'number' || !(raw.calibration > 0) || typeof raw.model !== 'string') return false
  if (typeof raw.parts !== 'object' || raw.parts === null) return false
  const parts = raw.parts as Record<string, unknown>
  if (!PART_KEYS.every(key => isCount(parts[key]))) return false
  return Array.isArray(raw.compactions) && raw.compactions.every(isCompaction)
}

function isCompaction(value: unknown): value is CompactionRecord {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return REASONS.includes(raw.reason) && [raw.at, raw.before, raw.after].every(isCount)
}

function isToolStats(value: unknown): value is ToolStats {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  if (!['calls', 'ok', 'failed'].every(key => typeof raw[key] === 'number')) return false
  // A session stored before preventions were counted has the other three and not
  // this one. Zero is the honest answer: nothing was counted, so nothing is
  // claimed.
  if (typeof raw.prevented !== 'number') raw.prevented = 0
  return true
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
 * Adopt a folder. The same folder is never added twice: an existing entry is
 * returned instead.
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
  await rm(approvalLogPath(id), { force: true })
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
 * Rename a session. The auto-title is the first thing that was asked. Once the
 * user sets a name the name is theirs, and `noteTurn` stops overwriting it the
 * moment it stops saying "New session".
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

/** The context a session was left with, for the compactions and the calibration of the session rebuilt from it. */
export async function sessionContext(id: string): Promise<ContextLedger | null> {
  const state = await readState()
  return state.sessions.find(s => s.id === id)?.context ?? null
}

/** What a session has spent so far, for seeding it when it is rebuilt. */
export async function sessionUsage(id: string): Promise<SessionSpend | null> {
  const state = await readState()
  const stored = state.sessions.find(s => s.id === id)
  if (stored?.usage === undefined) return null
  // A session stored before a split was kept has a total and no breakdown of
  // it. Zero is the only honest answer: the tokens are in the total either way.
  return {
    total: stored.usage,
    subagents: stored.subagentUsage ?? emptyUsage(),
    harness: stored.harnessUsage ?? emptyUsage(),
    harnessCostUsd: stored.harnessCostUsd ?? 0,
  }
}

/** A session's running total and the two shares of it that are not the conversation. */
export interface SessionSpend {
  total: TurnUsage
  subagents: TurnUsage
  harness: TurnUsage
  harnessCostUsd: number
}

/** What the index keeps about a live session between launches. */
export interface SessionState {
  spend: SessionSpend
  context: ContextLedger
  /** Present after a turn. A write between turns leaves the stored rate as it was. */
  rate?: TurnRate
}

/**
 * Write a session's running total and its context without touching anything
 * else about it.
 *
 * A background subagent finishes after the turn that started it, so its tokens
 * land on the parent's counter with no turn left to store them, and a
 * compaction the user asked for runs between turns. Without this the window
 * and the file disagree until the next message is sent.
 */
export async function setSessionState(id: string, update: SessionState): Promise<SessionView | null> {
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  if (session === undefined) return null
  apply(session, update)
  await writeState(state)
  return session
}

function apply(session: StoredSession, update: SessionState): void {
  session.usage = update.spend.total
  session.subagentUsage = update.spend.subagents
  session.harnessUsage = update.spend.harness
  session.harnessCostUsd = update.spend.harnessCostUsd
  session.context = update.context
  if (update.rate !== undefined) session.rate = update.rate
}

/** Which agent a session is talking to, or null once the session is gone. */
export async function sessionRole(id: string): Promise<AgentRole | null> {
  const state = await readState()
  return state.sessions.find(s => s.id === id)?.role ?? null
}

/**
 * What a turn of this session has to be filed under: its folder and its agent.
 * Read before the turn runs, because a session deleted while it ran still
 * spent money and the index no longer knows whose it was.
 */
export async function sessionIdentity(id: string): Promise<{ workspaceId: string; role: AgentRole } | null> {
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  return session === undefined ? null : { workspaceId: session.workspaceId, role: session.role }
}

/**
 * What the folders and sessions are called right now, for the cost dashboard.
 * The usage log stores ids alone, so this is the other half of a row that says
 * a name; an id missing from here belonged to something since deleted.
 */
export async function usageNames(): Promise<UsageNames> {
  const state = await readState()
  const folders: Record<string, string> = {}
  const sessions: Record<string, string> = {}
  for (const workspace of state.workspaces) folders[workspace.id] = workspace.name
  for (const session of state.sessions) sessions[session.id] = session.title
  return { folders, sessions }
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
export async function noteTurn(id: string, firstText: string, update?: SessionState): Promise<SessionView | null> {
  const state = await readState()
  const session = state.sessions.find(s => s.id === id)
  if (session === undefined) return null
  session.updatedAt = Date.now()
  // The session's own running total and context, so re-opening it shows what
  // it has cost and how full it is, and does not start either at zero.
  if (update !== undefined) apply(session, update)
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

const NOTE_KINDS: readonly string[] = ['error', 'stopped', 'note', 'summary']

/** A note from an older or a corrupt file is dropped and never rendered raw. */
function isNote(value: unknown): value is SessionNote {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return typeof raw.kind === 'string' && NOTE_KINDS.includes(raw.kind) && typeof raw.text === 'string' && typeof raw.after === 'number'
}

export async function loadTranscript(id: string): Promise<ChatMessage[]> {
  const { messages } = await readSession(id)
  for (const message of messages) {
    if (message.role !== 'tool' && message.images !== undefined) await loadImages(id, message)
  }
  return messages
}

/**
 * Put each picture's bytes back on its message. A picture whose file is gone,
 * or whose record cannot be read, is dropped, and the message keeps its words.
 */
async function loadImages(sessionId: string, message: Exclude<ChatMessage, { role: 'tool' }>): Promise<void> {
  const kept: ImagePart[] = []
  for (const value of message.images as unknown[]) {
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    const shape = imageShape(raw)
    if (shape === null || typeof raw.id !== 'string' || !IMAGE_ID.test(raw.id)) continue
    const image = { id: raw.id, ...shape }
    const bytes = await readFile(imagePath(sessionId, image)).catch(() => null)
    if (bytes !== null) kept.push({ ...image, data: bytes.toString('base64') })
  }
  if (kept.length > 0) message.images = kept
  else delete message.images
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
  const stored: object[] = []
  for (const message of messages) stored.push(await storeImages(id, message))
  await writeFile(path, `${JSON.stringify({ messages: stored, notes }, null, 2)}\n`, 'utf8')
}

/**
 * A message as the transcript file holds it, with each picture's bytes written
 * to its own file. A picture is written once: its file is never changed after,
 * so one that already exists is left alone.
 */
async function storeImages(sessionId: string, message: ChatMessage): Promise<object> {
  if (message.role === 'tool' || message.images === undefined) return message
  await mkdir(imageDir(sessionId), { recursive: true })
  const images: StoredImage[] = []
  for (const { data, ...image } of message.images) {
    await writeFile(imagePath(sessionId, image), Buffer.from(data, 'base64'), { flag: 'wx' }).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    })
    images.push(image)
  }
  return { ...message, images }
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
        ...(message.compacted === undefined ? {} : { compacted: message.compacted }),
      })
      continue
    }
    if (message.role === 'system') continue
    const view: TranscriptMessage = { role: message.role, text: message.content }
    if (message.compacted !== undefined) view.compacted = message.compacted
    if (message.summary === true) view.summary = true
    if (message.hook === true) view.hook = true
    if (message.images !== undefined) view.images = message.images.map(image => ({ src: dataUrl(image), width: image.width, height: image.height }))
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

/**
 * Where a session's automatic permission decisions are written: one JSON line
 * per pass through the approval model, beside the transcript it belongs to.
 *
 * Append-only and separate from the transcript file on purpose. The transcript
 * is rewritten whole at the end of a turn and a decision happens in the middle
 * of one, so folding the two together would lose a crashed turn's record of
 * what it was allowed to do. Nothing draws this file; it exists to be read
 * afterwards.
 */
export function approvalLogPath(sessionId: string): string {
  return join(userDataDir(), 'sessions', `${sessionId}.approvals.jsonl`)
}

/** One decision as it is stored. `verdict` is absent when the judge could not answer. */
export interface StoredApproval {
  v: number
  at: number
  sessionId: string
  intent: string
  command?: string
  paths?: string[]
  verdict?: string
  rule?: string
  reason?: string
  model?: string
  ms?: number
  usage?: TurnUsage
  costUsd?: number
  problem?: string
}

export const APPROVAL_SCHEMA = 1

export async function appendApproval(record: Omit<StoredApproval, 'v'>): Promise<void> {
  await mkdir(join(userDataDir(), 'sessions'), { recursive: true })
  await appendFile(approvalLogPath(record.sessionId), `${JSON.stringify({ v: APPROVAL_SCHEMA, ...record })}\n`, 'utf8')
}
