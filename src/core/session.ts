// doc: docs/harness/overview.md
import { EventBus } from './event-bus.js'
import { ProviderError, backoffFor, isRetryable, sleep } from './provider.js'
import type { ChatProvider } from './provider.js'
import type { Effort, ModelFacts } from './config.js'
import { costOf, moneyText } from './cost.js'
import { workspaceGate } from './scope.js'
import type { AccessGate } from './scope.js'
import { emptyToolStats, emptyUsage } from './types.js'
import { SecretVault } from './secrets.js'
import type { ChatMessage, PreventedCall, SessionNote, ThinkingBlock, ToolCall, ToolInput, ToolResult, ToolStats, TurnUsage } from './types.js'
import type { SpawnHost } from './spawn.js'
import type { JobRegistry } from './jobs.js'

/**
 * What a tool is handed instead of a bare cwd. `access` is the scope guard: a
 * tool asks it before touching a path, so no tool has to remember the rule and
 * none can forget it (see `scope.ts`).
 */
export interface ToolContext {
  cwd: string
  access: AccessGate
  /** Present when this session may summon subagents. A subagent gets no host. */
  spawn?: SpawnHost
  /** Present when this session *is* a background job, so it can report progress. */
  job?: { id: string; jobs: JobRegistry }
}

export interface Tool {
  input: ToolInput
  /**
   * True for a tool that only reads, which the loop may run at the same time as
   * another call from the same message. A tool that says nothing runs alone.
   */
  parallel?: boolean
  /**
   * True for a tool whose arguments must reach it exactly as the model wrote
   * them, `{{secret:name}}` and all. Every other tool gets the real values
   * substituted in. `spawn` and `job_update` only turn their arguments into
   * text, so filling those in would put the key back on the wire and on disk.
   */
  keepsPlaceholders?: boolean
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export type ArgsParse<A> = { ok: true; args: A } | { ok: false; error: string }

export interface ToolSpec<A> {
  input: ToolInput
  /** See `Tool.parallel`. */
  parallel?: boolean
  /** See `Tool.keepsPlaceholders`. A tool that only turns its arguments into text. */
  keepsPlaceholders?: boolean
  parse(args: Record<string, unknown>): ArgsParse<A>
  run(args: A, ctx: ToolContext): Promise<ToolResult>
}

// Tool args arrive as untrusted wire JSON, so the stored Tool keeps an erased
// arg type. defineTool validates once at that boundary; the spec's run() then
// works with a real type instead of casting field by field.
export function defineTool<A>(spec: ToolSpec<A>): Tool {
  return {
    input: spec.input,
    ...(spec.parallel === true ? { parallel: true } : {}),
    ...(spec.keepsPlaceholders === true ? { keepsPlaceholders: true } : {}),
    async run(raw, ctx) {
      const parsed = spec.parse(raw)
      if (parsed.ok) return spec.run(parsed.args, ctx)
      const error = `${spec.input.name}: ${parsed.error}`
      return { ok: false, summary: error, content: error, isError: true }
    },
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The tool loop is not capped; a model going in circles is caught on its own
 * terms instead. The third identical call is refused and the model told so, and
 * at the sixth the turn ends with a note saying that is what happened.
 */
const REPEAT_REFUSE = 3
const REPEAT_ABORT = 6

/** Failures in a row after which the model is told it is thrashing. Not a stop. */
const FAILURE_NUDGE = 5

const CLOSING_NOTE_ODDS = 1 / 10_000
const CLOSING_NOTE = 'I love you <3 — balega, creator of nanoharness'

/** How many times one round is asked for before the turn gives up. */
const ROUND_ATTEMPTS = 5

/** Waits between attempts, in milliseconds. One entry per gap, so four. */
const BACKOFF_MS = [500, 1500, 4000, 8000]

/**
 * The tools whose `path` argument names a file the turn changed. A `bash` call
 * can write one too and nothing here can see that it did, so the summary claims
 * nothing wider. `chat.ts` keeps the same list; change one and change the other.
 */
const WRITERS = new Set(['edit', 'write'])

/** Paths listed before the line gives up and counts the rest. */
const FILES_LISTED = 12

/**
 * What a prevented call was about, for the list under the summary.
 */
function preventedTarget(call: ToolCall): string {
  try {
    const parsed: unknown = JSON.parse(call.args)
    if (typeof parsed !== 'object' || parsed === null) return ''
    const { path, command } = parsed as { path?: unknown; command?: unknown }
    if (typeof command === 'string' && command !== '') return command
    return typeof path === 'string' ? path : ''
  } catch {
    return ''
  }
}

/**
 * The file a finished call changed, or null when it changed none. The arguments
 * arrive as the JSON string the model wrote, so a call whose arguments never
 * parsed is one the tool refused; it reached here as a failure and is not asked.
 */
function writtenPath(call: ToolCall): string | null {
  if (!WRITERS.has(call.name)) return null
  try {
    const parsed: unknown = JSON.parse(call.args)
    if (typeof parsed !== 'object' || parsed === null) return null
    const path = (parsed as { path?: unknown }).path
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    return null
  }
}

/**
 * A duration as the summary says it: `2m 14s` over a minute, seconds under one,
 * and `<1s` for a turn that came back before the first tick.
 */
function elapsedText(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The files a turn changed, with a long list cut short rather than stored whole. */
function fileList(files: readonly string[]): string {
  if (files.length === 0) return ''
  const head = files.slice(0, FILES_LISTED).join(', ')
  const rest = files.length - FILES_LISTED
  const named = rest > 0 ? `${head}, and ${rest} more` : head
  return ` · ${files.length} file${files.length === 1 ? '' : 's'} changed: ${named}`
}

/**
 * The line a turn ends on: how much tool work it took, which files came out of
 * it different, and how long the user waited. Stored with the transcript, so a
 * re-opened session shows the line it showed live. The model is never sent it.
 */
function turnSummary(tools: ToolStats, files: readonly string[], ms: number, spent: number | null): string {
  // "prevented" is only ever shown when there is one.
  const stopped = tools.prevented === 0 ? '' : `, ${tools.prevented} prevented`
  const calls =
    tools.calls === 0
      ? 'no tool calls'
      : `${tools.calls} tool call${tools.calls === 1 ? '' : 's'}, ${tools.ok} ok, ${tools.failed} failed${stopped}`
  const cost = spent === null ? '' : ` · ${moneyText(spent)}`
  return `${calls}${fileList(files)} · ${elapsedText(ms)}${cost}`
}

export interface SessionOptions {
  sessionId: string
  cwd: string
  model: string
  systemPrompt: string
  effort?: Effort
  /**
   * What it charges and the most output it will produce. Absent when nobody has
   * described this model, which leaves the cost off the line rather than guessed.
   */
  facts?: ModelFacts
  /** Defaults to a hard block outside `cwd`; the app passes one that can ask. */
  access?: AccessGate
  /** Messages from an earlier run of this session, replayed as history. */
  history?: ChatMessage[]
  /** Lets the `spawn` tool hand work to another agent (plan §5). */
  spawn?: SpawnHost
  /** Set when this session is running as a background job. */
  job?: { id: string; jobs: JobRegistry }
  /** What this session had already spent before it was rebuilt. */
  usage?: TurnUsage
  /** The subagents' share of `usage`, so a rebuild does not lose the split. */
  subagentUsage?: TurnUsage
  /** The harness's own share of `usage`, kept across a rebuild for the same reason. */
  harnessUsage?: TurnUsage
  /** What that share cost, at the prices of the models that actually ran it. */
  harnessCostUsd?: number
  /**
   * The keys the user pasted. The model holds placeholders for them; this is the
   * only object that can turn one back into a value, for tool arguments alone.
   */
  secrets?: SecretVault
}

export class Session {
  readonly bus: EventBus
  readonly access: AccessGate
  private readonly secrets: SecretVault
  private readonly messages: ChatMessage[] = []
  private readonly journal: SessionNote[] = []
  private turn = 0
  /** The last tool call and how many times in a row it has been asked for. */
  private repeat: { key: string; count: number } = { key: '', count: 0 }
  private failures = 0
  /**
   * The provider sent a usage report that could not be read, and the fault is
   * already recorded. Said once per session.
   */
  private usageProblemNoted = false
  /** Set for the turn in hand, so its summary line does not price a report it could not read. */
  private turnUsageProblem = false
  private totalUsage = emptyUsage()
  private turnUsage = emptyUsage()
  /**
   * The part of `totalUsage` that subagents spent. Kept apart: a turn that
   * delegates can spend fifty thousand tokens while this session writes a
   * paragraph.
   */
  private subagentUsage: TurnUsage = emptyUsage()
  /**
   * The part of `totalUsage` the harness spent on its own behalf rather than on
   * the conversation: today the approval model, later a summariser or a titler.
   */
  private harnessUsage: TurnUsage = emptyUsage()
  /**
   * What `harnessUsage` cost, in dollars, summed as each call was made.
   */
  private harnessCostUsd = 0
  /** What this session's own tool calls came to, for whoever started it. */
  private readonly tally = emptyToolStats()
  /**
   * The same three numbers for the turn running now, plus the files it changed
   * and when it started. `tally` is session-wide and cannot answer "what did
   * that last message cost me".
   */
  private turnTally = emptyToolStats()
  /**
   * What the permission system stopped this turn, in the order it stopped it.
   */
  private turnPrevented: PreventedCall[] = []
  private readonly turnFiles = new Set<string>()
  private turnStartedAt = 0
  // Stop is cooperative: the in-flight request is aborted and the loop ends at
  // the next boundary, leaving the transcript in a shape the model can be
  // asked to continue from.
  private controller: AbortController | null = null
  private stopped = false
  /**
   * Answers from background subagents not yet folded into the conversation. A
   * message pushed between a tool call and its result is a request both
   * providers refuse, so they wait here for a balanced point in the transcript.
   */
  private readonly pending: string[] = []

  constructor(
    readonly options: SessionOptions,
    private readonly provider: ChatProvider,
    private readonly tools: Tool[],
    bus?: EventBus,
  ) {
    this.bus = bus ?? new EventBus()
    this.access = options.access ?? workspaceGate(options.cwd)
    this.secrets = options.secrets ?? new SecretVault()
    this.messages.push({ role: 'system', content: options.systemPrompt })
    // A resumed session keeps its running total: those turns were paid for, and
    // a counter that restarts at zero says they were not. A stored total that
    // counted cached tokens keeps that overlap. It cannot be repaired: the
    // figure does not say which wire produced it.
    this.totalUsage = { ...(options.usage ?? emptyUsage()) }
    // Seeded beside the total it is part of. Left at zero, the first usage
    // event of a rebuilt session would report that subagents had spent nothing
    // and the next turn would write that over the stored breakdown.
    this.subagentUsage = { ...(options.subagentUsage ?? emptyUsage()) }
    this.harnessUsage = { ...(options.harnessUsage ?? emptyUsage()) }
    this.harnessCostUsd = options.harnessCostUsd ?? 0
    // A resumed session keeps its own system prompt, not the stored one: the
    // prompt is built fresh each launch and may have changed since.
    for (const message of options.history ?? []) {
      if (message.role !== 'system') this.messages.push(message)
    }
    // Turn numbers continue where the stored conversation left off, so the
    // usage log of a resumed session does not restart at 1.
    this.turn = this.messages.filter(m => m.role === 'user').length
  }

  /** The conversation so far, for persisting and re-opening this session. */
  get transcript(): ChatMessage[] {
    return this.messages.filter(m => m.role !== 'system')
  }

  /** Everything the window showed that was not a message, in order. */
  get notes(): SessionNote[] {
    return [...this.journal]
  }

  /**
   * Say something about the run itself. It reaches the window as an event and
   * the stored transcript as a note, so re-opening the session shows the same
   * thing the user saw the first time.
   */
  note(text: string): void {
    const safe = this.secrets.redact(text)
    this.record('note', safe)
    this.bus.emit({ type: 'session.note', sessionId: this.options.sessionId, turn: this.turn, text: safe, at: Date.now() })
  }

  /**
   * What the turn came to. It goes to the window as an event and to the stored
   * transcript as a note of its own kind. `docs/harness/ui.md` says why it is
   * drawn apart from a note.
   */
  private summarize(text: string): void {
    // The paths came from tool arguments, which hold `{{secret:name}}` and
    // never a value, so this should find nothing.
    const safe = this.secrets.redact(text)
    // The list goes through the same scrub the text does. A prevented command
    // is one the model wrote, so it is the likeliest string here to be
    // carrying a pasted key.
    const stopped = this.turnPrevented.map(one => ({
      ...one,
      target: this.secrets.redact(one.target),
      reason: this.secrets.redact(one.reason),
    }))
    this.record('summary', safe, stopped)
    this.bus.emit({
      type: 'session.summary',
      sessionId: this.options.sessionId,
      turn: this.turn,
      text: safe,
      ...(stopped.length === 0 ? {} : { prevented: stopped }),
      at: Date.now(),
    })
  }

  /**
   * The harness failed at its own job around the turn. A tool reporting a bad
   * result is ordinary and goes through `note`, which is drawn as margin
   * commentary; a fault is drawn and recorded as an error.
   */
  fault(text: string): void {
    const safe = this.secrets.redact(text)
    this.record('error', safe)
    this.bus.emit({ type: 'session.error', sessionId: this.options.sessionId, turn: this.turn, message: safe, at: Date.now() })
  }

  /**
   * The provider sent a usage report that could not be read, so this turn's cost
   * is unknown. Nothing is invented to cover the gap.
   */
  private noteUsageProblem(problem: string): void {
    this.turnUsageProblem = true
    if (this.usageProblemNoted) return
    this.usageProblemNoted = true
    this.fault(`the provider's usage report could not be read (${problem}); this turn's cost is unknown`)
  }

  /**
   * Something the conversation should carry on from, arriving from outside the
   * turn: the answer a background subagent finished with. It is folded in at the
   * next balanced point, the top of a turn or the end of a round, so an
   * answer that lands mid-round still reaches the model in that same turn.
   */
  deliver(text: string): void {
    this.pending.push(text)
    // With no turn in flight there is nothing to land in the middle of, so it
    // goes straight in. Queueing it here would strand it: between turns nothing
    // is coming that would drain the queue.
    if (!this.running) this.flushPending()
  }

  /**
   * Fold anything queued straight in, because there is no next round to fold
   * it at: the process is ending, and the transcript written a moment later is
   * what survives.
   */
  settle(): void {
    this.flushPending()
  }

  private flushPending(): void {
    if (this.pending.length === 0) return
    for (const text of this.pending.splice(0)) this.messages.push({ role: 'user', content: this.safe(text) })
  }

  /**
   * The journal half of a line the window is already being told about another
   * way, such as an error or a stop. Recorded without an event, so the renderer
   * draws it once live and once on replay, never twice.
   */
  private record(kind: SessionNote['kind'], text: string, prevented?: readonly PreventedCall[]): void {
    // The journal is written to disk, so it is a boundary like any other.
    // `prevented` was scrubbed by its caller, the only one that has it.
    this.journal.push({
      kind,
      text: this.secrets.redact(text),
      turn: this.turn,
      after: this.transcript.length,
      at: Date.now(),
      ...(prevented === undefined || prevented.length === 0 ? {} : { prevented: [...prevented] }),
    })
  }

  /** Notes from an earlier run of this session, replayed alongside the history. */
  restoreNotes(notes: readonly SessionNote[]): void {
    this.journal.push(...notes)
  }

  /** True while a turn is running, which is the only time `stop()` does anything. */
  get running(): boolean {
    return this.controller !== null
  }

  /**
   * End the turn now: abort the request in flight and stop the tool loop.
   * Subagents go with it, since nothing else in the app can end a background
   * one.
   */
  stop(): void {
    this.options.spawn?.stopAll()
    if (this.controller === null) return
    this.stopped = true
    this.controller.abort()
  }

  /** True when the last turn ended because it was stopped, not because it finished. */
  get interrupted(): boolean {
    return this.stopped
  }

  /** Everything this session has spent, its subagents included. */
  get spent(): TurnUsage {
    return { ...this.totalUsage }
  }

  /** The subagents' share of `spent`. Zero for a session that delegated nothing. */
  get spentBySubagents(): TurnUsage {
    return { ...this.subagentUsage }
  }

  /** The harness's own share of `spent`: approval checks and anything like them. */
  get spentByHarness(): TurnUsage {
    return { ...this.harnessUsage }
  }

  /** What that share came to, priced as it was spent. */
  get harnessCost(): number {
    return this.harnessCostUsd
  }

  /** How many tool calls this session made, and how they went. */
  get toolStats(): ToolStats {
    return { ...this.tally }
  }

  /**
   * Tokens a subagent of this session spent. A subagent is billed to whoever
   * started it, so its usage lands in the same total and leaves by the same
   * event. The event carries no `streamMs`: those tokens came off a stream this
   * session never timed, and there is no interval the two of them share.
   */
  addSubagentUsage(delta: TurnUsage): void {
    this.addUsage(delta)
    addInto(this.subagentUsage, delta)
    this.emitUsage()
  }

  /**
   * Tokens the harness spent on a side-call of its own, an approval check, with
   * what it cost at that model's prices. Null when nobody has priced the model:
   * an unpriced call adds its tokens and leaves the money alone.
   */
  addHarnessUsage(delta: TurnUsage, costUsd: number | null): void {
    this.addUsage(delta)
    addInto(this.harnessUsage, delta)
    if (costUsd !== null) this.harnessCostUsd += costUsd
    this.emitUsage()
  }

  /**
   * The running totals, as one event. `streamMs` is only ever set by a round
   * this session timed itself: a subagent's tokens and a side-call's came off
   * streams nobody here held a clock on.
   */
  private emitUsage(streamMs?: number): void {
    this.bus.emit({
      type: 'usage',
      sessionId: this.options.sessionId,
      turn: this.turn,
      usage: { ...this.totalUsage },
      subagent: { ...this.subagentUsage },
      harness: { ...this.harnessUsage },
      harnessCostUsd: this.harnessCostUsd,
      ...(streamMs === undefined ? {} : { streamMs }),
      at: Date.now(),
    })
  }

  /** Number of the turn that ran most recently. */
  get turnNumber(): number {
    return this.turn
  }

  /** Usage for the most recent `run()` alone, where `run()` returns the session total. */
  get lastTurnUsage(): TurnUsage {
    return { ...this.turnUsage }
  }

  async run(userText: string): Promise<TurnUsage> {
    this.turn += 1
    this.turnUsage = emptyUsage()
    this.turnUsageProblem = false
    this.turnTally = emptyToolStats()
    this.turnPrevented = []
    this.turnFiles.clear()
    this.turnStartedAt = Date.now()
    this.stopped = false
    this.controller = new AbortController()
    const sessionId = this.options.sessionId
    this.bus.emit({ type: 'session.started', sessionId, cwd: this.options.cwd, at: Date.now() })
    // Anything a background job finished with between turns goes in first: it
    // happened before this message, and the model should read it that way.
    this.flushPending()
    this.messages.push({ role: 'user', content: userText })

    try {
      return await this.runRounds(sessionId)
    } catch (err) {
      // A tool that threw rather than returned can be quoting the arguments it
      // was given, which by then held the real value.
      const message = this.secrets.redact(err instanceof Error ? err.message : String(err))
      this.record('error', message)
      this.bus.emit({ type: 'session.error', sessionId, turn: this.turn, message, at: Date.now() })
      throw err
    } finally {
      this.controller = null
      // What the turn came to, before anything else is folded in, so the line
      // lands under the turn it is about. Every way out of a turn passes here.
      // Priced from the model that actually ran it, which is why this is here
      // and not in the window: the window knows only what is selected now.
      const facts = this.options.facts
      // A turn whose usage nobody reported is not a turn that cost nothing, so
      // the cost is left off the line rather than printed as $0.
      const counted = this.turnUsage.input + this.turnUsage.output + this.turnUsage.cacheRead + this.turnUsage.cacheWrite
      const known = facts !== undefined && counted > 0 && !this.turnUsageProblem
      const spent = known ? costOf(this.turnUsage, facts) : null
      this.summarize(turnSummary(this.turnTally, [...this.turnFiles], Date.now() - this.turnStartedAt, spent))
      // A job that finished during the last round queued its answer and found
      // no round left to be folded into. The transcript is balanced here on
      // every path out, so this is the last chance to keep it.
      this.flushPending()
    }
  }

  /**
   * Rounds until the model stops asking for tools. There is no round budget: a
   * task that needs forty calls gets forty.
   */
  private async runRounds(sessionId: string): Promise<TurnUsage> {
    this.repeat = { key: '', count: 0 }
    this.failures = 0

    for (;;) {
      const { text, toolCalls, usage, thinking, streamMs } = await this.drainRound()
      this.addUsage(usage)
      this.emitUsage(streamMs)

      // An assistant message with no text, no tool calls and no thinking draws
      // a blank in the window, and some providers refuse to take it back.
      if (text !== '' || toolCalls.length > 0 || thinking.length > 0) {
        this.messages.push({
          role: 'assistant',
          // The model's own words go through the same scrub a tool result
          // does. This is where the whole string exists, so a value split
          // across two deltas is caught here.
          content: this.secrets.empty ? text : this.secrets.redact(text),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(thinking.length > 0 ? { thinking } : {}),
        })
      }

      if (this.stopped) {
        // Whatever the model had already asked for still needs an answer, or the
        // next request carries tool calls nothing ever replied to.
        for (const call of toolCalls) this.noteSkipped(call)
        this.record('stopped', 'Stopped.')
        this.bus.emit({ type: 'session.stopped', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      if (toolCalls.length === 0) {
        // No answer, no error and nothing on screen is the one ending the
        // user cannot act on. Say so.
        if (text.trim() === '') this.note('The turn ended without an answer. Send that again, or ask for what is missing.')
        else if (Math.random() < CLOSING_NOTE_ODDS) this.note(CLOSING_NOTE)
        this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      // Calls run together where the tools say it is safe, and in the model's
      // order either way. A write runs alone: the next call in the message may
      // be about the file it just changed.
      await this.executeTools(toolCalls)

      // Every tool call now has its result, so the transcript is balanced and a
      // background answer can be folded in. A job started earlier in this turn
      // is therefore usable before the turn ends.
      this.flushPending()

      if (this.stopped) {
        this.record('stopped', 'Stopped.')
        this.bus.emit({ type: 'session.stopped', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      if (this.repeat.count >= REPEAT_ABORT) {
        const stuck = `The same tool call was asked for ${this.repeat.count} times in a row, so the turn was ended here. Nothing was cut for length: this one call was going round in circles.`
        this.note(stuck)
        this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }
    }
  }

  /**
   * One round, asked for as many times as it takes or until `ROUND_ATTEMPTS` is
   * out.
   *
   * A retry throws away whatever the failed attempt had streamed, which is why
   * the window is told. What it was charged for is kept and carried into the
   * round that succeeds, so a rate-limited turn is not under-reported.
   */
  private async drainRound(): Promise<{ text: string; toolCalls: ToolCall[]; usage: TurnUsage; thinking: ThinkingBlock[]; streamMs: number }> {
    const sessionId = this.options.sessionId
    const carried = emptyUsage()
    for (let attempt = 1; ; attempt += 1) {
      const spent = emptyUsage()
      this.bus.emit({ type: 'round.started', sessionId, turn: this.turn, at: Date.now() })
      try {
        const round = await this.attemptRound(spent)
        // A fresh total rather than a running one: `round.usage` is the object
        // the provider handed over, and the caller reads it again.
        const usage = emptyUsage()
        addInto(usage, round.usage)
        addInto(usage, carried)
        return { ...round, usage }
      } catch (err) {
        addInto(carried, spent)
        if (this.stopped || attempt >= ROUND_ATTEMPTS || !isRetryable(err)) throw err
        const why = this.secrets.redact(err instanceof Error ? err.message : String(err))
        const text = `The request failed (${why}). Asking again: attempt ${attempt + 1} of ${ROUND_ATTEMPTS}.`
        // Journalled without an event of its own, because `round.retry` is the
        // event and carries the same words. Replay reads it back from here.
        this.record('note', text)
        this.bus.emit({ type: 'round.retry', sessionId, turn: this.turn, attempt: attempt + 1, of: ROUND_ATTEMPTS, text, at: Date.now() })
        await sleep(backoffFor(err, attempt, BACKOFF_MS), this.controller?.signal)
        // Stop pressed during the wait. An empty round is what an aborted
        // stream hands back, so the loop winds down the way it knows rather
        // than ending the turn as an error.
        if (this.stopped) return { text: '', toolCalls: [], usage: carried, thinking: [], streamMs: 0 }
      }
    }
  }

  /**
   * One request. `spent` is filled in as the provider reports usage, so a round
   * that fails halfway still says what it cost on its way out.
   */
  private async attemptRound(spent: TurnUsage): Promise<{ text: string; toolCalls: ToolCall[]; usage: TurnUsage; thinking: ThinkingBlock[]; streamMs: number }> {
    let text = ''
    const toolCalls: ToolCall[] = []
    const thinking: ThinkingBlock[] = []
    let usage = emptyUsage()
    // Timed from the first chunk rather than from the request, so the number is
    // generation speed and not generation speed plus however long it queued.
    let firstChunkAt = 0

    const chunks = this.provider.stream({
      model: this.options.model,
      messages: this.messages,
      tools: this.tools.map(t => t.input),
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.options.facts?.maxOutput === undefined ? {} : { maxTokens: this.options.facts.maxOutput }),
      ...(this.controller === null ? {} : { signal: this.controller.signal }),
    })

    try {
      for await (const chunk of chunks) {
        if (firstChunkAt === 0) firstChunkAt = Date.now()
        switch (chunk.kind) {
          case 'text':
            text += chunk.text
            this.bus.emit({ type: 'text_delta', sessionId: this.options.sessionId, text: this.safe(chunk.text), at: Date.now() })
            break
          case 'thinking':
            this.bus.emit({ type: 'thinking_delta', sessionId: this.options.sessionId, text: this.safe(chunk.text), at: Date.now() })
            break
          case 'thinking_block':
            // Kept in the transcript, so it is scrubbed like everything else
            // written down. A signed block is left exactly as the provider
            // signed it: editing it invalidates the signature.
            thinking.push(
              chunk.block.kind === 'thinking' && chunk.block.signature === undefined
                ? { ...chunk.block, text: this.safe(chunk.block.text) }
                : chunk.block,
            )
            break
          case 'tool':
            toolCalls.push(chunk.tool)
            this.bus.emit({ type: 'tool_call', sessionId: this.options.sessionId, call: chunk.tool, at: Date.now() })
            break
          case 'usage':
            copyInto(spent, chunk.usage)
            break
          case 'done':
            usage = chunk.usage
            copyInto(spent, chunk.usage)
            if (chunk.usageProblem !== undefined) this.noteUsageProblem(chunk.usageProblem)
            break
          case 'error':
            // As a ProviderError, so a provider that fell over halfway through
            // a stream is retried on the same terms as one that refused the
            // request outright.
            throw new ProviderError(chunk.message, chunk.status)
        }
      }
    } catch (err) {
      // Stop aborts the request mid-stream, so the abort is the expected end of
      // this round. Keep what arrived and let the loop wind down.
      if (!this.stopped) throw err
    }
    return { text, toolCalls, usage, thinking, streamMs: firstChunkAt === 0 ? 0 : Date.now() - firstChunkAt }
  }

  /** A tool call the stop landed on top of. The model is told it never ran. */
  private noteSkipped(call: ToolCall): void {
    const note = 'stopped by the user before this ran'
    this.bus.emit({
      type: 'tool_result',
      sessionId: this.options.sessionId,
      callId: call.id,
      result: { ok: false, summary: note, content: note, isError: true },
      at: Date.now(),
    })
    this.messages.push({ role: 'tool', content: note, toolCallId: call.id, failed: true })
  }

  /**
   * Every call of one assistant message, in order. A run of tools that declared
   * themselves read-only starts together and commits in the order the model
   * asked; anything else runs on its own.
   */
  private async executeTools(calls: readonly ToolCall[]): Promise<void> {
    let next = 0
    while (next < calls.length) {
      const call = calls[next]
      if (call === undefined) return
      if (this.stopped) {
        this.noteSkipped(call)
        next += 1
        continue
      }
      if (this.toolFor(call)?.parallel !== true) {
        await this.executeTool(call)
        next += 1
        continue
      }
      const group: ToolCall[] = []
      for (;;) {
        const candidate = calls[next]
        if (candidate === undefined || this.toolFor(candidate)?.parallel !== true) break
        group.push(candidate)
        next += 1
      }
      const done = await Promise.all(
        group.map(async call => ({ call, result: this.scrub(await this.resultFor(call)) })),
      )
      for (const { call, result } of done) this.commit(call, result)
    }
  }

  private async executeTool(call: ToolCall): Promise<void> {
    this.commit(call, this.scrub(await this.resultFor(call)))
  }

  /** The window, the transcript and the failure count for one finished call. */
  private commit(call: ToolCall, result: ToolResult): void {
    this.tally.calls += 1
    this.turnTally.calls += 1
    if (result.ok) {
      this.tally.ok += 1
      this.turnTally.ok += 1
      const path = writtenPath(call)
      if (path !== null) this.turnFiles.add(path)
    } else if (result.prevented === true) {
      // Not counted as a failure: nothing went wrong, the harness stopped it.
      // The run of failures below still grows, because five refusals in a row
      // is a model going round in circles whatever refused it.
      this.tally.prevented += 1
      this.turnTally.prevented += 1
      this.turnPrevented.push({ tool: call.name, target: preventedTarget(call), reason: result.summary, at: Date.now() })
    } else {
      this.tally.failed += 1
      this.turnTally.failed += 1
    }
    this.failures = result.ok ? 0 : this.failures + 1
    // Debugging is mostly failures, so a run of them does not end the turn,
    // only says so.
    if (this.failures === FAILURE_NUDGE) {
      result.content = `${result.content ?? result.summary}\n\n[harness: ${this.failures} tool calls in a row have failed. Change approach, or tell the user what is blocking you.]`
    }

    this.bus.emit({ type: 'tool_result', sessionId: this.options.sessionId, callId: call.id, result, at: Date.now() })
    // The failure is stored as well as emitted, so a re-opened session shows a
    // refused tool as refused instead of as a successful call.
    this.messages.push({
      role: 'tool',
      content: result.content ?? result.summary,
      toolCallId: call.id,
      ...(result.ok ? {} : { failed: true }),
    })
  }

  /** One delta on its way to the window, with any key taken out of it. */
  private safe(text: string): string {
    return this.secrets.empty ? text : this.secrets.redact(text)
  }

  /**
   * A key out of whatever the tool said: a shell that echoes its own command
   * line, a config file read back, a curl that prints the request it made.
   */
  private scrub(result: ToolResult): ToolResult {
    if (this.secrets.empty) return result
    return {
      ...result,
      summary: this.secrets.redact(result.summary),
      ...(result.content === undefined ? {} : { content: this.secrets.redact(result.content) }),
    }
  }

  /**
   * The result of one call, or the harness's answer to a call it has already
   * answered twice. The refusal comes back as a tool result, so the model is
   * told which loop it is in and keeps the round to get out of it.
   */
  private async resultFor(call: ToolCall): Promise<ToolResult> {
    const key = `${call.name}\u0000${call.args}`
    this.repeat = key === this.repeat.key ? { key, count: this.repeat.count + 1 } : { key, count: 1 }

    if (this.repeat.count >= REPEAT_REFUSE) {
      const same = `this is call ${this.repeat.count} to ${call.name} with identical arguments; it was not run, because the answer is the one you already have. Do something different, or answer the user with what you know.`
      return { ok: false, summary: same, content: same, isError: true }
    }

    const tool = this.toolFor(call)
    if (tool === undefined) return { ok: false, summary: `unknown tool: ${call.name}` }
    return this.runWithArgs(tool, call.args)
  }

  private toolFor(call: ToolCall): Tool | undefined {
    return this.tools.find(t => t.input.name === call.name)
  }

  private async runWithArgs(tool: Tool, raw: string): Promise<ToolResult> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, summary: `invalid JSON args for ${tool.input.name}`, isError: true }
    }
    if (!isJsonObject(parsed)) {
      return { ok: false, summary: `args must be a JSON object for ${tool.input.name}`, isError: true }
    }
    // The one place a secret becomes itself again: the arguments of a call that
    // is about to run. Everything upstream holds `{{secret:name}}` and nothing
    // else, and a tool that only turns its arguments into text is upstream too.
    const args = tool.keepsPlaceholders === true ? parsed : (this.secrets.revealDeep(parsed) as Record<string, unknown>)
    try {
      return await tool.run(args, {
        cwd: this.options.cwd,
        access: this.access,
        ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
        ...(this.options.job === undefined ? {} : { job: this.options.job }),
      })
    } catch (err) {
      // A tool that threw rather than returned is still a tool failure, and the
      // loop needs a result either way. Without this the calls beside it have no
      // answer, and the next request carries tool calls nothing replied to.
      const message = `${tool.input.name} failed: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, summary: message, content: message, isError: true }
    }
  }

  private addUsage(u: TurnUsage): void {
    addInto(this.totalUsage, u)
    addInto(this.turnUsage, u)
  }
}

/** Overwrite a usage report with another, in place. */
function copyInto(target: TurnUsage, source: TurnUsage): void {
  target.input = source.input
  target.output = source.output
  target.cacheRead = source.cacheRead
  target.cacheWrite = source.cacheWrite
  target.reasoning = source.reasoning
}

/** Add one usage report into a running total, in place. */
function addInto(target: TurnUsage, delta: TurnUsage): void {
  target.input += delta.input
  target.output += delta.output
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
  target.reasoning += delta.reasoning
}