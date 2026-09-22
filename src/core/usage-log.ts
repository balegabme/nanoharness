// doc: docs/harness/overview.md
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isAgentRole } from './agents.js'
import { emptyUsage } from './types.js'
import type { AgentRole } from './agents.js'
import type { TurnUsage } from './types.js'

/**
 * One completed turn, as the log keeps it.
 *
 * Everything the cost dashboard groups by is on the line: which folder, which
 * session, which agent, which model, and when. The names are not: a folder is
 * renamed and a session is deleted, and a log that copied the name would
 * disagree with the sidebar from then on. `usage-report.ts` resolves ids to
 * names at read time and says so where it cannot.
 */
export interface UsageRecord {
  v: number
  at: number
  sessionId: string
  /** The folder the session belongs to, so spend can be read per project. */
  workspaceId: string
  turn: number
  /** Which of the three agents ran the turn (plan §5). */
  role: AgentRole
  model: string
  usage: TurnUsage
  /** The subagents' share of `usage`. Inside it, never added to it. */
  subagent: TurnUsage
  /** The harness's own share of `usage`: approval checks and anything like them. */
  harness: TurnUsage
  /**
   * What the whole turn cost, at the prices the models carried while it ran.
   * `null` where the session's model carried none, which is the log saying the
   * tokens are known and the money is not.
   */
  costUsd: number | null
  /** The subagents' share of `costUsd`. */
  subagentCostUsd: number
  /**
   * The harness's share, priced at the model that answered and not at the one
   * the session is on. Recorded even when `costUsd` is null, because that call
   * was priced whether or not the conversation around it was.
   */
  harnessCostUsd: number
  /** Generating time over the turn's rounds, first chunk to last, tools excluded. */
  streamMs: number
}

/**
 * Stamped on every line so a reader can tell which units the numbers are in:
 * the meaning of a field changes with the wire, and a line already on disk
 * cannot be repaired because it does not record which wire wrote it. A line
 * from any version but this one is therefore skipped, never summed under units
 * it was not written in. The project is pre-1.0 and keeps no compatibility
 * path.
 */
export const USAGE_SCHEMA = 3

const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const

// Transcripts and usage never touch the repo (plan §16): they live in the OS
// user-data dir, resolved the same way with or without Electron so the `nh`
// CLI and the app read one file.
export function userDataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'nanoharness')
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'nanoharness')
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'nanoharness')
}

export function usageLogPath(env?: NodeJS.ProcessEnv, platform?: string): string {
  return join(userDataDir(env, platform), 'usage.jsonl')
}

// The version is stamped here and not by the caller, so a new call site cannot
// write an unversioned line.
export async function appendUsage(record: Omit<UsageRecord, 'v'>, path = usageLogPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify({ v: USAGE_SCHEMA, ...record })}\n`, 'utf8')
}

/**
 * Throw the log away. There is no undo and nothing keeps a copy: the file is
 * the record, so what this removes is gone. A log that was never written is
 * not an error to clear.
 */
export async function clearUsage(path = usageLogPath()): Promise<void> {
  await rm(path, { force: true })
}

export interface UsageLog {
  records: UsageRecord[]
  /** Lines that are not current records: another schema version, or unreadable. */
  skipped: number
}

/**
 * Only current-version records come back. Everything else lands in `skipped`:
 * summing two different meanings of `input` into one total produces a number
 * true under neither, and the cache hit rate it feeds would read about half of
 * what it should.
 */
export async function readUsage(path = usageLogPath()): Promise<UsageLog> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return { records: [], skipped: 0 }

  const records: UsageRecord[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const record = parseRecord(line)
    if (record === null || record.v !== USAGE_SCHEMA) skipped += 1
    else records.push(record)
  }
  return { records, skipped }
}

function parseRecord(line: string): UsageRecord | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(value)) return null
  const { v, at, sessionId, workspaceId, turn, role, model, streamMs } = value
  if (typeof v !== 'number') return null
  if (typeof at !== 'number' || typeof sessionId !== 'string' || typeof turn !== 'number') return null
  if (typeof workspaceId !== 'string' || !isAgentRole(role)) return null
  if (typeof model !== 'string' || typeof streamMs !== 'number' || !Number.isFinite(streamMs)) return null

  const usage = parseUsage(value.usage)
  const subagent = parseUsage(value.subagent)
  const harness = parseUsage(value.harness)
  if (usage === null || subagent === null || harness === null) return null

  // A cost of null is a reading (nobody priced the model), so it is told apart
  // from a field that is missing or is not a number at all.
  const costUsd = value.costUsd === null ? null : money(value.costUsd)
  const subagentCostUsd = money(value.subagentCostUsd)
  const harnessCostUsd = money(value.harnessCostUsd)
  if (costUsd === undefined || subagentCostUsd === undefined || harnessCostUsd === undefined) return null

  return {
    v,
    at,
    sessionId,
    workspaceId,
    turn,
    role,
    model,
    usage,
    subagent,
    harness,
    costUsd,
    subagentCostUsd,
    harnessCostUsd,
    streamMs,
  }
}

function parseUsage(value: unknown): TurnUsage | null {
  if (!isObject(value)) return null
  const parsed = emptyUsage()
  for (const key of USAGE_KEYS) {
    const n = value[key]
    if (typeof n !== 'number') return null
    parsed[key] = n
  }
  return parsed
}

/** A dollar figure as the log may carry it, or `undefined` for anything else. */
function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
