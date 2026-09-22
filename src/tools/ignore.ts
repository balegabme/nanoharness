// doc: docs/harness/tools.md
import { relative, sep } from 'node:path'

/**
 * One line of a `.gitignore`, as something a walk can test an entry against.
 *
 * `anchored` decides what the pattern is matched against: the path relative to
 * the file's own directory, or the entry's name alone at any depth under it.
 */
type Rule = {
  regex: RegExp
  negated: boolean
  dirOnly: boolean
  anchored: boolean
}

/** One `.gitignore`, with the directory its rules are written relative to. */
export type Layer = { dir: string; rules: readonly Rule[] }

/** What a file came to: the rules it yielded, and how many lines it did not. */
export type ParsedIgnore = { rules: Rule[]; dropped: number }

/**
 * A `.gitignore` pattern as a regular expression. A doubled star crosses
 * directories, a single star and a `?` stop at a separator, and everything
 * else is literal. Braces are not part of the syntax here, unlike a shell
 * glob.
 */
function patternToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string
    if (char === '*') {
      if (pattern[i + 1] === '*') {
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
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/**
 * The rules one `.gitignore` holds, in the order they were written.
 *
 * A line holding a character class or a backslash escape is counted in
 * `dropped` and never applied. Half-reading a pattern language is how a search
 * misses a directory, or walks one it was told to skip, so the count goes into
 * the answer.
 */
export function parseIgnore(text: string): ParsedIgnore {
  const rules: Rule[] = []
  let dropped = 0
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    if (line.includes('\\') || line.includes('[')) {
      dropped += 1
      continue
    }
    const negated = line.startsWith('!')
    let body = negated ? line.slice(1) : line
    const dirOnly = body.endsWith('/')
    if (dirOnly) body = body.slice(0, -1)
    // A slash anywhere but the end ties the pattern to this file's own
    // directory. Without one it matches a name at any depth below it.
    const anchored = body.includes('/')
    if (body.startsWith('/')) body = body.slice(1)
    if (body === '') {
      dropped += 1
      continue
    }
    rules.push({ regex: patternToRegExp(body), negated, dirOnly, anchored })
  }
  return { rules, dropped }
}

/**
 * Whether the layers in force exclude this path.
 *
 * The closest `.gitignore` decides, and within one file the last line that
 * matches decides, so a `!` line re-includes what an earlier line excluded.
 * That is what keeps `.env.*` from hiding a committed `.env.example`.
 */
export function ignoredBy(layers: readonly Layer[], abs: string, isDir: boolean): boolean {
  for (let at = layers.length - 1; at >= 0; at -= 1) {
    const layer = layers[at] as Layer
    const rel = relative(layer.dir, abs).split(sep).join('/')
    if (rel === '' || rel.startsWith('..')) continue
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    for (let r = layer.rules.length - 1; r >= 0; r -= 1) {
      const rule = layer.rules[r] as Rule
      if (rule.dirOnly && !isDir) continue
      if (!rule.regex.test(rule.anchored ? rel : name)) continue
      return !rule.negated
    }
  }
  return false
}
