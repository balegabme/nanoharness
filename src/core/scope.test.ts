import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadIndex } from './read-index.js'
import { nativePath, workspaceGate } from './scope.js'
import { READ_TOOL } from '../tools/read.js'

/**
 * The two spellings of one path. A Windows session runs its shell through Git
 * Bash, which prints `/c/project/file`, and the model writes what it just read
 * into the next `read` call. That has to open the file, not report it missing.
 *
 * Nothing here reads paths out of a command line. A shell command is a
 * program, and listing its paths means reading a script body, a sed address or
 * an HTML tag as somewhere on disk. A command is approved whole by the gate
 * that can ask, and refused by the one that cannot.
 */

const onWindows = process.platform === 'win32'

describe('a shell command with nobody to ask', () => {
  it('is refused by the default gate and never run unscreened', async () => {
    const gate = workspaceGate('C:\\blockchain\\nanoharness')
    const result = await gate.checkCommand('ls')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toContain('not run')
  })
})

describe('a path in the spelling the shell printed', () => {
  it('is the same path to a tool', () => {
    expect(nativePath('/c/blockchain/nanoharness/plan.md', 'win32')).toBe('C:/blockchain/nanoharness/plan.md')
    expect(nativePath('/d/data', 'win32')).toBe('D:/data')
    // A single-letter root and nothing else is still a drive.
    expect(nativePath('/c', 'win32')).toMatch(/^C:[\\/]$/)
  })

  it('leaves a real POSIX path alone, on either platform', () => {
    expect(nativePath('/usr/local/bin/node', 'win32')).toBe('/usr/local/bin/node')
    expect(nativePath('/home/me/project', 'win32')).toBe('/home/me/project')
    expect(nativePath('/c/blockchain/plan.md', 'linux')).toBe('/c/blockchain/plan.md')
  })
})

describe.runIf(onWindows)('read, given what Git Bash printed', () => {
  it('opens the file and never claims there is none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-scope-'))
    await writeFile(join(root, 'note.txt'), 'the file is here\n', 'utf8')
    const access = workspaceGate(root)

    // `/c/Users/…/nh-scope-x/note.txt`: the drive letter lowercased and the
    // colon gone, exactly as the shell writes it.
    const asShell = `/${root[0]?.toLowerCase() ?? 'c'}${root.slice(2).replace(/\\/g, '/')}/note.txt`
    const result = await READ_TOOL.run({ path: asShell }, { cwd: root, access, reads: new ReadIndex() })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('the file is here')
    await rm(root, { recursive: true, force: true })
  })

  it('still refuses that spelling when it points outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-scope-'))
    const access = workspaceGate(root)
    const result = await READ_TOOL.run({ path: '/c/Windows/System32/drivers/etc/hosts' }, { cwd: root, access, reads: new ReadIndex() })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('scoped to')
    await rm(root, { recursive: true, force: true })
  })
})
