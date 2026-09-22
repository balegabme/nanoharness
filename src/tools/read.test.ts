import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_TOOL } from './read.js'
import { ReadIndex } from '../core/read-index.js'
import { workspaceGate } from '../core/scope.js'
import type { ToolContext } from '../core/session.js'

/**
 * What a read hands back. Two things the model depends on: every line carries
 * the number an edit will be described against, and asking twice for the same
 * unchanged lines returns a pointer to them instead of a second copy.
 */

async function fixture(content: string): Promise<{ root: string; path: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), 'nh-read-'))
  const path = join(root, 'note.txt')
  await writeFile(path, content, 'utf8')
  return { root, path, ctx: { cwd: root, access: workspaceGate(root), reads: new ReadIndex() } }
}

describe('read', () => {
  it('numbers the lines from one', async () => {
    const { root, ctx } = await fixture('alpha\nbeta\n')

    const result = await READ_TOOL.run({ path: 'note.txt' }, ctx)

    expect(result.ok).toBe(true)
    expect(result.content).toContain('1: alpha')
    expect(result.content).toContain('2: beta')
    await rm(root, { recursive: true, force: true })
  })

  it('numbers an offset read by its place in the file', async () => {
    const { root, ctx } = await fixture('a\nb\nc\nd\n')

    const result = await READ_TOOL.run({ path: 'note.txt', offset: 2, limit: 2 }, ctx)

    expect(result.content).toBe('3: c\n4: d')
    await rm(root, { recursive: true, force: true })
  })

  it('points at what it already sent instead of sending it twice', async () => {
    const { root, ctx } = await fixture('alpha\nbeta\n')

    await READ_TOOL.run({ path: 'note.txt' }, ctx)
    const again = await READ_TOOL.run({ path: 'note.txt' }, ctx)

    expect(again.ok).toBe(true)
    expect(again.content).toContain('unchanged since it was read')
    expect(again.content).not.toContain('alpha')
    await rm(root, { recursive: true, force: true })
  })

  it('points at the wider window when a narrower slice is asked for', async () => {
    const { root, ctx } = await fixture('a\nb\nc\nd\ne\n')

    await READ_TOOL.run({ path: 'note.txt' }, ctx)
    const slice = await READ_TOOL.run({ path: 'note.txt', offset: 1, limit: 2 }, ctx)

    expect(slice.content).toContain('unchanged since it was read')
    await rm(root, { recursive: true, force: true })
  })

  it('sends the lines again when the file has changed', async () => {
    const { root, path, ctx } = await fixture('alpha\nbeta\n')

    await READ_TOOL.run({ path: 'note.txt' }, ctx)
    await writeFile(path, 'alpha\nGAMMA\n', 'utf8')
    const again = await READ_TOOL.run({ path: 'note.txt' }, ctx)

    expect(again.content).toContain('2: GAMMA')
    await rm(root, { recursive: true, force: true })
  })

  it('sends lines it has not sent before', async () => {
    const { root, ctx } = await fixture('a\nb\nc\nd\ne\nf\n')

    await READ_TOOL.run({ path: 'note.txt', offset: 0, limit: 2 }, ctx)
    const rest = await READ_TOOL.run({ path: 'note.txt', offset: 2, limit: 2 }, ctx)

    expect(rest.content).toBe('3: c\n4: d')
    await rm(root, { recursive: true, force: true })
  })

  it('says how long the file is when the offset is past the end', async () => {
    const { root, ctx } = await fixture('a\nb\nc\n')

    const result = await READ_TOOL.run({ path: 'note.txt', offset: 900 }, ctx)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('past the end')
    expect(result.summary).toContain('4 lines')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a file that is not there', async () => {
    const { root, ctx } = await fixture('alpha\n')

    const result = await READ_TOOL.run({ path: 'missing.txt' }, ctx)

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('no such file')
    await rm(root, { recursive: true, force: true })
  })
})
