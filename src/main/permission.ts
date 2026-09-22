// doc: docs/harness/sessions.md
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { ApprovalUnavailableError } from '../core/approval.js'
import { containedIn, normalizeTarget, outsideMessage, realResolve, resolveUnder } from '../core/scope.js'
import type { ApprovalAction, ApprovalOutcome, Judge, PermissionMode } from '../core/approval.js'
import type { AccessCheck, AccessGate, AccessIntent, CommandCheck } from '../core/scope.js'
import type { PermissionAsk, PermissionDecision } from '../ipc/contract.js'

/**
 * The gate a session gets inside the app. Inside its folder nothing is asked;
 * outside it the turn stops and waits for the person at the keyboard.
 *
 * The shell cannot be scoped by path, because a command line is a program and
 * no parser can tell what it will touch. Its question is all or nothing: the
 * first command shows itself and waits, and "Allow all shell commands" answers
 * it for the rest of the session. A grant lives in memory only.
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
   * Nobody is left to answer, because the window went away. Every waiting tool
   * is denied, and none is left on a promise that cannot settle.
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
   * NanoHarness's own source, so an agent asked about the harness can look
   * without asking permission to answer a question about itself. Reading
   * only: a write outside the workspace still stops the turn.
   */
  readable?: readonly string[]
  /**
   * Takes the keys out of a command before the modal shows it. The session
   * reveals `{{secret:name}}` in the arguments a tool runs with, so the person
   * approves the line with the placeholder still in it.
   */
  redact?: (text: string) => string
  /**
   * What the user has already allowed for this session. A live `Session` is
   * rebuilt whenever settings are saved or a role is switched, and an answer
   * the user gave about this session should outlive the rebuild. Callers that
   * pass nothing get a fresh state, which is what a test wants.
   */
  state?: GateState
  /**
   * The approval model, when one is configured. A gate without it prompts for
   * everything however the mode is set, which is why `approvalProblem` refuses
   * to turn auto mode on when there is nothing to ask.
   */
  judge?: Judge
  /**
   * The user's own words this session, newest last, for the judge to read the
   * action against. A function and not a value because the gate outlives
   * several turns and the goals grow with them.
   */
  goals?: () => readonly string[]
  /**
   * Every automatic decision, for the usage split and the transcript. Called
   * for a failure as well as a verdict.
   */
  onDecision?: (record: ApprovalRecord) => void
}

/**
 * One pass through the approval model, as the transcript records it.
 *
 * `outcome` is absent when the judge could not answer, and `problem` says why.
 * Exactly one of the two is set.
 */
export interface ApprovalRecord {
  action: ApprovalAction
  outcome?: ApprovalOutcome
  problem?: string
  at: number
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
  /**
   * How this session answers. It lives with the grants and not with the
   * provider settings, so switching it takes effect on the next tool call.
   */
  mode: PermissionMode
}

/** A blank state, for a session that has not asked anything yet. */
export function gateState(mode: PermissionMode = 'ask'): GateState {
  return { granted: new Set(), denied: new Set(), deniedCommands: new Set(), shellAllowed: false, mode }
}

export function promptingGate({ root, sessionId, broker, readable = [], redact, state = gateState(), judge, goals, onDecision }: PromptingGateOptions): AccessGate {
  // Paths the user allowed for the rest of this session, already resolved.
  const granted = state.granted
  // Paths the user already refused. A model that is told no tends to try the
  // same path again, and it is not asked twice.
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
   * Why a tool stopped. It says access was refused and not that the user
   * refused, because a closed window refuses too, and it says the path is not
   * the thing to work around.
   */
  function refusal(path: string, intent: AccessIntent, again = false): string {
    const head = outsideMessage(root, path, intent)
    return again
      ? `${head}; access there was refused earlier in this session, so nothing was run and nobody was asked again`
      : `${head}; access was refused. Do not go looking for another way to the same place: each attempt stops the turn and puts a prompt in front of the user`
  }

  function shellRefusal(command: string, again = false): string {
    const head = `the user did not approve this shell command, so it was not run`
    return again
      ? `${head}; it was already refused earlier in this session, so nobody was asked again. Do not retry it`
      : `${head}: ${command}. Do not work around a refusal, and do not retry the same command`
  }

  /**
   * What the agent is told when auto mode refused something. It names the
   * approval step and not the user, who has not seen this, and it offers
   * the one route onwards: stop and say so in words.
   */
  function autoRefusal(head: string, reason: string): string {
    return `${head}; the approval step refused it: ${reason}. Nobody was asked. Do not retry it and do not look for another route to the same place: if you think it is genuinely needed, stop and say so in words, and the user will decide.`
  }

  /**
   * Auto mode's answer for one action. The judge answers allow or deny and
   * there is no third thing it can say, so `settled` false means the mode is
   * off or the model could not be reached, and then `problem` travels to the
   * dialog. An unreachable judge is never turned into a verdict.
   */
  async function adjudicate(action: ApprovalAction): Promise<{ settled: true; allow: boolean; reason: string } | { settled: false; problem?: string }> {
    if (state.mode !== 'auto' || judge === undefined) return { settled: false }
    const at = Date.now()
    try {
      const outcome = await judge.judge(action, goals?.() ?? [])
      onDecision?.({ action, outcome, at })
      return { settled: true, allow: outcome.verdict === 'allow', reason: outcome.reason }
    } catch (err) {
      // The person pressed Stop. That is not the judge failing and it does not
      // become a prompt: the turn is ending.
      if (err instanceof Error && err.name === 'AbortError') throw err
      const problem = err instanceof ApprovalUnavailableError ? err.message : `the approval model failed: ${err instanceof Error ? err.message : String(err)}`
      onDecision?.({ action, problem, at })
      return { settled: false, problem }
    }
  }

  // "Allow for this session" grants the directory, not the single file. A tool
  // let at one path in a folder wants its neighbours next.
  async function grant(paths: readonly string[]): Promise<void> {
    for (const path of paths) granted.add(await realResolve(dirname(path)))
  }

  const gate: AccessGate = {
    root,
    async check(target: string, intent: AccessIntent): Promise<AccessCheck> {
      const { path, inside } = await resolveUnder(root, normalizeTarget(target))
      if (inside || alreadyAllowed(path, intent)) return { ok: true, path }
      // An answer the person already gave outranks the judge in both
      // directions: a path they refused stays refused, and one they allowed
      // was settled above.
      if (denied.has(path)) return { ok: false, path, reason: refusal(path, intent, true) }

      // Not remembered either way. The judge weighs the action against what the
      // user has asked for, and that changes with every turn. Caching the
      // verdict would answer next turn's question with last turn's goals.
      const auto = await adjudicate({ intent, paths: [path], root })
      if (auto.settled) {
        if (auto.allow) return { ok: true, path }
        return { ok: false, path, reason: autoRefusal(outsideMessage(root, path, intent), auto.reason) }
      }

      const decision = await broker.request({ sessionId, intent, paths: [path], root, ...(auto.problem === undefined ? {} : { problem: auto.problem }) })
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

      // The judge sees the redacted command, for the same reason the dialog
      // does: a command built around a pasted key would otherwise carry the
      // real value to a second endpoint.
      const auto = await adjudicate({ intent: 'run', paths: [], command: shown, root })
      if (auto.settled) {
        if (auto.allow) return { ok: true }
        return { ok: false, reason: autoRefusal(`this shell command was not run: ${shown}`, auto.reason) }
      }

      const decision = await broker.request({ sessionId, intent: 'run', paths: [], command: shown, root, ...(auto.problem === undefined ? {} : { problem: auto.problem }) })
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
