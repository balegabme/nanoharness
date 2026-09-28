import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSnippets } from './snippets.js'

const SHIPPED = fileURLToPath(new URL('../../snippets', import.meta.url))

const cleanup: string[] = []

afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nh-snippets-'))
  cleanup.push(dir)
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
  return dir
}

function snippet(fields: string, body: string): string {
  return `---\n${fields}\n---\n${body}\n`
}

describe('snippets', () => {
  it('loads every shipped snippet with a name, a description and a body', async () => {
    const loaded = await loadSnippets([{ dir: SHIPPED, source: 'built-in' }])

    expect(loaded.map(one => one.file).sort()).toEqual([
      'ask-questions.md',
      'delegate-exploration.md',
      'diagnose-report.md',
      'orchestrator-mode.md',
      'session-kickoff.md',
      'verify-not-assume.md',
    ])
    for (const one of loaded) {
      expect(one.description).not.toBe('')
      expect(one.body).not.toMatch(/^---/)
      expect(one.order).toBeLessThan(Number.MAX_SAFE_INTEGER)
    }
  })

  it('lets the user and then the project replace a snippet by file name, and sorts by order then name', async () => {
    const shipped = await folder({
      'kickoff.md': snippet('name: Kickoff\norder: 10', 'shipped kickoff'),
      'verify.md': snippet('name: Verify\nplacement: append\norder: 20', 'shipped verify'),
      'README.md': 'not a snippet',
    })
    const user = await folder({
      'kickoff.md': snippet('name: Kickoff\norder: 10', 'user kickoff'),
      'loose.md': 'no frontmatter at all',
    })
    const project = await folder({
      'verify.md': snippet('name: Verify here\nplacement: append\norder: 5', 'project verify'),
      'empty.md': snippet('name: Empty', ''),
      'notes.txt': 'not markdown',
    })

    const loaded = await loadSnippets([
      { dir: shipped, source: 'built-in' },
      { dir: user, source: 'user' },
      { dir: project, source: 'project' },
      { dir: join(project, 'missing'), source: 'project' },
    ])

    expect(loaded.map(one => [one.name, one.source, one.placement, one.body])).toEqual([
      ['Verify here', 'project', 'append', 'project verify'],
      ['Kickoff', 'user', 'prepend', 'user kickoff'],
      ['loose', 'user', 'prepend', 'no frontmatter at all'],
    ])
  })
})
