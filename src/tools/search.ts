// doc: docs/harness/tools.md
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { defineTool } from '../core/session.js'
import { ignoredBy, parseIgnore } from './ignore.js'
import { decodeText } from './text.js'
import type { Layer } from './ignore.js'
import type { ArgsParse } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

/** Never walked, whatever the project says. `.git` alone is bigger than most repos. */
const ALWAYS_SKIP = ['.git', '.hg', '.svn', 'node_modules']

export const MAX_FILES = 20_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_MATCHES = 200
const MAX_PATHS = 500
const MAX_MATCH_CHARS = 400

/**
 * How many files are read at once. Reading them one after another spends the
 * whole search waiting on the disk: measured over this repository, 2000 files
 * took 7.8 seconds in a row and 1.1 seconds sixty-four at a time.
 */
const READ_AT_ONCE = 64

/** How wide a walk goes, and where it stops. */
export type WalkOptions = { honorIgnores: boolean; limit?: number }

/**
 * What one walk came to. `ignored` counts the entries a `.gitignore` excluded
 * and `dropped` the lines of those files this harness could not read, so an
 * answer can say both rather than let either pass for "not there".
 */
export type Walked = { files: string[]; capped: boolean; ignored: number; dropped: number }

/**
 * Every file under `root`, in one pass.
 *
 * A `.gitignore` applies to its own directory and everything below it, so the
 * walk carries the ones it has passed and an ignored directory is dropped
 * before it is descended into. The file is spotted in the entries already
 * read, and opened only where there is one.
 *
 * Symlinks are not followed, in either kind. A link is the one entry that can
 * leave the workspace or point back at its own parent, and the walk has no way
 * to tell those two apart from the name.
 */
export async function walkFiles(root: string, { honorIgnores, limit = MAX_FILES }: WalkOptions): Promise<Walked> {
  const files: string[] = []
  let ignored = 0
  let dropped = 0
  const queue: { dir: string; layers: readonly Layer[] }[] = [{ dir: root, layers: [] }]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    const entries = await readdir(next.dir, { withFileTypes: true }).catch(() => null)
    if (entries === null) continue

    let layers = next.layers
    if (honorIgnores && entries.some(entry => entry.name === '.gitignore' && entry.isFile())) {
      const text = await readFile(join(next.dir, '.gitignore'), 'utf8').catch(() => null)
      if (text !== null) {
        const parsed = parseIgnore(text)
        dropped += parsed.dropped
        if (parsed.rules.length > 0) layers = [...layers, { dir: next.dir, rules: parsed.rules }]
      }
    }

    for (const entry of entries) {
      if (ALWAYS_SKIP.includes(entry.name) || entry.isSymbolicLink()) continue
      const full = join(next.dir, entry.name)
      if (honorIgnores && ignoredBy(layers, full, entry.isDirectory())) {
        ignored += 1
        continue
      }
      if (entry.isDirectory()) queue.push({ dir: full, layers })
      else if (entry.isFile()) {
        files.push(full)
        if (files.length >= limit) return { files, capped: true, ignored, dropped }
      }
    }
  }
  return { files, capped: false, ignored, dropped }
}

/**
 * Walks in progress, keyed by the directory they start from.
 *
 * Several searches in one message run at the same time over the same tree, and
 * without this each one walks it again. An entry lives only while its walk is
 * running, so nothing here is ever a stale answer: a search that starts after
 * one finishes walks again and sees whatever is on disk then.
 */
const walking = new Map<string, Promise<Walked>>()

export async function sharedWalk(dir: string, options: WalkOptions): Promise<Walked> {
  // A lean walk and a wide one over the same directory are different answers,
  // so the mode is part of the key.
  const key = `${dir}\u0000${options.honorIgnores ? 'lean' : 'wide'}`
  const running = walking.get(key)
  if (running !== undefined) return running
  const started = walkFiles(dir, options).finally(() => walking.delete(key))
  walking.set(key, started)
  return started
}

/**
 * The directory part of a pattern before its first wildcard. A pattern rooted
 * at `docs/harness` gives back `docs/harness`; one that opens with a wildcard
 * gives back the empty string.
 *
 * Nothing outside that directory can match, so it is where the walk starts. On
 * this repository that is the difference between reading twenty thousand files
 * and reading a hundred.
 */
export function literalPrefix(pattern: string): string {
  const plain: string[] = []
  for (const part of pattern.split('/').slice(0, -1)) {
    if (/[*?[\]{}]/.test(part)) break
    plain.push(part)
  }
  return plain.join('/')
}

/**
 * A glob as a regular expression. A doubled star crosses directories, a single
 * star and a `?` do not, and `{a,b}` is either. Anything else is matched
 * literally, so the dot in `*.ts` is a dot.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // A doubled star followed by a separator also matches nothing at all,
        // so a pattern that opens with one finds a file at the root.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*/)*'
          i += 2
          continue
        }
        out += '.*'
        i += 1
        continue
      }
      out += '[^/]*'
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '{') {
      const close = pattern.indexOf('}', i)
      if (close !== -1) {
        const parts = pattern.slice(i + 1, close).split(',')
        out += `(?:${parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
        i = close
        continue
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** The path a match is reported under: relative to the workspace, forward slashes. */
function label(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

/**
 * How `include` is matched. A pattern with no separator in it is matched
 * against the file's name alone, so `chat.ts` and `*.ts` find the file
 * wherever it sits; one with a separator is matched against the path below
 * whatever `path` named, or below the workspace root when it named nothing.
 */
export function includeFilter(pattern: string): (name: string) => boolean {
  const regex = globToRegExp(pattern)
  if (pattern.includes('/')) return name => regex.test(name)
  return name => regex.test(name.slice(name.lastIndexOf('/') + 1))
}

/** What a walk that stopped at the file cap says for itself. */
export function walkNote(capped: boolean): string {
  return capped ? `\n[the walk stopped at ${MAX_FILES} files and the rest was never looked at; set path or include to narrow it]` : ''
}

function failed(why: string): ToolResult {
  return { ok: false, summary: why, content: why, isError: true }
}

/**
 * What the walk left out, on an answer that found something. A search that hit
 * is not finished being explained: the file it wants may be the one a
 * `.gitignore` kept out of the walk.
 */
function excludedNote(walked: Walked, wide: boolean): string {
  const excluded =
    wide || walked.ignored === 0
      ? ''
      : `\n[${walked.ignored} path${walked.ignored === 1 ? '' : 's'} excluded by .gitignore; pass ignored: true to search those too]`
  const unread = walked.dropped === 0 ? '' : `\n[${walked.dropped} .gitignore line${walked.dropped === 1 ? '' : 's'} could not be read and ${walked.dropped === 1 ? 'was' : 'were'} not applied]`
  return `${excluded}${unread}`
}

/**
 * What the paths in an answer are counted from, when `path` named somewhere
 * below the workspace root.
 *
 * The pattern is written from the directory that was named and the answer is
 * written from the root, and a model that reads one as the other concludes the
 * directory holds another of the same name. `glob` over `nanoharness` answering
 * `nanoharness/README.md` is the case: without this line it reads as
 * `nanoharness/nanoharness/README.md`.
 */
function baseNote(root: string, base: string): string {
  const here = label(root, base)
  if (here === '' || here.startsWith('..')) return ''
  return `\n[paths are counted from the workspace root, in which the directory you named is ${here}]`
}

/**
 * Where the search did not look. An empty answer has to carry this, or "no
 * matches" reads as proof the code is not there when it only means the walk
 * was narrowed.
 */
function scopeNote(walked: Walked, wide: boolean): string {
  return `\n\n[not searched: ${ALWAYS_SKIP.join(', ')}]${excludedNote(walked, wide)}`
}

/**
 * Every matching line in one file, or null when the file is not searchable:
 * over the size cap, or bytes that are not text. The caller counts those, and
 * the answer says how many there were.
 */
async function scanFile(abs: string, regex: RegExp, name: string): Promise<string[] | null> {
  const size = (await stat(abs).catch(() => null))?.size ?? 0
  if (size > MAX_FILE_BYTES) return null
  const decoded = decodeText(await readFile(abs).catch(() => Buffer.alloc(0)))
  if ('error' in decoded) return null
  const hits: string[] = []
  const lines = decoded.text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    if (!regex.test(line)) continue
    const shown = line.length > MAX_MATCH_CHARS ? `${line.slice(0, MAX_MATCH_CHARS)}... [line truncated]` : line
    hits.push(`${name}:${i + 1}:${shown.trimEnd()}`)
    if (hits.length >= MAX_MATCHES) break
  }
  return hits
}

type GrepArgs = { pattern: string; path?: string; include?: string; ignored?: boolean }

function parseGrep(args: Record<string, unknown>): ArgsParse<GrepArgs> {
  if (typeof args.pattern !== 'string' || args.pattern === '') return { ok: false, error: 'pattern must be a non-empty string' }
  const out: GrepArgs = { pattern: args.pattern }
  if (args.path !== undefined) {
    if (typeof args.path !== 'string') return { ok: false, error: 'path must be a string' }
    out.path = args.path
  }
  if (args.include !== undefined) {
    if (typeof args.include !== 'string') return { ok: false, error: 'include must be a string' }
    out.include = args.include
  }
  if (args.ignored !== undefined) {
    if (typeof args.ignored !== 'boolean') return { ok: false, error: 'ignored must be a boolean' }
    out.ignored = args.ignored
  }
  return { ok: true, args: out }
}

export const GREP_TOOL = defineTool<GrepArgs>({
  // Searching changes nothing and starts no process, so a message that asks
  // for several searches runs them together (`executeTools` in session.ts).
  parallel: true,
  input: {
    name: 'grep',
    description:
      'Search file contents for a JavaScript regular expression. Returns path:line:text, capped at 200 matches. Skips .git, node_modules and whatever a .gitignore excludes; set ignored to search those too. Prefer this over a shell grep: it starts no process and several greps in one message run together. Setting include narrows the walk as well as the matches, so give it whenever you know the file type.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A JavaScript regular expression, matched against each line.' },
        path: { type: 'string', description: 'A directory to search under, or one file to search, and what include is written relative to. Defaults to the workspace root.' },
        include: { type: 'string', description: 'Only search files matching this glob. With no slash in it, it matches the file name at any depth, so *.ts is every TypeScript file; with a slash, it matches the path below path, or below the workspace root when path is not given.' },
        ignored: { type: 'boolean', description: 'Also search files excluded by a .gitignore, such as build output or a .env. Off by default, because those bury the real match. .git and node_modules are never searched either way; to read inside one, give its path.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  parse: parseGrep,
  async run({ pattern, path: rel, include, ignored = false }, { access }): Promise<ToolResult> {
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (err) {
      return failed(`grep: ${pattern} is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`)
    }
    const filter = include === undefined ? null : includeFilter(include)

    const allowed = await access.check(rel ?? '.', 'read')
    if (!allowed.ok) return { ...failed(allowed.reason), prevented: true }
    const base = allowed.path
    const info = await stat(base).catch(() => null)
    if (info === null) return failed(`grep: ${rel ?? '.'}: no such file or directory`)

    // Nothing outside the include's own directory can match it, so that is
    // where the walk starts rather than at the top of the searched tree. A
    // `path` naming one file is that file, with nothing to walk.
    const from = include === undefined ? base : resolve(base, literalPrefix(include))
    const empty: Walked = { files: [], capped: false, ignored: 0, dropped: 0 }
    const walked = !info.isDirectory() ? { ...empty, files: [base] } : await sharedWalk(from, { honorIgnores: !ignored })
    const targets = walked.files.filter(abs => filter === null || filter(label(base, abs)))

    const hits: string[] = []
    let files = 0
    let skipped = 0
    let capped = false
    for (let at = 0; at < targets.length && !capped; at += READ_AT_ONCE) {
      const batch = targets.slice(at, at + READ_AT_ONCE)
      const scanned = await Promise.all(batch.map(abs => scanFile(abs, regex, label(access.root, abs))))
      for (const found of scanned) {
        if (found === null) {
          skipped += 1
          continue
        }
        if (found.length === 0) continue
        files += 1
        for (const hit of found) {
          hits.push(hit)
          if (hits.length >= MAX_MATCHES) {
            capped = true
            break
          }
        }
        if (capped) break
      }
    }

    const note = skipped === 0 ? '' : `\n[${skipped} file${skipped === 1 ? '' : 's'} skipped: binary, or over ${MAX_FILE_BYTES / 1024 / 1024} MB]`
    const walkCut = walkNote(walked.capped)
    // A `path` naming one file is not a directory the answer is counted from.
    const where = info.isDirectory() ? baseNote(access.root, base) : ''
    if (hits.length === 0) {
      return { ok: true, summary: `no matches for ${pattern}`, content: `no matches for ${pattern}${walkCut}${note}${where}${scopeNote(walked, ignored)}` }
    }
    const cut = capped ? `\n[capped at ${MAX_MATCHES} matches; narrow the pattern or set include]` : ''
    return {
      ok: true,
      summary: `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`,
      content: `${hits.join('\n')}${cut}${walkCut}${note}${where}${excludedNote(walked, ignored)}`,
    }
  },
})

type GlobArgs = { pattern: string; path?: string; ignored?: boolean }

function parseGlob(args: Record<string, unknown>): ArgsParse<GlobArgs> {
  if (typeof args.pattern !== 'string' || args.pattern === '') return { ok: false, error: 'pattern must be a non-empty string' }
  const out: GlobArgs = { pattern: args.pattern }
  if (args.path !== undefined) {
    if (typeof args.path !== 'string') return { ok: false, error: 'path must be a string' }
    out.path = args.path
  }
  if (args.ignored !== undefined) {
    if (typeof args.ignored !== 'boolean') return { ok: false, error: 'ignored must be a boolean' }
    out.ignored = args.ignored
  }
  return { ok: true, args: out }
}

export const GLOB_TOOL = defineTool<GlobArgs>({
  parallel: true,
  input: {
    name: 'glob',
    description:
      'Find files by path pattern: a doubled star crosses directories, a single star and ? do not, and {a,b} is either. Returns paths in sorted order, capped at 500. Skips .git, node_modules and whatever a .gitignore excludes; set ignored to list those too.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A glob matched against the path below path, or below the workspace root when path is not given. A doubled star crosses directories, so **/*.test.ts finds them at any depth while *.ts finds only the files sitting directly in the directory.' },
        path: { type: 'string', description: 'Directory to search under, and what the pattern is written relative to. Defaults to the workspace root.' },
        ignored: { type: 'boolean', description: 'Also list files excluded by a .gitignore, such as build output or a .env. Off by default, because those bury the real file. .git and node_modules are never listed either way; to look inside one, give its path.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  parse: parseGlob,
  async run({ pattern, path: rel, ignored = false }, { access }): Promise<ToolResult> {
    const allowed = await access.check(rel ?? '.', 'read')
    if (!allowed.ok) return { ...failed(allowed.reason), prevented: true }
    const base = allowed.path
    const info = await stat(base).catch(() => null)
    if (info === null) return failed(`glob: ${rel ?? '.'}: no such directory`)
    if (!info.isDirectory()) return failed(`glob: ${rel ?? '.'}: not a directory`)

    const regex = globToRegExp(pattern)
    // The pattern is matched against the path below whatever `path` named, so
    // `*.ts` under one is every file directly in it. What comes back is still
    // workspace-relative, because that is the path `read` and `edit` take.
    const from = resolve(base, literalPrefix(pattern))
    const walked = await sharedWalk(from, { honorIgnores: !ignored })
    const names = walked.files.filter(abs => regex.test(label(base, abs))).map(abs => label(access.root, abs)).sort()

    const walkCut = walkNote(walked.capped)
    const where = baseNote(access.root, base)
    if (names.length === 0) {
      return { ok: true, summary: `no files match ${pattern}`, content: `no files match ${pattern}${walkCut}${where}${scopeNote(walked, ignored)}` }
    }
    const shown = names.slice(0, MAX_PATHS)
    const cut = names.length > MAX_PATHS ? `\n[${names.length} matches; showing the first ${MAX_PATHS}]` : ''
    return {
      ok: true,
      summary: `${names.length} file${names.length === 1 ? '' : 's'}`,
      content: `${shown.join('\n')}${cut}${walkCut}${where}${excludedNote(walked, ignored)}`,
    }
  },
})
