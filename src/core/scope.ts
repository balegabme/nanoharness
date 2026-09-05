// doc: docs/harness/sessions.md
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * A session is invoked in a folder and may only touch that folder. The rule is
 * enforced here rather than in each tool, because "is this path inside the
 * root?" is one question with several wrong answers: `..` walks out, an
 * absolute path ignores the root entirely, and a symlink inside the root can
 * point anywhere on disk. All three are resolved before the comparison.
 */

export type AccessCheck =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string }

/** What a tool asks before it touches a path. */
export interface AccessGate {
  /** The session root, for messages and for tools that need a cwd. */
  readonly root: string
  check(target: string, intent: AccessIntent): Promise<AccessCheck>
}

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
    // The filesystem root does not exist? Nothing more to resolve.
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
 * relative path would put it *inside* the root — the opposite of the truth.
 */
export function expandHome(token: string): string {
  if (token !== '~' && !token.startsWith('~/') && !token.startsWith('~\\')) return token
  return join(homedir(), token.slice(1))
}

export function outsideMessage(root: string, path: string, intent: AccessIntent): string {
  const verb = intent === 'run' ? 'run a command touching' : intent
  return `this session is scoped to ${root}, so it cannot ${verb} ${path}`
}

/**
 * The default gate: outside the root is a hard refusal with no way to ask. The
 * app supplies a gate that can prompt instead (`src/main/permission.ts`); this
 * one is what any other caller gets, because a session that silently reaches
 * the whole disk is the worse default.
 */
export function workspaceGate(root: string): AccessGate {
  return {
    root,
    async check(target, intent) {
      const { path, inside } = await resolveUnder(root, expandHome(target))
      return inside ? { ok: true, path } : { ok: false, path, reason: outsideMessage(root, path, intent) }
    },
  }
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/

/**
 * Paths a shell command appears to reach for. A command line is not a path
 * list, so this is a filter and not a parser: absolute paths, `~`, and
 * anything walking through `..` are the forms that can leave the root, and
 * each one found is checked like any other path. Quotes and separators are
 * stripped; a command that hides its target behind a variable is not caught,
 * which is why the ledger still wants a real sandbox here.
 */
export function suspectPaths(command: string): string[] {
  const out = new Set<string>()
  for (const raw of command.split(/[\s;|&()<>]+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, '')
    if (token === '') continue
    if (token.startsWith('~')) {
      out.add(token)
      continue
    }
    if (token.startsWith('/') || WINDOWS_ABSOLUTE.test(token)) {
      out.add(token)
      continue
    }
    if (token === '..' || token.startsWith('../') || token.startsWith('..\\') || /[\\/]\.\.(?:[\\/]|$)/.test(token)) {
      out.add(token)
    }
  }
  return [...out]
}
