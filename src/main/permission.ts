// doc: docs/harness/sessions.md
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { containedIn, normalizeTarget, outsideMessage, realResolve, resolveUnder } from '../core/scope.js'
import type { AccessCheck, AccessGate, AccessIntent, CommandCheck } from '../core/scope.js'
import type { PermissionAsk, PermissionDecision } from '../ipc/contract.js'

/**
 * The gate a session gets inside the app. Inside its folder nothing is asked;
 * outside it the turn stops and waits for the person at the keyboard, because
 * "the agent quietly wrote to my home directory" is exactly the outcome the
 * scoping rule exists to prevent.
 *
 * The shell is the one tool that cannot be scoped by path, because a command
 * line is a program and no parser can tell what it will touch.
 * So its question is all or nothing: the first command of a session shows the
 * command and waits, and "Allow all shell commands" answers it for the rest of
 * the session. A grant is per session and lives in memory: closing the app
 * forgets it.
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
  /**
   * Folders every session may read without being asked. There is exactly one:
   * NanoHarness's own source, so an agent asked about the harness can go and
   * look instead of asking for permission to answer a question about itself.
   *
   * Reading, not writing — a write outside the workspace still stops the turn,
   * whichever folder it is. The shell does not consult this list at all: it is
   * a command, not a path, and it is answered by `checkCommand`.
   */
  readable?: readonly string[]
  /**
   * Takes the keys out of a command before the modal shows it. The session
   * reveals `{{secret:name}}` in the arguments a tool runs with, so a command
   * built around a pasted key holds the real value; the person approves a line
   * with the placeholder in it, which is exactly what the transcript will
   * hold.
   */
  redact?: (text: string) => string
  /**
   * What the user has already allowed for this session. A live `Session` is
   * rebuilt whenever settings are saved or a role is switched, and an answer
   * the user gave about this session should outlive the rebuild. Callers that
   * pass nothing get a fresh state, which is what a test wants.
   */
  state?: GateState
}

/**
 * Everything one session remembers about what the person allowed. It lives
 * outside the gate because the gate is rebuilt with the session; `granted` and
 * `denied` are resolved paths, `deniedCommands` and `shellAllowed` are the
 * shell's two answers.
 */
export interface GateState {
  readonly granted: Set<string>
  readonly denied: Set<string>
  readonly deniedCommands: Set<string>
  shellAllowed: boolean
}

/** A blank state, for a session that has not asked anything yet. */
export function gateState(): GateState {
  return { granted: new Set(), denied: new Set(), deniedCommands: new Set(), shellAllowed: false }
}

export function promptingGate({ root, sessionId, broker, readable = [], redact, state = gateState() }: PromptingGateOptions): AccessGate {
  // Paths the user allowed for the rest of this session, already resolved.
  const granted = state.granted
  // Paths the user already refused. A model that is told no tends to try the
  // same path again, and asking a second time about something already answered
  // is how a prompt stops being read.
  const denied = state.denied
  // Commands the user already refused. Remembered by their text, so a retry of
  // the same command costs no second prompt, and a different command asks.
  const deniedCommands = state.deniedCommands

  function alreadyAllowed(path: string, intent: AccessIntent): boolean {
    for (const grant of granted) {
      if (containedIn(grant, path)) return true
    }
    if (intent === 'write') return false
    return readable.some(dir => containedIn(dir, path))
  }

  /**
   * Why a tool stopped. It says access was refused rather than that the user
   * refused, because a closed window refuses too; and it says the path is not
   * the thing to work around, because a refusal read as a refusal of that path
   * alone sends the agent to the next path along and puts a second modal in
   * front of the same person for the same idea. The repeat wording says the
   * answer is already in, which is what stops the retry loop.
   */
  function refusal(path: string, intent: AccessIntent, again = false): string {
    const head = outsideMessage(root, path, intent)
    return again
      ? `${head} — access there was refused earlier in this session, so nothing was run and nobody was asked again`
      : `${head} — access was refused. Do not go looking for another way to the same place: each attempt stops the turn and puts a prompt in front of the user`
  }

  function shellRefusal(command: string, again = false): string {
    const head = `the user did not approve this shell command, so it was not run`
    return again
      ? `${head} — it was already refused earlier in this session, so nobody was asked again. Do not retry it`
      : `${head}: ${command}. Do not work around a refusal, and do not retry the same command`
  }

  // "Allow for this session" grants the directory, not the single file: a tool
  // that was let at one path in a folder invariably wants its neighbours next,
  // and re-prompting per file teaches people to click yes.
  async function grant(paths: readonly string[]): Promise<void> {
    for (const path of paths) granted.add(await realResolve(dirname(path)))
  }

  const gate: AccessGate = {
    root,
    async check(target: string, intent: AccessIntent): Promise<AccessCheck> {
      const { path, inside } = await resolveUnder(root, normalizeTarget(target))
      if (inside || alreadyAllowed(path, intent)) return { ok: true, path }
      if (denied.has(path)) return { ok: false, path, reason: refusal(path, intent, true) }

      const decision = await broker.request({ sessionId, intent, paths: [path], root })
      if (decision === 'deny') {
        denied.add(path)
        return { ok: false, path, reason: refusal(path, intent) }
      }
      if (decision === 'session') await grant([path])
      return { ok: true, path }
    },

    async checkCommand(command: string): Promise<CommandCheck> {
      if (state.shellAllowed) return { ok: true }
      const shown = redact === undefined ? command : redact(command)
      if (deniedCommands.has(command)) return { ok: false, reason: shellRefusal(shown, true) }

      const decision = await broker.request({ sessionId, intent: 'run', paths: [], command: shown, root })
      if (decision === 'deny') {
        deniedCommands.add(command)
        return { ok: false, reason: shellRefusal(shown) }
      }
      if (decision === 'session') state.shellAllowed = true
      return { ok: true }
    },
  }
  return gate
}
