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

/** The answer for a whole set of paths, which is one question to a person. */
export type AccessBatch = { ok: true } | { ok: false; reason: string }

/** What a tool asks before it touches a path. */
export interface AccessGate {
  /** The session root, for messages and for tools that need a cwd. */
  readonly root: string
  check(target: string, intent: AccessIntent): Promise<AccessCheck>
  /**
   * Every path one command reaches for, in a single question. A command line
   * routinely names three or four paths, and asking about each in turn is how a
   * person ends up clicking through a stack of modals for one command.
   */
  checkAll(targets: readonly string[], intent: AccessIntent): Promise<AccessBatch>
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
 * relative path would put it *inside* the root, the opposite of the truth.
 */
export function expandHome(token: string): string {
  if (token !== '~' && !token.startsWith('~/') && !token.startsWith('~\\')) return token
  return join(homedir(), token.slice(1))
}

const MSYS_ABSOLUTE = /^\/([a-zA-Z])(\/|$)/

/**
 * Git Bash spells `C:\` as `/c/`, and an agent that has just run a shell
 * command writes the path it saw there into `read` a moment later. Resolved as
 * given, `/c/project/file` becomes `<drive>:\c\project\file`, a path that does
 * not exist, reported as if the file were missing. So a Windows session accepts
 * both spellings and the tools stop disagreeing with the shell.
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
  const gate: AccessGate = {
    root,
    async check(target, intent) {
      const { path, inside } = await resolveUnder(root, normalizeTarget(target))
      return inside ? { ok: true, path } : { ok: false, path, reason: outsideMessage(root, path, intent) }
    },
    async checkAll(targets, intent) {
      for (const target of targets) {
        const result = await gate.check(target, intent)
        if (!result.ok) return { ok: false, reason: result.reason }
      }
      return { ok: true }
    },
  }
  return gate
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/

/**
 * Shell plumbing that looks like an absolute path and is not one. `2>/dev/null`
 * is on half the commands a model writes, and asking a person whether the agent
 * may access /dev/null is how a permission prompt stops being read.
 */
function isDeviceNode(token: string): boolean {
  return token === '/dev' || token.startsWith('/dev/') || token.toUpperCase() === 'NUL'
}

const WORD_BREAK = /[\s;|&()<>]/

/** The escapes bash honours inside double quotes. A `\b` stays a `\b`. */
const DOUBLE_QUOTE_ESCAPES = '$`"\\\n'

/**
 * A command line, split the way the shell splits it. Quoting is the whole
 * point: a `node -e "…"` script body is one word rather than forty, and a path
 * with a space in it is one word rather than two halves of nothing.
 *
 * Only what this file needs is modelled: word breaks, the two quote styles,
 * and the escapes above, so that `"C:\project\src"` keeps its separators.
 */
function shellWords(command: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: "'" | '"' | null = null
  let started = false
  const push = (): void => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? ''
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else if (quote === '"' && ch === '\\' && DOUBLE_QUOTE_ESCAPES.includes(command[i + 1] ?? '')) {
        i += 1
        word += command[i]
        started = true
      } else {
        word += ch
        started = true
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (WORD_BREAK.test(ch)) {
      push()
    } else {
      word += ch
      started = true
    }
  }
  push()
  return words
}

/**
 * Characters a path we would ask about does not carry. A word holding one is
 * code, whether a script body, a JSON payload or a shell assignment, and
 * reading it as a path is how the `.exec(s)` at the end of a regex literal
 * became a question about `C:\.exec`. Spaces are deliberately not on this
 * list: `C:\Program
 * Files` is a path, and quoting has already kept it in one piece.
 */
const NOT_IN_PATH = /[;=$*?<>|"'`\n]/

/** A URL is not a local path, and its `/` segments must not read as one. */
const URL_LIKE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`]+/g

/**
 * A path named inside a word that is otherwise code. Only shapes with no
 * second reading count: a drive letter, or two or more `/` segments whose
 * first does not begin with a dot. One segment is not enough, since that is
 * what a regex literal looks like, and a leading dot is the tail of something
 * joined to a base the code computed (`homedir() + '/.nanoharness/mcp.json'`),
 * where naming the fragment as an absolute path would point the question at a
 * file that does not exist.
 */
const EMBEDDED = [/[a-zA-Z]:[\\/][^\s'"`;=$*?<>|,]+/g, /(?<![\w.~-])(?:~|\/[\w$-][\w.$-]*)(?:\/[\w.$-]+)+/g]

/**
 * Paths a shell command appears to reach for. A command line is not a path
 * list, so this is a filter and not a parser: absolute paths, `~`, and
 * anything walking through `..` are the forms that can leave the root, and
 * each one found is checked like any other path.
 *
 * The words are the shell's words, so a quoted script body stays whole rather
 * than being sliced into fragments that only look like paths. Such a word is
 * searched for the two shapes that can be nothing else, and nothing is made of
 * the rest: a path assembled at runtime out of variables is not caught, which
 * is why the ledger still wants a real sandbox here.
 */
export function suspectPaths(command: string): string[] {
  const out = new Set<string>()
  for (const token of shellWords(command.replace(URL_LIKE, ' '))) {
    if (token === '' || isDeviceNode(token)) continue
    if (NOT_IN_PATH.test(token)) {
      for (const shape of EMBEDDED) {
        shape.lastIndex = 0
        for (let match = shape.exec(token); match !== null; match = shape.exec(token)) out.add(match[0])
      }
      continue
    }
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
