import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GLOB_TOOL, GREP_TOOL, globToRegExp, literalPrefix, walkFiles, walkNote, MAX_FILES } from './search.js'
import { ReadIndex } from '../core/read-index.js'
import { workspaceGate } from '../core/scope.js'
import type { ToolResult } from '../core/types.js'

/**
 * Searching without a shell. These tests pin what the model is handed: the
 * `path:line:text` shape it reads matches back, which directories the walk
 * refuses to enter, and a bad pattern coming back as an error rather than as
 * an empty result that reads like an answer.
 */

function run(tool: typeof GREP_TOOL | typeof GLOB_TOOL, root: string, args: Record<string, unknown>): Promise<ToolResult> {
  return tool.run(args, { cwd: root, access: workspaceGate(root), reads: new ReadIndex() })
}

/** A small tree: two sources, a test, a nested one, and a dependency to skip. */
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nh-search-'))
  await mkdir(join(root, 'src', 'core'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export const answer = 42\n', 'utf8')
  await writeFile(join(root, 'src', 'index.test.ts'), 'answer\nexpect(answer).toBe(42)\n', 'utf8')
  await writeFile(join(root, 'src', 'core', 'deep.ts'), 'const answer = 1\n', 'utf8')
  await writeFile(join(root, 'readme.md'), 'the answer\n', 'utf8')
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'const answer = 0\n', 'utf8')
  return root
}

describe('grep', () => {
  it('reports every match as path, line and text', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer = 42' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('src/index.ts:1:export const answer = 42')
    await rm(root, { recursive: true, force: true })
  })

  it('never walks into node_modules', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer' })

    expect(result.content).not.toContain('left-pad')
    expect(result.content).toContain('readme.md')
    await rm(root, { recursive: true, force: true })
  })

  it('narrows to the files include names', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', include: 'src/**/*.ts' })

    expect(result.content).toContain('src/index.ts')
    expect(result.content).toContain('src/core/deep.ts')
    expect(result.content).not.toContain('readme.md')
    await rm(root, { recursive: true, force: true })
  })

  it('searches only under the directory it is given', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', path: 'src/core' })

    expect(result.content).toContain('src/core/deep.ts')
    expect(result.content).not.toContain('src/index.ts')
    await rm(root, { recursive: true, force: true })
  })

  it('says a pattern is broken rather than answering no matches', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'const (answer' })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('not a valid regular expression')
    await rm(root, { recursive: true, force: true })
  })

  it('says where it did not look when it finds nothing', async () => {
    const root = await tree()
    await writeFile(join(root, '.gitignore'), 'build\n', 'utf8')
    await mkdir(join(root, 'build'), { recursive: true })
    await writeFile(join(root, 'build', 'app.js'), 'const answer = 1\n', 'utf8')

    const result = await run(GREP_TOOL, root, { pattern: 'nowhere-at-all' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('no matches')
    expect(result.content).toContain('not searched: .git')
    expect(result.content).toContain('1 path excluded by .gitignore')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a directory outside the workspace', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', path: '..' })

    expect(result.ok).toBe(false)
    expect(result.prevented).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('searches one file when the path names one', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', path: 'readme.md' })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('readme.md:1:the answer')
    await rm(root, { recursive: true, force: true })
  })

  it('takes an include with no directory in it as a file name', async () => {
    const root = await tree()

    const named = await run(GREP_TOOL, root, { pattern: 'answer', include: 'deep.ts' })
    const starred = await run(GREP_TOOL, root, { pattern: 'answer', include: '*.md' })

    expect(named.content).toBe('src/core/deep.ts:1:const answer = 1')
    expect(starred.content).toBe('readme.md:1:the answer')
    await rm(root, { recursive: true, force: true })
  })

  it('says nothing about a cap when the walk finished', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer' })

    expect(result.content).not.toContain('the walk stopped')
    await rm(root, { recursive: true, force: true })
  })
})

/**
 * A walk that gives up partway has to say so. Answering "no matches" off a
 * truncated walk is the one failure a search cannot be allowed: it reads as
 * proof the code is not there.
 */
describe('the file cap', () => {
  it('stops at the limit and says it stopped', async () => {
    const root = await tree()

    const walked = await walkFiles(root, { honorIgnores: true, limit: 2 })

    expect(walked.files).toHaveLength(2)
    expect(walked.capped).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('finishes quietly when the tree fits', async () => {
    const root = await tree()

    const walked = await walkFiles(root, { honorIgnores: true, limit: 100 })

    expect(walked.capped).toBe(false)
    expect(walkNote(false)).toBe('')
    await rm(root, { recursive: true, force: true })
  })

  it('names the cap and what it means for the answer', () => {
    expect(walkNote(true)).toContain('the walk stopped at 20000 files')
    expect(walkNote(true)).toContain('never looked at')
  })

  it('searches what it walked and names the cap, over the real limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-capped-'))
    // The match goes in first, so a walk that stops early still has it. The
    // bug this pins answered "no matches" having read nothing at all.
    await writeFile(join(root, 'aa-target.txt'), 'the answer\n', 'utf8')
    for (let i = 0; i <= MAX_FILES; i += 500) {
      const batch = []
      for (let j = i; j < Math.min(i + 500, MAX_FILES + 1); j += 1) batch.push(writeFile(join(root, `f${j}.txt`), 'nothing here\n', 'utf8'))
      await Promise.all(batch)
    }

    const result = await run(GREP_TOOL, root, { pattern: 'answer' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('aa-target.txt:1:the answer')
    expect(result.content).toContain(`the walk stopped at ${MAX_FILES} files`)
    await rm(root, { recursive: true, force: true })
  }, 300_000)
})

describe('glob', () => {
  it('finds files across directories, sorted', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '**/*.ts' })

    expect(result.content).toBe(['src/core/deep.ts', 'src/index.test.ts', 'src/index.ts'].join('\n'))
    await rm(root, { recursive: true, force: true })
  })

  it('matches a single segment with one star', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: 'src/*.ts' })

    expect(result.content).not.toContain('core/deep.ts')
    expect(result.content).toContain('src/index.ts')
    await rm(root, { recursive: true, force: true })
  })

  it('says so when nothing matches', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '**/*.rs' })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('no files match')
    await rm(root, { recursive: true, force: true })
  })
})

describe('globToRegExp', () => {
  it('lets ** cross directories and * stop at one', () => {
    expect(globToRegExp('**/*.ts').test('src/core/a.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/core/a.ts')).toBe(false)
  })

  it('matches a file at the root with a leading **/', () => {
    expect(globToRegExp('**/*.ts').test('index.ts')).toBe(true)
  })

  it('takes either side of a brace', () => {
    const regex = globToRegExp('src/*.{ts,tsx}')
    expect(regex.test('src/a.ts')).toBe(true)
    expect(regex.test('src/a.tsx')).toBe(true)
    expect(regex.test('src/a.js')).toBe(false)
  })

  it('reads a dot as a dot', () => {
    expect(globToRegExp('*.ts').test('axts')).toBe(false)
  })

  it('matches exactly one character for ?', () => {
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true)
    expect(globToRegExp('a?.ts').test('abc.ts')).toBe(false)
  })
})

describe('literalPrefix', () => {
  it('takes the directories before the first wildcard', () => {
    expect(literalPrefix('src/**/*.ts')).toBe('src')
    expect(literalPrefix('docs/harness/*.md')).toBe('docs/harness')
    expect(literalPrefix('src/core/read-index.ts')).toBe('src/core')
  })

  it('gives nothing back when the pattern opens with a wildcard', () => {
    expect(literalPrefix('**/*.ts')).toBe('')
    expect(literalPrefix('*.md')).toBe('')
    expect(literalPrefix('{src,docs}/a.ts')).toBe('')
  })
})

/**
 * What a pattern is measured against when `path` narrows the search. The
 * argument names where to look, so a pattern under it is written from there.
 * A model that scopes with `path` and writes a bare pattern was getting an
 * empty answer, which reads like the files are not there.
 */
describe('a pattern under a path', () => {
  it('matches glob against the path below what was asked for', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '*.ts', path: 'src/core' })

    expect(result.summary).toBe('1 file')
    expect(result.content).toContain('src/core/deep.ts')
    await rm(root, { recursive: true, force: true })
  })

  it('lists what sits directly in a directory', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '*', path: 'src' })

    expect(result.content).toContain('src/index.ts')
    expect(result.content).toContain('src/index.test.ts')
    expect(result.content).not.toContain('src/core/deep.ts')
    await rm(root, { recursive: true, force: true })
  })

  it('answers glob from the workspace root when no path narrows it', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '**/*.ts' })

    expect(result.content).toContain('src/core/deep.ts')
    expect(result.content).toContain('src/index.ts')
    await rm(root, { recursive: true, force: true })
  })

  it('says what its paths are counted from when a path narrowed the search', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '*.ts', path: 'src/core' })

    expect(result.content).toContain('paths are counted from the workspace root')
    expect(result.content).toContain('the directory you named is src/core')
    await rm(root, { recursive: true, force: true })
  })

  it('says nothing about a base when the search started at the root', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '**/*.ts' })

    expect(result.content).not.toContain('paths are counted from')
    await rm(root, { recursive: true, force: true })
  })

  it('says nothing about a base when the path named one file', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', path: 'readme.md' })

    expect(result.content).not.toContain('paths are counted from')
    await rm(root, { recursive: true, force: true })
  })

  it('carries the base on an answer that found nothing, too', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'nowhere-at-all', path: 'src/core' })

    expect(result.content).toContain('the directory you named is src/core')
    await rm(root, { recursive: true, force: true })
  })

  it('matches a grep include with a separator against the same path', async () => {
    const root = await tree()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', path: 'src', include: 'core/*.ts' })

    expect(result.summary).toBe('1 match in 1 file')
    expect(result.content).toContain('src/core/deep.ts:1:')
    await rm(root, { recursive: true, force: true })
  })

  it('still reports a path relative to the workspace, not to the path given', async () => {
    const root = await tree()

    const result = await run(GLOB_TOOL, root, { pattern: '*.ts', path: 'src/core' })

    expect((result.content ?? '').split('\n')[0]).toBe('src/core/deep.ts')
    await rm(root, { recursive: true, force: true })
  })
})

describe('searches running at once', () => {
  it('share one walk and get the same answer', async () => {
    const root = await tree()

    const all = await Promise.all([
      run(GLOB_TOOL, root, { pattern: '**/*.ts' }),
      run(GLOB_TOOL, root, { pattern: '**/*.ts' }),
      run(GREP_TOOL, root, { pattern: 'answer' }),
    ])

    expect(all[0]?.content).toBe(all[1]?.content)
    expect(all[2]?.ok).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('narrowing by include finds what a full walk finds', async () => {
    const root = await tree()

    const wide = await run(GREP_TOOL, root, { pattern: 'answer' })
    const narrowed = await run(GREP_TOOL, root, { pattern: 'answer', include: 'src/**/*.ts' })

    for (const line of (narrowed.content ?? '').split('\n')) {
      expect(wide.content).toContain(line)
    }
    await rm(root, { recursive: true, force: true })
  })
})

/**
 * What the walk leaves out, and how a search says so. A `.gitignore` is the
 * project's own statement of what is not source, and honouring it is the
 * difference between a walk over a checkout and a walk over its build output
 * too.
 */
describe('what a walk excludes', () => {
  async function ignoring(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'nh-ignore-'))
    await writeFile(join(root, '.gitignore'), ['out/', '.env.*', '!.env.example', ''].join('\n'), 'utf8')
    await writeFile(join(root, 'app.ts'), 'const answer = 1\n', 'utf8')
    await writeFile(join(root, '.env.local'), 'const answer = 2\n', 'utf8')
    await writeFile(join(root, '.env.example'), 'const answer = 3\n', 'utf8')
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(join(root, 'out', 'app.js'), 'const answer = 4\n', 'utf8')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', '.gitignore'), ['vendor/', ''].join('\n'), 'utf8')
    await mkdir(join(root, 'src', 'vendor'), { recursive: true })
    await writeFile(join(root, 'src', 'vendor', 'lib.ts'), 'const answer = 5\n', 'utf8')
    await writeFile(join(root, 'src', 'own.ts'), 'const answer = 6\n', 'utf8')
    return root
  }

  it('leaves out what a .gitignore excludes, and keeps what it re-includes', async () => {
    const root = await ignoring()

    const result = await run(GREP_TOOL, root, { pattern: 'answer' })

    expect(result.content).toContain('app.ts:1:')
    expect(result.content).toContain('.env.example:1:')
    expect(result.content).toContain('src/own.ts:1:')
    expect(result.content).not.toContain('.env.local')
    expect(result.content).not.toContain('out/app.js')
    await rm(root, { recursive: true, force: true })
  })

  it('applies a .gitignore to its own subtree and no further', async () => {
    const root = await ignoring()

    const result = await run(GREP_TOOL, root, { pattern: 'answer' })

    expect(result.content).not.toContain('src/vendor/lib.ts')
    expect(result.content).toContain('src/own.ts:1:')
    await rm(root, { recursive: true, force: true })
  })

  it('searches the excluded files when it is asked to', async () => {
    const root = await ignoring()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', ignored: true })

    expect(result.content).toContain('.env.local:1:')
    expect(result.content).toContain('out/app.js:1:')
    expect(result.content).toContain('src/vendor/lib.ts:1:')
    await rm(root, { recursive: true, force: true })
  })

  it('names how many paths it left out, and the flag that gets them', async () => {
    const root = await ignoring()

    const result = await run(GREP_TOOL, root, { pattern: 'answer' })

    expect(result.content).toContain('excluded by .gitignore')
    expect(result.content).toContain('pass ignored: true')
    await rm(root, { recursive: true, force: true })
  })

  it('says nothing about exclusions when it was asked for everything', async () => {
    const root = await ignoring()

    const result = await run(GREP_TOOL, root, { pattern: 'answer', ignored: true })

    expect(result.content).not.toContain('excluded by .gitignore')
    await rm(root, { recursive: true, force: true })
  })

  it('lists an excluded file only when glob is asked to', async () => {
    const root = await ignoring()

    const lean = await run(GLOB_TOOL, root, { pattern: '**/*.js' })
    const wide = await run(GLOB_TOOL, root, { pattern: '**/*.js', ignored: true })

    expect(lean.content).not.toContain('out/app.js')
    expect(wide.content).toContain('out/app.js')
    await rm(root, { recursive: true, force: true })
  })

  it('does not hand a lean walk the answer to a wide one', async () => {
    const root = await ignoring()

    const [lean, wide] = await Promise.all([
      walkFiles(root, { honorIgnores: true }),
      walkFiles(root, { honorIgnores: false }),
    ])

    expect(wide.files.length).toBeGreaterThan(lean.files.length)
    expect(lean.ignored).toBeGreaterThan(0)
    expect(wide.ignored).toBe(0)
    await rm(root, { recursive: true, force: true })
  })

  it('counts a .gitignore line it could not read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-ignore-'))
    await writeFile(join(root, '.gitignore'), ['*.[oa]', 'out/', ''].join('\n'), 'utf8')
    await writeFile(join(root, 'app.ts'), 'const answer = 1\n', 'utf8')

    const result = await run(GREP_TOOL, root, { pattern: 'answer' })

    expect(result.content).toContain('1 .gitignore line could not be read')
    await rm(root, { recursive: true, force: true })
  })

  it('walks a project with no .gitignore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-ignore-'))
    await writeFile(join(root, 'app.ts'), 'const answer = 1\n', 'utf8')

    const walked = await walkFiles(root, { honorIgnores: true })

    expect(walked.files).toHaveLength(1)
    expect(walked.ignored).toBe(0)
    await rm(root, { recursive: true, force: true })
  })
})
