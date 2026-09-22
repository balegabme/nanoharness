import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WRITE_TOOL } from './write.js'
import { READ_TOOL } from './read.js'
import { ReadIndex } from '../core/read-index.js'
import { workspaceGate } from '../core/scope.js'
import type { ToolResult } from '../core/types.js'

/**
 * What a write hands back, which the model is billed for and the window draws.
 * The count in the first line has to match the diff under it: a file created
 * from nothing is every line added and nothing removed, and an overwrite is
 * measured against what it replaced.
 */

/**
 * The read-before-write gate has its own tests at the bottom. Everywhere else
 * the helper hands over a resumed index, which does not ask, so each of those
 * tests is about the diff it produces.
 */
async function write(root: string, args: Record<string, unknown>, reads = new ReadIndex(true)): Promise<ToolResult> {
  return WRITE_TOOL.run(args, { cwd: root, access: workspaceGate(root), reads })
}

describe('write', () => {
  it('reports a new file as additions only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-write-'))

    const result = await write(root, { path: 'note.txt', content: 'one\ntwo\n' })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('+2 −0')
    expect(result.content).toContain('@@ -0,0 +1,2 @@')
    expect(result.content).toContain('+one')
    // Nothing was on disk, so nothing can have been taken off it.
    expect(result.content).not.toMatch(/^-(?!--)/m)
    await rm(root, { recursive: true, force: true })
  })

  it('says so when the only change is the newline the file ends on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-write-'))
    await writeFile(join(root, 'note.txt'), 'one\ntwo\n', 'utf8')

    const result = await write(root, { path: 'note.txt', content: 'one\ntwo' })

    // No line changed, so there is no hunk to draw and the header says why.
    expect(result.content).toContain('trailing newline removed')
    await rm(root, { recursive: true, force: true })
  })

  it('diffs an overwrite against what was there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-write-'))
    await writeFile(join(root, 'note.txt'), 'one\ntwo\n', 'utf8')

    const result = await write(root, { path: 'note.txt', content: 'one\nTWO\n' })

    expect(result.summary).toContain('+1 −1')
    expect(result.content).toContain('-two')
    expect(result.content).toContain('+TWO')
    await rm(root, { recursive: true, force: true })
  })

  it('creates a file nobody read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-write-'))

    const result = await write(root, { path: 'note.txt', content: 'one\n' }, new ReadIndex())

    expect(result.ok).toBe(true)
    await rm(root, { recursive: true, force: true })
  })

  it('refuses to overwrite a file nobody read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-write-'))
    await writeFile(join(root, 'note.txt'), 'one\ntwo\n', 'utf8')

    const result = await write(root, { path: 'note.txt', content: 'gone\n' }, new ReadIndex())

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('has not been read')
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('one\ntwo\n')
    await rm(root, { recursive: true, force: true })
  })

  it('allows the overwrite once the file has been read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-write-'))
    await writeFile(join(root, 'note.txt'), 'one\ntwo\n', 'utf8')
    const ctx = { cwd: root, access: workspaceGate(root), reads: new ReadIndex() }

    await READ_TOOL.run({ path: 'note.txt' }, ctx)
    const result = await WRITE_TOOL.run({ path: 'note.txt', content: 'three\n' }, ctx)

    expect(result.ok).toBe(true)
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('three\n')
    await rm(root, { recursive: true, force: true })
  })
})
