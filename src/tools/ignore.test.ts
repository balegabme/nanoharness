import { describe, expect, it } from 'vitest'
import { ignoredBy, parseIgnore } from './ignore.js'
import type { Layer } from './ignore.js'

/**
 * Reading a `.gitignore` the way git does. These tests pin the four things a
 * walk depends on: what a pattern is matched against, which of a file's lines
 * wins, which file wins when two are in force, and what happens to a line this
 * parser will not read.
 */

function layer(dir: string, text: string): Layer {
  return { dir, rules: parseIgnore(text).rules }
}

const ROOT = '/repo'

function hides(text: string, path: string, isDir = false): boolean {
  return ignoredBy([layer(ROOT, text)], `${ROOT}/${path}`, isDir)
}

describe('what a pattern matches', () => {
  it('matches a plain name at any depth', () => {
    expect(hides('out', 'out')).toBe(true)
    expect(hides('out', 'src/deep/out')).toBe(true)
  })

  it('takes a trailing slash as a directory and nothing else', () => {
    expect(hides('out/', 'out', true)).toBe(true)
    expect(hides('out/', 'out')).toBe(false)
  })

  it('ties a leading slash to the file\'s own directory', () => {
    expect(hides('/release', 'release')).toBe(true)
    expect(hides('/release', 'src/release')).toBe(false)
  })

  it('ties an inner slash to the file\'s own directory too', () => {
    expect(hides('src/generated', 'src/generated')).toBe(true)
    expect(hides('src/generated', 'app/src/generated')).toBe(false)
  })

  it('stops a single star at a separator', () => {
    expect(hides('*.log', 'debug.log')).toBe(true)
    expect(hides('src/*.log', 'src/debug.log')).toBe(true)
    expect(hides('src/*.log', 'src/deep/debug.log')).toBe(false)
  })

  it('crosses directories with a doubled star, and also matches none', () => {
    expect(hides('src/**/fixtures', 'src/fixtures')).toBe(true)
    expect(hides('src/**/fixtures', 'src/a/b/fixtures')).toBe(true)
  })

  it('treats everything else literally', () => {
    expect(hides('a.b', 'a.b')).toBe(true)
    expect(hides('a.b', 'axb')).toBe(false)
  })
})

describe('which line wins', () => {
  it('lets a later line re-include what an earlier one excluded', () => {
    const text = ['.env.*', '!.env.example', ''].join('\n')

    expect(hides(text, '.env.local')).toBe(true)
    expect(hides(text, '.env.example')).toBe(false)
  })

  it('takes the last line that matches, not the first', () => {
    const text = ['!keep.log', '*.log', ''].join('\n')

    expect(hides(text, 'keep.log')).toBe(true)
  })
})

describe('which file wins', () => {
  const layers = [layer('/repo', 'vendor'), layer('/repo/src', '!vendor')]

  it('lets the closest .gitignore overrule the one above it', () => {
    expect(ignoredBy(layers, '/repo/src/vendor', true)).toBe(false)
    expect(ignoredBy(layers, '/repo/docs/vendor', true)).toBe(true)
  })

  it('leaves a path outside a layer\'s own directory to the others', () => {
    expect(ignoredBy([layer('/repo/src', 'vendor')], '/repo/docs/vendor', true)).toBe(false)
  })
})

describe('a line this parser will not read', () => {
  it('counts a character class instead of half-applying it', () => {
    const parsed = parseIgnore(['*.[oa]', 'out/', ''].join('\n'))

    expect(parsed.dropped).toBe(1)
    expect(parsed.rules).toHaveLength(1)
  })

  it('counts a backslash escape the same way', () => {
    const parsed = parseIgnore(['a\\#b', ''].join('\n'))

    expect(parsed.dropped).toBe(1)
    expect(parsed.rules).toHaveLength(0)
  })

  it('passes over blank lines and comments without counting them', () => {
    const parsed = parseIgnore(['', '# a comment', 'out', ''].join('\n'))

    expect(parsed.dropped).toBe(0)
    expect(parsed.rules).toHaveLength(1)
  })

  it('drops trailing whitespace, which git does not treat as part of a name', () => {
    expect(hides('out   ', 'out')).toBe(true)
  })
})
