import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASH_TOOL, GUARDED_BASH_TOOL } from './bash.js'
import { workspaceGate } from '../core/scope.js'
import type { AccessGate } from '../core/scope.js'
import type { ToolResult } from '../core/types.js'

/**
 * The shell, run the way a session runs it. The commands below are real: one
 * longer than the 8 KiB a `-c` string survives, and two whose text only looks
 * like a path. Approval is covered in `src/main/permission.test.ts`; these
 * suites run under a gate that has already said yes.
 */

/** A gate that approves everything, so these tests are about the shell alone. */
function openGate(root: string): AccessGate {
  return {
    root,
    check: async target => ({ ok: true, path: target }),
    checkCommand: async () => ({ ok: true }),
  }
}

async function bash(command: string, cwd: string): Promise<ToolResult> {
  return BASH_TOOL.run({ command }, { cwd, access: openGate(cwd) })
}

describe('a long command', () => {
  it('runs to its last line', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-bash-'))
    // 12 KB, past the 8 KiB a `-c` string survives: bash would read the cut
    // as an unterminated heredoc and write a half file.
    const filler = 'x'.repeat(12_000)
    const command = [`cat > big.txt <<'END'`, filler, 'END', 'wc -c < big.txt'].join('\n')

    const result = await bash(command, cwd)

    expect(result.summary).not.toContain('here-document')
    expect((await readFile(join(cwd, 'big.txt'), 'utf8')).trim()).toHaveLength(filler.length)
    await rm(cwd, { recursive: true, force: true })
  }, 30_000)
})

describe('a command whose text only looks like a path', () => {
  it('runs, because nothing reads the command line for paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-bash-'))

    // A sed address script and a JS comment: neither is a path, and neither
    // may raise a prompt.
    const sed = await bash(`printf 'a\\nfaces\\nsteering\\nb\\n' | sed -n '/faces/,/steering/p'`, cwd)
    const heredoc = ["cat > note.js <<'JS'", '// steering: heading must match velocity', 'JS', 'echo ran'].join('\n')
    const comment = await bash(heredoc, cwd)

    expect(sed.summary).toContain('faces')
    expect(sed.isError).toBeUndefined()
    expect(comment.summary).toContain('ran')
    await rm(cwd, { recursive: true, force: true })
  }, 30_000)
})

describe('a command the gate has not approved', () => {
  it('does not run, and says it did not', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-bash-'))
    // The default gate has nobody to ask, so it refuses every command rather
    // than let an unscreened shell run.
    const result = await BASH_TOOL.run({ command: 'echo hello > note.txt' }, { cwd, access: workspaceGate(cwd) })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('not run')
    await expect(readFile(join(cwd, 'note.txt'), 'utf8')).rejects.toThrow()
    await rm(cwd, { recursive: true, force: true })
  })

  it('is refused by the role guard before anyone is asked', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-bash-'))
    let asked = 0
    const gate: AccessGate = {
      root: cwd,
      check: async target => ({ ok: true, path: target }),
      checkCommand: async () => {
        asked += 1
        return { ok: true }
      },
    }
    // The planner's shell turns a write away on its own wording; putting a
    // modal in front of the user for a command the role cannot run would ask
    // them to decide something already decided.
    const result = await GUARDED_BASH_TOOL.run({ command: 'echo hello > note.txt' }, { cwd, access: gate })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('reads but does not write')
    expect(asked).toBe(0)
    await rm(cwd, { recursive: true, force: true })
  })
})
