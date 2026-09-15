// doc: docs/harness/overview.md
import { EventBus } from './event-bus.js'
import { ProviderError, RETRY_AFTER_CAP_MS, isRetryable } from './provider.js'
import type { ChatProvider } from './provider.js'
import type { Effort } from './config.js'
import { workspaceGate } from './scope.js'
import type { AccessGate } from './scope.js'
import { emptyToolStats, emptyUsage } from './types.js'
import { SecretVault } from './secrets.js'
import type { ChatMessage, SessionNote, ThinkingBlock, ToolCall, ToolInput, ToolResult, ToolStats, TurnUsage } from './types.js'
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
   * True for a tool that only reads. The loop may then run it at the same time
   * as another call from the same assistant message. Only an explicit true
   * opts in: a tool that says nothing runs alone, so a new write tool is
   * exclusive by default.
   */
  parallel?: boolean
  /**
   * True for a tool whose arguments must reach it exactly as the model wrote
   * them, `{{secret:name}}` and all. Every other tool gets the real values
   * substituted in (`SecretVault.revealDeep`), because a tool is where a key is
   * finally used. `spawn` and `job_update` never use their arguments; they turn
   * them into text: a subagent's first message, a note in the window, a line in
   * a transcript. Filling those in would put the key back on the wire and back
   * on disk, which is the whole thing this avoids.
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
 * The tool loop is not capped. A cap is a harness deciding that a long task is
 * a bug, and it fails badly: the turn ends mid-investigation, with no answer
 * and nothing on screen to say why.
 *
 * A model going in circles is detectable on its own terms: the *same* tool with
 * the *same* arguments, over and over. The third identical call is not run,
 * since the answer would be the answer it already has, and the model is told
 * so. If it keeps asking after that, the turn ends with a note saying exactly
 * this happened.
 */
const REPEAT_REFUSE = 3
const REPEAT_ABORT = 6

/** Failures in a row after which the model is told it is thrashing. Not a stop. */
const FAILURE_NUDGE = 5

/**
 * How many times one round is asked for before the turn gives up.
 *
 * A provider that answers 429 or drops the socket has said nothing about the
 * conversation, so the same request is worth making again. Five attempts covers
 * a rate limit that clears and a gateway that restarts; past that the fault is
 * not going away on its own and the user should be told rather than watched
 * over for another minute.
 */
const ROUND_ATTEMPTS = 5

/** Waits between attempts, in milliseconds. One entry per gap, so four. */
const BACKOFF_MS = [500, 1500, 4000, 8000]

/**
 * How long to wait before attempt number `attempt + 1`.
 *
 * A provider that sent `Retry-After` is answered on its own terms, capped so a
 * header asking for an hour does not hang the turn on one. Otherwise the
 * schedule above applies, spread over a random part of the last quarter: five
 * windows all retrying on the same 500ms tick is the same thundering herd that
 * rate-limited them, and the spread is what breaks the lockstep (plan §11).
 */
function backoffFor(err: unknown, attempt: number): number {
  const asked = err instanceof ProviderError ? err.retryAfterMs : undefined
  if (asked !== undefined) return Math.min(asked, RETRY_AFTER_CAP_MS)
  const base = BACKOFF_MS[attempt - 1] ?? 8000
  return Math.round(base * (0.75 + Math.random() * 0.25))
}

export interface SessionOptions {
  sessionId: string
  cwd: string
  model: string
  systemPrompt: string
  effort?: Effort
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
  /**
   * The keys the user pasted. The model holds placeholders for them; this is
   * the only object that can turn one back into a value, and it does so for
   * tool arguments alone. Left out, nothing is substituted and nothing is
   * redacted, which is the right behaviour for a session with no secrets.
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
   * already recorded. Said once: a provider that does this does it every turn,
   * and it is the same fact each time.
   */
  private usageProblemNoted = false
  private totalUsage = emptyUsage()
  private turnUsage = emptyUsage()
  /**
   * The part of `totalUsage` that subagents spent. Kept apart because a turn
   * that delegates can spend fifty thousand tokens without this session
   * generating more than a paragraph, and one number cannot say that.
   */
  private subagentUsage: TurnUsage = emptyUsage()
  /** What this session's own tool calls came to, for whoever started it. */
  private readonly tally = emptyToolStats()
  // Stop is cooperative: the in-flight request is aborted and the loop ends at
  // the next boundary, leaving the transcript in a shape the model can be
  // asked to continue from.
  private controller: AbortController | null = null
  private stopped = false
  /**
   * Answers from background subagents that have not been folded into the
   * conversation yet. They arrive whenever the job happens to finish, which is
   * usually in the middle of something: a message pushed between a tool call
   * and its result is a request both providers refuse. So they wait here for a
   * point where the transcript is balanced.
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
    // A resumed session keeps its running total: the turns it is resuming from
    // were paid for, and a counter that restarts at zero says they were not.
    // A stored total whose `input` counted the cached tokens keeps that overlap
    // for the life of the session. It cannot be repaired: the figure does not
    // say which wire produced it, and an Anthropic one was always correct. The
    // alternative would be discarding a real number to avoid an approximate
    // one. `usage-log.ts` drops old lines instead, because it adds totals
    // across sessions.
    this.totalUsage = { ...(options.usage ?? emptyUsage()) }
    // Seeded beside the total it is part of. Left at zero, the first usage
    // event of a rebuilt session would report that subagents had spent nothing
    // and the next turn would write that over the stored breakdown.
    this.subagentUsage = { ...(options.subagentUsage ?? emptyUsage()) }
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
   * The harness failed at its own job around the turn. A tool reporting a bad
   * result is ordinary and goes through `note`.
   *
   * A note is drawn in the margin voice and read as commentary, which is too
   * quiet for this. A fault is drawn as an error, in the flow where the user is
   * already looking, and recorded as one so a re-opened session shows it the
   * same way, without a click.
   */
  fault(text: string): void {
    const safe = this.secrets.redact(text)
    this.record('error', safe)
    this.bus.emit({ type: 'session.error', sessionId: this.options.sessionId, turn: this.turn, message: safe, at: Date.now() })
  }

  /**
   * The provider sent a usage report that could not be read, so this turn's
   * cost is unknown. Nothing is invented to cover the gap and the answer the
   * user already paid for is kept; the one thing that is wrong is said out
   * loud, once.
   */
  private noteUsageProblem(problem: string): void {
    if (this.usageProblemNoted) return
    this.usageProblemNoted = true
    this.fault(`the provider's usage report could not be read (${problem}); this turn's cost is unknown`)
  }

  /**
   * Something the conversation should carry on from, arriving from outside the
   * turn: the answer a background subagent finished with.
   *
   * It is queued, then folded in at the next point where the transcript is
   * balanced: the top of a turn, or the end of a round. A background answer
   * that lands mid-round therefore reaches the model in that same turn, which
   * is what lets an agent start three jobs and use all three.
   */
  deliver(text: string): void {
    this.pending.push(text)
    // With no turn in flight there is no unanswered tool call to land in the
    // middle of, so it goes straight in. Queueing it here would strand it:
    // between turns nothing is coming that would drain the queue. The caller
    // stores the transcript after this, so an answer that arrives while the
    // user is away survives the app closing.
    if (!this.running) this.flushPending()
  }

  /**
   * Fold anything queued straight in, because there is no next round to fold
   * it at: the process is ending. A queued answer left here would be lost,
   * since the transcript written a moment later is what survives.
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
  private record(kind: SessionNote['kind'], text: string): void {
    // The journal is written to disk, so it is a boundary like any other: an
    // error quoting a request, or a note quoting a subagent, goes through the
    // same scrub a tool result does.
    this.journal.push({ kind, text: this.secrets.redact(text), turn: this.turn, after: this.transcript.length, at: Date.now() })
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
   *
   * Subagents go with it. A subagent is this session spending money under
   * another name, and nothing else in the app can ever end a background one, so
   * a stop that left them running would stop the part the user can see and none
   * of the part they are paying for.
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

  /** How many tool calls this session made, and how they went. */
  get toolStats(): ToolStats {
    return { ...this.tally }
  }

  /**
   * Tokens a subagent of this session spent. A subagent is billed to whoever
   * started it, so its usage lands in the same total and leaves by the same
   * event, which is what puts a spawn's cost in the window's counter while the
   * spawn is still running.
   *
   * The event carries no `streamMs`. The spawn's tokens came off a stream this
   * session never timed, and it was very likely generating at the same moment,
   * so there is no interval the two of them share. `src/renderer/metrics.ts` is
   * where an event without one is absorbed.
   */
  addSubagentUsage(delta: TurnUsage): void {
    this.addUsage(delta)
    addInto(this.subagentUsage, delta)
    this.bus.emit({
      type: 'usage',
      sessionId: this.options.sessionId,
      turn: this.turn,
      usage: { ...this.totalUsage },
      subagent: { ...this.subagentUsage },
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
      // A job that finished during the last round of the turn queued its answer
      // and then found no round left to be folded into. The transcript is
      // balanced here on every path out, and the caller writes it immediately
      // after, so this is the last chance to keep it.
      this.flushPending()
    }
  }

  /**
   * Rounds until the model stops asking for tools. There is no round budget: a
   * task that needs forty calls gets forty, and the user has the running cost in
   * the window and the stop button if that is not what they wanted.
   */
  private async runRounds(sessionId: string): Promise<TurnUsage> {
    this.repeat = { key: '', count: 0 }
    this.failures = 0

    for (;;) {
      const { text, toolCalls, usage, thinking, streamMs } = await this.drainRound()
      this.addUsage(usage)
      this.bus.emit({
        type: 'usage',
        sessionId,
        turn: this.turn,
        usage: { ...this.totalUsage },
        subagent: { ...this.subagentUsage },
        streamMs,
        at: Date.now(),
      })

      // An assistant message with no text, no tool calls and no thinking draws
      // a blank in the window, and some providers refuse to take it back. The
      // round is still over, which the code below handles; nothing is written
      // down for it.
      if (text !== '' || toolCalls.length > 0 || thinking.length > 0) {
        this.messages.push({
          role: 'assistant',
          // The model's own words go through the same scrub a tool result does.
          // Everything it reads is redacted first, so it should never hold a
          // key, and "should never" is not a boundary. This is where the whole
          // string exists, so a value split across two deltas is caught here.
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
        // A turn that ends with nothing to show is the failure the user reads as
        // "it gave up": no answer, no error, nothing on screen. Say so.
        if (text.trim() === '') this.note('The turn ended without an answer. Send that again, or ask for what is missing.')
        this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      // Calls run together where the tools say it is safe, and in the model's
      // order either way. A batch of reads costs one wait instead of one per
      // file; a write still runs alone, because the next call in the message
      // may be about the file it just changed.
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
   * A retry throws away whatever the failed attempt had already streamed, which
   * is why the window is told: half an answer left on screen under a second,
   * different answer is worse than no answer at all. What the attempt was
   * charged for is kept, though, and carried into the round that eventually
   * succeeds, since a counter that showed only the attempt that worked would
   * under-report every rate-limited turn.
   *
   * That count is whatever the wire reported before it broke. Anthropic sends
   * the prompt's cost at `message_start`, which arrives as a `usage` chunk; an
   * OpenAI-compatible stream reports at the end, so an attempt that never got
   * there carries nothing and there is nothing to carry.
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
        await this.pause(backoffFor(err, attempt))
        // Stop pressed during the wait. Another attempt would spend the
        // person's money on an answer they have already said they do not want,
        // and rethrowing would end the turn as an error rather than as the stop
        // it was. An empty round is what an aborted stream hands back, so the
        // loop winds down the one way it knows.
        if (this.stopped) return { text: '', toolCalls: [], usage: carried, thinking: [], streamMs: 0 }
      }
    }
  }

  /** Wait between attempts, cut short if the person presses Stop. */
  private async pause(ms: number): Promise<void> {
    const signal = this.controller?.signal
    if (signal?.aborted === true) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
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
    // Timed from the first chunk rather than from the request, so the number
    // is generation speed and not generation speed plus however long the
    // provider queued. Tool calls run after this returns, so their time is
    // outside it either way.
    let firstChunkAt = 0

    const chunks = this.provider.stream({
      model: this.options.model,
      messages: this.messages,
      tools: this.tools.map(t => t.input),
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
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
            // that is written down. A signed block is left exactly as the
            // provider signed it: editing it invalidates the signature, and it
            // is the one thing that has to go back on the wire byte for byte.
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
    if (result.ok) this.tally.ok += 1
    else this.tally.failed += 1
    this.failures = result.ok ? 0 : this.failures + 1
    // Debugging is mostly failures, so a run of them does not end the turn. It
    // is still worth saying out loud, because a model that cannot see the
    // pattern will keep going the same way.
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
   * A key out of whatever the tool said. A shell that echoes its own command
   * line, a config file read back, a curl that prints the request it made:
   * each would otherwise put the value the model must not see straight into
   * the conversation, and from there into the stored transcript.
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
    // is about to run. Everything upstream of here holds `{{secret:name}}` and
    // nothing else, the transcript and the request and the window alike, and a
    // tool that only turns its arguments back into text is upstream too.
    const args = tool.keepsPlaceholders === true ? parsed : (this.secrets.revealDeep(parsed) as Record<string, unknown>)
    try {
      return await tool.run(args, {
        cwd: this.options.cwd,
        access: this.access,
        ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
        ...(this.options.job === undefined ? {} : { job: this.options.job }),
      })
    } catch (err) {
      // A tool that threw rather than returned is a tool failure, and the loop
      // needs a result either way. Without this, one rejected promise loses the
      // whole message: the calls beside it have no answer, and the next request
      // carries an assistant turn with tool calls nothing ever replied to,
      // which both providers reject. `scrub` redacts what the error quotes.
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