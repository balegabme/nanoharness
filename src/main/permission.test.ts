import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionBroker, gateState, promptingGate } from './permission.js'
import type { AccessCheck, CommandCheck } from '../core/scope.js'

/**
 * What a refused tool call is told, and what happens when it tries again. The
 * wording is the whole point: a refusal read as a refusal of that one path
 * sends the agent to the next path along, and each attempt puts another modal
 * in front of the person who has already said no.
 *
 * The shell is the one ask that is all or nothing, because a command is not a
 * path and nothing reads it for one. These tests pin the three answers:
 * allowed once, allowed for the session, refused.
 */

/** The refusal text, or an empty string when the gate said yes. */
function reasonOf(result: AccessCheck | CommandCheck): string {
  return result.ok ? '' : result.reason
}

describe('a path the user refuses', () => {
  it('is answered from that refusal the second time, without asking again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    const asked: string[][] = []
    const broker: PermissionBroker = new PermissionBroker(request => {
      asked.push([...request.paths])
      broker.resolve(request.id, 'deny')
    })
    const gate = promptingGate({ root, sessionId: 'session-1', broker })
    const outside = join(tmpdir(), 'nh-perm-elsewhere', 'chrome.exe')

    const first = await gate.check(outside, 'read')
    const second = await gate.check(outside, 'read')

    expect(asked).toHaveLength(1)
    expect(first.ok).toBe(false)
    expect(reasonOf(first)).toContain('access was refused')
    expect(reasonOf(first)).toContain('another way to the same place')
    expect(reasonOf(first)).not.toContain('you denied')
    expect(reasonOf(second)).toContain('refused earlier in this session')
    expect(reasonOf(second)).toContain('nobody was asked again')
    await rm(root, { recursive: true, force: true })
  })

  it('answers a path the same way when it is asked about again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    let asks = 0
    const broker: PermissionBroker = new PermissionBroker(request => {
      asks += 1
      broker.resolve(request.id, 'deny')
    })
    const gate = promptingGate({ root, sessionId: 'session-1', broker })
    const outside = join(tmpdir(), 'nh-perm-elsewhere', 'cache')

    const first = await gate.check(outside, 'write')
    const second = await gate.check(outside, 'write')

    expect(asks).toBe(1)
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    expect(reasonOf(second)).toContain('refused earlier in this session')
    await rm(root, { recursive: true, force: true })
  })
})

describe('a window that went away', () => {
  it('denies what was waiting instead of leaving the turn hanging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    // The window goes away with the prompt already on its way to it.
    const broker: PermissionBroker = new PermissionBroker(() => broker.cancelAll())
    const gate = promptingGate({ root, sessionId: 'session-1', broker })

    const result = await gate.check(join(tmpdir(), 'nh-perm-elsewhere', 'notes.md'), 'read')

    expect(result.ok).toBe(false)
    expect(reasonOf(result)).toContain('access was refused')
    await rm(root, { recursive: true, force: true })
  })
})

describe('a path the user allows for the session', () => {
  it('grants its folder, so the file beside it is not asked about again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    let asks = 0
    const broker: PermissionBroker = new PermissionBroker(request => {
      asks += 1
      broker.resolve(request.id, 'session')
    })
    const gate = promptingGate({ root, sessionId: 'session-1', broker })
    const folder = join(tmpdir(), 'nh-perm-session')

    const first = await gate.check(join(folder, 'one.txt'), 'read')
    const second = await gate.check(join(folder, 'two.txt'), 'read')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(asks).toBe(1)
    await rm(root, { recursive: true, force: true })
  })
})

describe('a shell command', () => {
  it('asks once when the user allows all shell commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    const asked: (string | undefined)[] = []
    const broker: PermissionBroker = new PermissionBroker(request => {
      asked.push(request.command)
      broker.resolve(request.id, 'session')
    })
    const gate = promptingGate({ root, sessionId: 'session-1', broker })

    const first = await gate.checkCommand('echo one')
    const second = await gate.checkCommand('echo two')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(asked).toEqual(['echo one'])
    await rm(root, { recursive: true, force: true })
  })

  it('asks again for a different command when the first was allowed once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    const asked: (string | undefined)[] = []
    const broker: PermissionBroker = new PermissionBroker(request => {
      asked.push(request.command)
      broker.resolve(request.id, 'once')
    })
    const gate = promptingGate({ root, sessionId: 'session-1', broker })

    await gate.checkCommand('echo one')
    await gate.checkCommand('echo two')

    expect(asked).toEqual(['echo one', 'echo two'])
    await rm(root, { recursive: true, force: true })
  })

  it('remembers the command it refused, and asks about a different one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    const asked: (string | undefined)[] = []
    const broker: PermissionBroker = new PermissionBroker(request => {
      asked.push(request.command)
      broker.resolve(request.id, 'deny')
    })
    const gate = promptingGate({ root, sessionId: 'session-1', broker })

    const first = await gate.checkCommand('rm -rf build')
    const repeat = await gate.checkCommand('rm -rf build')
    const other = await gate.checkCommand('ls')

    expect(first.ok).toBe(false)
    expect(reasonOf(first)).toContain('did not approve')
    expect(repeat.ok).toBe(false)
    expect(reasonOf(repeat)).toContain('already refused')
    expect(other.ok).toBe(false)
    expect(asked).toEqual(['rm -rf build', 'ls'])
    await rm(root, { recursive: true, force: true })
  })

  it('is denied when the window goes away', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    const broker: PermissionBroker = new PermissionBroker(() => broker.cancelAll())
    const gate = promptingGate({ root, sessionId: 'session-1', broker })

    const result = await gate.checkCommand('echo hi')

    expect(result.ok).toBe(false)
    expect(reasonOf(result)).toContain('did not approve')
    await rm(root, { recursive: true, force: true })
  })

  it('shows the modal a command with the keys taken out, and remembers the real one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    const shown: (string | undefined)[] = []
    const broker: PermissionBroker = new PermissionBroker(request => {
      shown.push(request.command)
      broker.resolve(request.id, 'deny')
    })
    const gate = promptingGate({
      root,
      sessionId: 'session-1',
      broker,
      redact: text => text.replaceAll('sk-real-value', '{{secret:key}}'),
    })
    const command = 'curl -H "Authorization: Bearer sk-real-value" https://example.test'

    const first = await gate.checkCommand(command)
    // The same command, still holding the real value, is answered from the
    // refusal without asking again.
    const repeat = await gate.checkCommand(command)

    expect(first.ok).toBe(false)
    expect(repeat.ok).toBe(false)
    expect(shown).toEqual(['curl -H "Authorization: Bearer {{secret:key}}" https://example.test'])
    expect(reasonOf(first)).not.toContain('sk-real-value')
    await rm(root, { recursive: true, force: true })
  })

  it('keeps a grant when the session is rebuilt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-perm-'))
    let asks = 0
    const broker: PermissionBroker = new PermissionBroker(request => {
      asks += 1
      broker.resolve(request.id, 'session')
    })
    // One state, two gates: the second is what a rebuilt session gets.
    const state = gateState()
    const first = promptingGate({ root, sessionId: 'session-1', broker, state })
    await first.checkCommand('echo one')

    const rebuilt = promptingGate({ root, sessionId: 'session-1', broker, state })
    const second = await rebuilt.checkCommand('echo two')

    expect(second.ok).toBe(true)
    expect(asks).toBe(1)
    await rm(root, { recursive: true, force: true })
  })
})
