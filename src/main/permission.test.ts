import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionBroker, gateState, promptingGate } from './permission.js'
import { ApprovalUnavailableError } from '../core/approval.js'
import type { ApprovalRecord } from './permission.js'
import type { Judge, Verdict } from '../core/approval.js'
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

/**
 * Auto mode at the gate. The prompt is the thing being replaced, so what these
 * pin is the one case where it still appears, a judge that could not be
 * reached at all, and that it appears in no other: not on a denial, and never
 * to reopen a path the person has already refused themselves.
 */

/** A judge that answers from a script, with the shape `Judge` exposes. */
function scriptedJudge(answer: Verdict | Error): Judge {
  return {
    model: 'judge-model',
    judge: async () => {
      if (answer instanceof Error) throw answer
      return {
        verdict: answer,
        rule: 'rule #1',
        reason: `the approval model said ${answer}`,
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        costUsd: 0.000012,
        model: 'judge-model',
        ms: 12,
      }
    },
  } as unknown as Judge
}

describe('auto mode', () => {
  it('runs an allowed command without putting anything on screen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-auto-'))
    let asks = 0
    const broker: PermissionBroker = new PermissionBroker(request => {
      asks += 1
      broker.resolve(request.id, 'deny')
    })
    const records: ApprovalRecord[] = []
    const gate = promptingGate({
      root,
      sessionId: 's1',
      broker,
      state: gateState('auto'),
      judge: scriptedJudge('allow'),
      onDecision: record => records.push(record),
    })

    expect((await gate.checkCommand('npm test')).ok).toBe(true)
    expect(asks).toBe(0)
    // Nothing was drawn, so the log is the only trace there is. It has to exist
    // or "why did it run that" has no answer.
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome?.verdict).toBe('allow')
    await rm(root, { recursive: true, force: true })
  })

  it('refuses in its own name, not the user’s, and offers a way onwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-auto-'))
    let asks = 0
    const broker: PermissionBroker = new PermissionBroker(request => {
      asks += 1
      broker.resolve(request.id, 'once')
    })
    const gate = promptingGate({ root, sessionId: 's1', broker, state: gateState('auto'), judge: scriptedJudge('deny') })

    const result = await gate.checkCommand('rm -rf /')

    expect(asks).toBe(0)
    expect(result.ok).toBe(false)
    expect(reasonOf(result)).toContain('the approval step refused it')
    // The user has not seen this, so saying they refused it would be a lie the
    // agent repeats back to them.
    expect(reasonOf(result)).not.toContain('the user did not approve')
    expect(reasonOf(result)).toContain('say so in words')
    await rm(root, { recursive: true, force: true })
  })

  it('never puts the prompt up while the judge is answering, whichever way it answers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-auto-'))
    const asked: string[] = []
    const broker: PermissionBroker = new PermissionBroker(request => {
      asked.push(request.command ?? '')
      broker.resolve(request.id, 'once')
    })

    // The whole point of the mode: a run with nobody watching it cannot be
    // parked on a dialog, so a reachable judge always settles the question.
    const allowed = promptingGate({ root, sessionId: 's1', broker, state: gateState('auto'), judge: scriptedJudge('allow') })
    expect((await allowed.checkCommand('npm test')).ok).toBe(true)

    const denied = promptingGate({ root, sessionId: 's2', broker, state: gateState('auto'), judge: scriptedJudge('deny') })
    expect((await denied.checkCommand('git push --force')).ok).toBe(false)

    expect(asked).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('asks the person when the judge fails, and says on the prompt why', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-auto-'))
    const problems: (string | undefined)[] = []
    const broker: PermissionBroker = new PermissionBroker(request => {
      problems.push(request.problem)
      broker.resolve(request.id, 'once')
    })
    const records: ApprovalRecord[] = []
    const gate = promptingGate({
      root,
      sessionId: 's1',
      broker,
      state: gateState('auto'),
      judge: scriptedJudge(new ApprovalUnavailableError('no answer within 20s')),
      onDecision: record => records.push(record),
    })

    // The failure is never a verdict in either direction: the command is not
    // refused and not run, it is put to the person, with the reason on it.
    expect((await gate.checkCommand('npm test')).ok).toBe(true)
    expect(problems).toEqual(['no answer within 20s'])
    expect(records[0]?.problem).toBe('no answer within 20s')
    expect(records[0]?.outcome).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it('does not ask the judge to overturn a refusal the person already gave', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-auto-'))
    const state = gateState('ask')
    const broker: PermissionBroker = new PermissionBroker(request => {
      broker.resolve(request.id, 'deny')
    })
    const outside = join(tmpdir(), 'nh-auto-elsewhere', 'secrets.env')
    let consulted = 0
    const judge = {
      model: 'judge-model',
      judge: async () => {
        consulted += 1
        throw new ApprovalUnavailableError('should not have been asked')
      },
    } as unknown as Judge

    const gate = promptingGate({ root, sessionId: 's1', broker, state, judge })
    expect((await gate.check(outside, 'read')).ok).toBe(false)

    // Switching to auto mode afterwards must not reopen a settled question.
    state.mode = 'auto'
    const second = await gate.check(outside, 'read')

    expect(consulted).toBe(0)
    expect(reasonOf(second)).toContain('refused earlier in this session')
    await rm(root, { recursive: true, force: true })
  })
})
