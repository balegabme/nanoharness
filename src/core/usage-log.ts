// doc: docs/harness/overview.md
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { emptyUsage } from './types.js'
import type { TurnUsage } from './types.js'

export interface UsageRecord {
  at: number
  sessionId: string
  turn: number
  model: string
  usage: TurnUsage
}

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

export async function appendUsage(record: UsageRecord, path = usageLogPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export interface UsageLog {
  records: UsageRecord[]
  skipped: number
}

export async function readUsage(path = usageLogPath()): Promise<UsageLog> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return { records: [], skipped: 0 }

  const records: UsageRecord[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const record = parseRecord(line)
    if (record) records.push(record)
    else skipped += 1
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
  const { at, sessionId, turn, model, usage } = value
  if (typeof at !== 'number' || typeof sessionId !== 'string' || typeof turn !== 'number') return null
  if (typeof model !== 'string' || !isObject(usage)) return null

  const parsed = emptyUsage()
  for (const key of USAGE_KEYS) {
    const n = usage[key]
    if (typeof n !== 'number') return null
    parsed[key] = n
  }
  return { at, sessionId, turn, model, usage: parsed }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
