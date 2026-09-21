import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadIndex, versionOf } from './read-index.js'
import type { FileVersion } from './read-index.js'

/**
 * What the session already has. The index answers two questions, and the tests
 * are in two halves: whether a span of a file is in the conversation already,
 * and whether a tool may rewrite a file it is holding a view of.
 */

const v1: FileVersion = { mtimeMs: 1000, size: 40 }
const v2: FileVersion = { mtimeMs: 2000, size: 41 }

describe('read index, serving a span', () => {
  it('serves a span nobody has asked for', () => {
    const reads = new ReadIndex()

    expect(reads.plan('/a.ts', { start: 0, end: 20 }, v1).kind).toBe('serve')
  })

  it('knows a span it has already served', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 20 }, v1)

    expect(reads.plan('/a.ts', { start: 0, end: 20 }, v1).kind).toBe('known')
  })

  it('knows a span held inside a wider one', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 100 }, v1)

    expect(reads.plan('/a.ts', { start: 40, end: 60 }, v1).kind).toBe('known')
  })

  it('serves a span that runs past what it holds', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 50 }, v1)

    // Lines 51 to 80 have never been served, so overlapping is not enough.
    expect(reads.plan('/a.ts', { start: 40, end: 80 }, v1).kind).toBe('serve')
  })

  it('serves again when the file has changed', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 100 }, v1)

    expect(reads.plan('/a.ts', { start: 0, end: 100 }, v2).kind).toBe('serve')
  })

  it('drops the spans it held when the version moves', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 100 }, v1)
    reads.served('/a.ts', { start: 0, end: 10 }, v2)

    const plan = reads.plan('/a.ts', { start: 0, end: 10 }, v2)
    expect(plan.kind === 'known' && plan.spans).toEqual([{ start: 0, end: 10 }])
  })

  it('names the lines it is pointing at, counting from one', () => {
    const said = ReadIndex.knownText('src/a.ts', [{ start: 0, end: 40 }])

    expect(said).toContain('src/a.ts')
    expect(said).toContain('line 1-40')
  })
})

describe('read index, allowing a write', () => {
  it('allows a file that is not there yet', () => {
    const reads = new ReadIndex()

    expect(reads.mayWrite('/a.ts', null, 'write: a.ts:')).toEqual({ ok: true })
  })

  it('refuses a file nobody read', () => {
    const reads = new ReadIndex()

    const plan = reads.mayWrite('/a.ts', v1, 'write: a.ts:')
    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain('has not been read')
  })

  it('allows a file at the version it was read at', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 20 }, v1)

    expect(reads.mayWrite('/a.ts', v1, 'write: a.ts:')).toEqual({ ok: true })
  })

  it('refuses a file that moved since it was read', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 20 }, v1)

    const plan = reads.mayWrite('/a.ts', v2, 'write: a.ts:')
    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain('has changed on disk')
  })

  it('does not make a session read back what it just wrote', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 20 }, v1)
    reads.wrote('/a.ts', v2)

    expect(reads.mayWrite('/a.ts', v2, 'write: a.ts:')).toEqual({ ok: true })
    // The new content is on disk and in nobody's context, so the next read
    // has to go and fetch it.
    expect(reads.plan('/a.ts', { start: 0, end: 20 }, v2).kind).toBe('serve')
  })

  it('forgets a file that went away', () => {
    const reads = new ReadIndex()
    reads.served('/a.ts', { start: 0, end: 20 }, v1)
    reads.forget('/a.ts')

    expect(reads.plan('/a.ts', { start: 0, end: 20 }, v1).kind).toBe('serve')
  })

  it('lets a resumed session write a file it has no record of', () => {
    const reads = new ReadIndex(true)

    expect(reads.mayWrite('/a.ts', v1, 'write: a.ts:')).toEqual({ ok: true })
  })

  it('still holds a resumed session to a file it read after the resume', () => {
    const reads = new ReadIndex(true)
    reads.served('/a.ts', { start: 0, end: 20 }, v1)

    expect(reads.mayWrite('/a.ts', v2, 'write: a.ts:').ok).toBe(false)
  })
})

describe('versionOf', () => {
  it('reads a file as time and size, and a missing file as null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-index-'))
    const path = join(root, 'note.txt')
    await writeFile(path, 'one\n', 'utf8')

    const found = await versionOf(path)
    expect(found?.size).toBe(4)
    expect(typeof found?.mtimeMs).toBe('number')
    expect(await versionOf(join(root, 'missing.txt'))).toBeNull()
    // A directory is not a file, and nothing writes one through these tools.
    expect(await versionOf(root)).toBeNull()

    await rm(root, { recursive: true, force: true })
  })
})
