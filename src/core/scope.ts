// doc: docs/harness/sessions.md
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * A session is invoked in a folder and may only touch that folder. The rule
 * lives here and not in each tool, since "is this path inside the root?" has
 * several wrong answers: `..` walks out, an absolute path ignores the root
 * entirely, and a symlink inside the root can point anywhere on disk. All
 * three are resolved before the comparison.
 *
 * This module resolves the paths a tool is handed. It does not read paths out
 * of a shell command: a parser for one reads a script body, a sed address or
 * an HTML close tag as a path. The shell runs from the session root and is not
 * screened.
 * `docs/harness/sessions.md` says what that costs.
 */

export type AccessCheck =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string }

/** The answer to the shell question, which is asked about a whole command. */
export type CommandCheck = { ok: true } | { ok: false; reason: string }

/** What a tool asks before it touches a path or runs a command. */
export interface AccessGate {
  /** The session root, for messages and for tools that need a cwd. */
  readonly root: string
  check(target: string, intent: AccessIntent): Promise<AccessCheck>
  /**
   * May this command run? Nothing here reads the command. The gate that can
   * ask a person shows them the command; the one that cannot answers for
   * itself.
   */
  checkCommand(command: string): Promise<CommandCheck>
}

/**
 * `read` and `write` are the two things a path argument can ask for. `run` is
 * the shell: it is handed a whole command, so it goes to `checkCommand` and
 * never to `check`.
 */
export type AccessIntent = 'read' | 'write' | 'run'

/** True when `abs` is `root` itself or sits somewhere below it. */
export function containedIn(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The real location of a path that may not exist yet. `realpath` fails on a
 * missing file, so walk up to the deepest ancestor that does exist, resolve
 * that, and re-append what was left. Without this a write to
 * `root/link-to-elsewhere/new.txt` would look contained.
 */
export async function realResolve(path: string): Promise<string> {
  const abs = resolve(path)
  const tail: string[] = []
  let cursor = abs
  for (;;) {
    const real = await realpath(cursor).catch(() => null)
    if (real !== null) return tail.length === 0 ? real : join(real, ...tail.reverse())
    const parent = dirname(cursor)
    // At the filesystem root there is nothing left to resolve.
    if (parent === cursor) return abs
    tail.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    cursor = parent
  }
}

/** Resolve `target` against `root` and say whether it stayed inside. */
export async function resolveUnder(root: string, target: string): Promise<{ path: string; inside: boolean }> {
  const realRoot = await realResolve(root)
  const path = await realResolve(resolve(realRoot, target))
  return { path, inside: containedIn(realRoot, path) }
}

/**
 * `~` is the shell's spelling of the home directory, and resolving it as a
 * relative path would put it *inside* the root, the opposite of the truth.
 */
export function expandHome(token: string): string {
  if (token !== '~' && !token.startsWith('~/') && !token.startsWith('~\\')) return token
  return join(homedir(), token.slice(1))
}

const MSYS_ABSOLUTE = /^\/([a-zA-Z])(\/|$)/

/**
 * Git Bash spells `C:\` as `/c/`, and an agent that has just run a shell
 * command writes the path it saw there into `read` a moment later. Taken
 * literally, `/c/project/file` resolves against the current drive as
 * `<drive>:\c\project\file`, a path that does not exist, reported as if the
 * file were missing. So a Windows session accepts both spellings.
 *
 * Only `/<letter>/…` is touched: `/usr/bin` has a two-letter first segment and
 * is left exactly as it was.
 */
export function nativePath(token: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return token
  const match = MSYS_ABSOLUTE.exec(token)
  const drive = match?.[1]
  if (drive === undefined) return token
  const rest = token.slice(2)
  return `${drive.toUpperCase()}:${rest === '' ? sep : rest}`
}

/** A path as written by a model, in the spelling this platform can resolve. */
export function normalizeTarget(token: string): string {
  return nativePath(expandHome(token))
}

export function outsideMessage(root: string, path: string, intent: AccessIntent): string {
  return `this session is scoped to ${root}, so it cannot ${intent} ${path}`
}

/**
 * The default gate: outside the root is a hard refusal with no way to ask. The
 * app supplies a gate that can prompt instead (`src/main/permission.ts`), and
 * this one is what every other caller gets.
 *
 * Commands are refused outright here: nothing screens a command to guess which
 * ones stay inside, and there is nobody to ask. A caller that wants a shell
 * passes a gate that can answer the question, the way the app does.
 */
export function workspaceGate(root: string): AccessGate {
  return {
    root,
    async check(target, intent) {
      const { path, inside } = await resolveUnder(root, normalizeTarget(target))
      return inside ? { ok: true, path } : { ok: false, path, reason: outsideMessage(root, path, intent) }
    },
    async checkCommand() {
      return {
        ok: false,
        reason: `this session has no gate that can approve a shell command, and a command is not screened, so it was not run`,
      }
    },
  }
}
