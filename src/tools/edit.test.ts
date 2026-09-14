import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EDIT_TOOL } from './edit.js'
import { workspaceGate } from '../core/scope.js'
import type { ToolResult } from '../core/types.js'

/**
 * Targeted edits, run the way a session runs them. The tool saves the round
 * trip and the half-written file a patch through a `bash` heredoc costs. These
 * tests pin the behaviors the port from deepseek-harness keeps: the match is
 * literal, it must be unique unless asked otherwise, and the file goes back out
 * with the line endings it came in with.
 */

async function edit(root: string, args: Record<string, unknown>): Promise<ToolResult> {
  return EDIT_TOOL.run(args, { cwd: root, access: workspaceGate(root) })
}

async function fixture(content: string): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'nh-edit-'))
  const path = join(root, 'note.txt')
  await writeFile(path, content, 'utf8')
  return { root, path }
}

describe('edit', () => {
  it('replaces one occurrence and says what it did', async () => {
    const { root, path } = await fixture('const size = 1\nconsole.log(size)\n')

    const result = await edit(root, { path: 'note.txt', old_string: 'const size = 1', new_string: 'const size = 2' })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('1 replacement')
    expect(await readFile(path, 'utf8')).toBe('const size = 2\nconsole.log(size)\n')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a match that is not there, and says to copy the text exactly', async () => {
    const { root, path } = await fixture('one line\n')

    const result = await edit(root, { path: 'note.txt', old_string: 'another line', new_string: 'x' })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('not found')
    expect(await readFile(path, 'utf8')).toBe('one line\n')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses an ambiguous match unless replace_all is set', async () => {
    const { root, path } = await fixture('let a = 1;\nlet b = 1;\n')

    const refused = await edit(root, { path: 'note.txt', old_string: '= 1', new_string: '= 2' })
    expect(refused.ok).toBe(false)
    expect(refused.summary).toContain('matched 2 times')

    const all = await edit(root, { path: 'note.txt', old_string: '= 1', new_string: '= 2', replace_all: true })
    expect(all.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('let a = 2;\nlet b = 2;\n')
    await rm(root, { recursive: true, force: true })
  })

  it('matches through CRLF and writes the file back as CRLF', async () => {
    const { root, path } = await fixture('first\r\nsecond\r\n')

    // The model copies what `read` showed it, which is LF.
    const result = await edit(root, { path: 'note.txt', old_string: 'first\nsecond', new_string: 'first\nchanged' })

    expect(result.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('first\r\nchanged\r\n')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses to touch a binary file', async () => {
    const { root, path } = await fixture('before\u0000after')

    const result = await edit(root, { path: 'note.txt', old_string: 'before', new_string: 'x' })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('binary')
    expect(await readFile(path, 'utf8')).toBe('before\u0000after')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a file that is not valid UTF-8 instead of mangling the bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-edit-'))
    const path = join(root, 'note.txt')
    // A lone 0xff byte: valid in Latin-1, not in UTF-8. A lossy decode would
    // replace it with U+FFFD and write that back with a success message.
    const bytes = Buffer.from([0x68, 0xff, 0x69])
    await writeFile(path, bytes)

    const result = await edit(root, { path: 'note.txt', old_string: 'h', new_string: 'H' })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('UTF-8')
    expect(await readFile(path)).toEqual(bytes)
    await rm(root, { recursive: true, force: true })
  })

  it('refuses when old_string and new_string are the same', async () => {
    const { root, path } = await fixture('one line\n')

    const result = await edit(root, { path: 'note.txt', old_string: 'one line', new_string: 'one line' })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('must differ')
    expect(await readFile(path, 'utf8')).toBe('one line\n')
    await rm(root, { recursive: true, force: true })
  })

  it('says a directory is not a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-edit-'))
    await mkdir(join(root, 'folder'))

    const result = await edit(root, { path: 'folder', old_string: 'a', new_string: 'b' })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('not a regular file')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses a file that is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-edit-'))

    const result = await edit(root, { path: 'missing.txt', old_string: 'a', new_string: 'b' })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('no such file')
    await rm(root, { recursive: true, force: true })
  })
})
