// doc: docs/harness/overview.md
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { emptyUsage } from './types.js'
import type { TurnUsage } from './types.js'

export interface UsageRecord {
  v: number
  at: number
  sessionId: string
  turn: number
  model: string
  usage: TurnUsage
}

/**
 * Stamped on every line so a reader can tell which units the numbers are in:
 * the meaning of a field changes with the wire, and a line already on disk
 * cannot be repaired because it does not record which wire wrote it. A line
 * from any version but this one is therefore skipped rather than summed under
 * units it was not written in. The project is pre-1.0 and keeps no
 * compatibility path.
 */
export const USAGE_SCHEMA = 2

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

// The version is stamped here rather than by the caller, so a new call site
// cannot write an unversioned line.
export async function appendUsage(record: Omit<UsageRecord, 'v'>, path = usageLogPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify({ v: USAGE_SCHEMA, ...record })}\n`, 'utf8')
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
  const { v, at, sessionId, turn, model, usage } = value
  if (typeof v !== 'number') return null
  if (typeof at !== 'number' || typeof sessionId !== 'string' || typeof turn !== 'number') return null
  if (typeof model !== 'string' || !isObject(usage)) return null

  const parsed = emptyUsage()
  for (const key of USAGE_KEYS) {
    const n = usage[key]
    if (typeof n !== 'number') return null
    parsed[key] = n
  }
  return { v, at, sessionId, turn, model, usage: parsed }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
