// doc: docs/harness/hooks.md
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hashText } from '../core/project-trust.js'
import type { ProjectFile } from '../core/project-trust.js'

/**
 * The points in a session where the user's own commands can run. The order is
 * the order they fire in over a session's life.
 */
const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** The events that are about one tool call, and so the only ones `match` applies to. */
const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse'])

/** A hook that gives no timeout gets a minute. One that asks for more than ten is refused. */
const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 600

/**
 * The longest command an entry may hold, in bytes. The command goes to bash
 * after `-c`, and Git Bash cuts a `-c` string at 8 KiB and runs the front half,
 * so a longer one is refused here, where the file can be named. A script that
 * long reads better as a file the command runs anyway.
 */
const MAX_COMMAND_BYTES = 8_000

export interface HookSpec {
  event: HookEvent
  /** A bash script, run from the workspace root. */
  command: string
  /** Tool events only: the tool names it runs for, matched whole. Every tool when absent. */
  match?: RegExp
  timeoutMs: number
  /** The file it came from, so a note about a hook that went wrong says where to look. */
  source: string
}

/** One `hooks.json`, read. A missing file is an empty one, with empty text. */
export interface HookFile extends ProjectFile {
  hooks: HookSpec[]
  /** Entries that were skipped, each with what is wrong with it. */
  problems: string[]
}

/**
 * Where hooks are configured: one file for every workspace, and one inside the
 * project. `NANOHARNESS_HOME` exists so a test can have a home directory of
 * its own, as it does for the MCP config.
 */
export function hookPaths(root: string, env: NodeJS.ProcessEnv = process.env): { global: string; project: string } {
  const home = env.NANOHARNESS_HOME ?? homedir()
  return { global: join(home, '.nanoharness', 'hooks.json'), project: join(root, '.nanoharness', 'hooks.json') }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one file's text. A broken entry is skipped with a problem and the rest
 * of the file still loads, so one typo does not switch off every hook a person
 * relies on.
 */
export function parseHooks(text: string, source: string): { hooks: HookSpec[]; problems: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { hooks: [], problems: [`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (!isObject(parsed)) return { hooks: [], problems: [`${source} must hold a JSON object keyed by event name`] }

  const hooks: HookSpec[] = []
  const problems: string[] = []
  for (const [key, entries] of Object.entries(parsed)) {
    const event = HOOK_EVENTS.find(one => one === key)
    if (event === undefined) {
      problems.push(`${source}: "${key}" is not an event; the events are ${HOOK_EVENTS.join(', ')}`)
      continue
    }
    if (!Array.isArray(entries)) {
      problems.push(`${source}: "${key}" must be a list of hooks`)
      continue
    }
    entries.forEach((entry: unknown, index) => {
      const where = `${source}: ${key}[${index}]`
      const spec = parseEntry(entry, event, source)
      if (typeof spec === 'string') problems.push(`${where} ${spec}`)
      else hooks.push(spec)
    })
  }
  return { hooks, problems }
}

/** One entry, or what is wrong with it. */
function parseEntry(entry: unknown, event: HookEvent, source: string): HookSpec | string {
  if (!isObject(entry)) return 'must be an object with a "command"'
  const { command, match, timeout } = entry
  if (typeof command !== 'string' || command.trim() === '') return 'has no "command"'
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
    return `has a "command" over ${MAX_COMMAND_BYTES} bytes; put the script in a file and have the command run it`
  }

  let pattern: RegExp | undefined
  if (match !== undefined) {
    if (!TOOL_EVENTS.has(event)) return `has a "match", which only ${[...TOOL_EVENTS].join(' and ')} take`
    if (typeof match !== 'string' || match === '') return 'has a "match" that is not a pattern'
    try {
      // Anchored, so `write` means the tool called `write` and not every tool
      // with the word in its name.
      pattern = new RegExp(`^(?:${match})$`)
    } catch {
      return `has a "match" that is not a valid regular expression: ${match}`
    }
  }

  let seconds = DEFAULT_TIMEOUT_S
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_S) {
      return `has a "timeout" that is not a number of seconds between 0 and ${MAX_TIMEOUT_S}`
    }
    seconds = timeout
  }

  return { event, command, ...(pattern === undefined ? {} : { match: pattern }), timeoutMs: seconds * 1000, source }
}

/** Read and parse one file. A file that is not there holds no hooks and no problems. */
export async function readHookFile(path: string): Promise<HookFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    const problems = missing ? [] : [`${path} could not be read: ${err instanceof Error ? err.message : String(err)}`]
    return { path, text: '', hash: '', hooks: [], problems }
  }
  return { path, text, hash: hashText(text), ...parseHooks(text, path) }
}
