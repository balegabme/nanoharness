// doc: docs/harness/sessions.md
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { containedIn, expandHome, outsideMessage, realResolve, resolveUnder } from '../core/scope.js'
import type { AccessCheck, AccessGate, AccessIntent } from '../core/scope.js'
import type { PermissionAsk, PermissionDecision } from '../ipc/contract.js'

/**
 * The gate a session gets inside the app. Inside its folder nothing is asked;
 * outside it the turn stops and waits for the person at the keyboard, because
 * "the agent quietly wrote to my home directory" is exactly the outcome the
 * scoping rule exists to prevent.
 *
 * A grant is per session and lives in memory: closing the app forgets it.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, (decision: PermissionDecision) => void>()

  constructor(private readonly ask: (request: PermissionAsk) => void) {}

  request(request: Omit<PermissionAsk, 'id'>): Promise<PermissionDecision> {
    const id = randomUUID()
    return new Promise<PermissionDecision>(resolve => {
      this.pending.set(id, resolve)
      this.ask({ ...request, id })
    })
  }

  /** Answer one prompt. An unknown id is a stale click, not an error. */
  resolve(id: string, decision: PermissionDecision): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    pending(decision)
  }

  /**
   * Nobody is left to answer — the window went away. Every waiting tool is
   * denied rather than left hanging forever on a promise that cannot settle.
   */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending('deny')
    }
  }
}

export interface PromptingGateOptions {
  root: string
  sessionId: string
  broker: PermissionBroker
}

export function promptingGate({ root, sessionId, broker }: PromptingGateOptions): AccessGate {
  // Paths the user allowed for the rest of this session, already resolved.
  const granted = new Set<string>()

  return {
    root,
    async check(target: string, intent: AccessIntent): Promise<AccessCheck> {
      const { path, inside } = await resolveUnder(root, expandHome(target))
      if (inside) return { ok: true, path }
      for (const grant of granted) {
        if (containedIn(grant, path)) return { ok: true, path }
      }

      const decision = await broker.request({ sessionId, intent, path, root })
      if (decision === 'deny') {
        return { ok: false, path, reason: `${outsideMessage(root, path, intent)} — you denied access to it` }
      }
      // "Allow for this session" grants the directory, not the single file: a
      // tool that was let at one path in a folder invariably wants its
      // neighbours next, and re-prompting per file teaches people to click yes.
      if (decision === 'session') granted.add(await realResolve(intent === 'run' ? path : dirname(path)))
      return { ok: true, path }
    },
  }
}
