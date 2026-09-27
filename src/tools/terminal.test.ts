import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminals, TERMINAL_TOOL } from './terminal.js'
import { ReadIndex } from '../core/read-index.js'
import type { AccessGate } from '../core/scope.js'
import type { ToolResult } from '../core/types.js'

/**
 * Background shells driven the way a session drives them: started, written
 * to, read from and stopped across separate calls. The commands are real bash.
 */

function openGate(root: string, seen: string[] = []): AccessGate {
  return {
    root,
    check: async target => ({ ok: true, path: target }),
    checkCommand: async command => {
      seen.push(command)
      return { ok: true }
    },
  }
}

async function setup(): Promise<{
  cwd: string
  terminals: Terminals
  seen: string[]
  call: (args: Record<string, unknown>) => Promise<ToolResult>
  done: () => Promise<void>
}> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-term-'))
  const terminals = new Terminals()
  const seen: string[] = []
  const call = (args: Record<string, unknown>): Promise<ToolResult> =>
    TERMINAL_TOOL.run(args, { cwd, access: openGate(cwd, seen), reads: new ReadIndex(), terminals })
  const done = async (): Promise<void> => {
    terminals.close()
    // The tree kill lands a moment later on Windows, and the folder is locked until it does.
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
  return { cwd, terminals, seen, call, done }
}

describe('a terminal', () => {
  it('takes input between calls and reports its exit', async () => {
    const { call, seen, done } = await setup()

    const started = await call({ action: 'start', command: 'echo ready; read -r line; echo "got $line"', until: 'ready', wait: 10 })
    expect(started.ok).toBe(true)
    expect(started.summary).toContain('[terminal t1, running')
    expect(started.summary).toContain('ready')

    const sent = await call({ action: 'send', id: 't1', input: 'hello', until: 'got', wait: 10 })
    expect(sent.summary).toContain('got hello')
    // Input to a running program is asked about like a command, and says where it goes.
    expect(seen.at(-1)).toContain('# input to terminal t1')

    const read = await call({ action: 'read', id: 't1', wait: 10 })
    expect(read.summary).toContain('exited 0')
    await done()
  }, 30_000)

  it('keeps running across calls until it is stopped', async () => {
    const { call, done } = await setup()

    await call({ action: 'start', command: 'while true; do echo tick; sleep 0.2; done', until: 'tick', wait: 10 })
    const later = await call({ action: 'read', id: 't1', wait: 1 })
    expect(later.summary).toContain('running')
    expect(later.summary).toContain('tick')

    const listed = await call({ action: 'list' })
    expect(listed.summary).toContain('t1, running')

    const stopped = await call({ action: 'stop', id: 't1' })
    expect(stopped.summary).not.toContain(', running')
    expect(stopped.summary).toContain('exited')

    const again = await call({ action: 'send', id: 't1', input: 'x' })
    expect(again.ok).toBe(false)
    expect(again.summary).toContain('nothing is reading input')
    await done()
  }, 30_000)

  it('returns as soon as the output matches `until`, not at the end of the wait', async () => {
    const { call, done } = await setup()
    const at = Date.now()
    const result = await call({ action: 'start', command: 'sleep 0.3; echo "listening on 3000"; sleep 60', until: 'listening', wait: 30 })

    expect(result.summary).toContain('listening on 3000')
    expect(Date.now() - at).toBeLessThan(15_000)
    await done()
  }, 30_000)

  it('is refused to an agent that has no terminals', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'nh-term-'))
    const result = await TERMINAL_TOOL.run({ action: 'start', command: 'echo hi' }, { cwd, access: openGate(cwd), reads: new ReadIndex() })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('not available to a subagent')
    await rm(cwd, { recursive: true, force: true })
  })
})
