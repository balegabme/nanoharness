// doc: docs/harness/overview.md
import { EventBus } from './event-bus.js'
import { ProviderError, backoffFor, isContextOverflow, isRetryable, sleep } from './provider.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { Effort, ModelFacts } from './config.js'
import { costOf, moneyText } from './cost.js'
import { Calibration, KEEP_RATIO, buildLedger, estimateParts, partsTotal, reserveFor, toolTokens } from './context.js'
import type { Anchor } from './context.js'
import { FLAT_SYSTEM, SUMMARY_INSTRUCTION, flatInstruction, flatten, planCut, prunable, prunedText, wrapSummary } from './compaction.js'
import type { Cut } from './compaction.js'
import { workspaceGate } from './scope.js'
import type { AccessGate } from './scope.js'
import { emptyToolStats, emptyUsage } from './types.js'
import { ReadIndex } from './read-index.js'
import { SecretVault } from './secrets.js'
import type {
  ChatMessage,
  CompactionReason,
  CompactionRecord,
  ContextLedger,
  ImagePart,
  PreventedCall,
  SessionNote,
  ThinkingBlock,
  ToolCall,
  ToolInput,
  ToolResult,
  ToolStats,
  TurnRate,
  TurnUsage,
} from './types.js'
import type { SpawnHost } from './spawn.js'
import type { JobRegistry } from './jobs.js'
import type { HookVerdict, Hooks } from '../hooks/hooks.js'

/**
 * What a tool is handed instead of a bare cwd. `access` is the scope guard: a
 * tool asks it before touching a path, so no tool has to remember the rule and
 * none can forget it (see `scope.ts`).
 */
export interface ToolContext {
  cwd: string
  access: AccessGate
  /**
   * What this session has already looked at. `read` asks it whether a span is
   * already in the conversation; `edit` and `write` ask it whether the file
   * they are about to rewrite was ever read, and whether it has moved since.
   */
  reads: ReadIndex
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
const CLOSING_NOTE = 'I love you <3 - balega, creator of nanoharness'

/**
 * How many times Stop hooks may keep one turn going. A hook that refuses every
 * answer would otherwise hold the turn open for as long as the model keeps
 * replying.
 */
const STOP_CONTINUES = 3

/** What the model is told about a call the user's stop landed on before it ran. */
const NOT_RUN = 'stopped by the user before this ran'

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
 * How many times a summary is asked for before the flattened one is tried: the
 * first, and one more. A model that calls a tool or says nothing when told to
 * summarise rarely does better on a third go.
 */
const SUMMARY_ATTEMPTS = 2

/**
 * The share of the room a flattened history may take. It is made after the
 * provider refused a request the estimate said would fit, so the estimate has
 * just been shown to run low, and half leaves space for that and the answer.
 */
const FLAT_SHARE = 0.5

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
 * and `<1s` for a turn that came back before the first tick. Exported because
 * a subagent's card ends on the same line a turn does.
 */
export function elapsedText(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The files a turn changed, with a long list cut short. */
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
   * described this model, so the cost is left off the line and never guessed.
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
  /** Whether the session compacts on its own as the context fills. On when unset. */
  autoCompact?: boolean
  /** The most the user lets the context grow to, in tokens. The window alone when unset. */
  contextLimit?: number
  /** The estimator's correction from an earlier run of this session, so it does not start again at 1. */
  calibration?: number
  /** Compactions from an earlier run of this session, for the context panel. */
  compactions?: CompactionRecord[]
  /**
   * The keys the user pasted. The model holds placeholders for them; this is the
   * only object that can turn one back into a value, for tool arguments alone.
   */
  secrets?: SecretVault
  /** The user's hooks. A subagent gets the tool hooks alone; see `Hooks.forSubagent`. */
  hooks?: Hooks
}

/**
 * One turn as the usage log keeps it: what it spent, which parts of the
 * harness spent it, what that came to, and how long the model generated for.
 * The shares are inside `usage` and never added to it.
 */
export interface TurnSpend {
  usage: TurnUsage
  subagent: TurnUsage
  harness: TurnUsage
  /** Null where the model carried no prices, or the usage report was unreadable. */
  costUsd: number | null
  subagentCostUsd: number
  harnessCostUsd: number
  streamMs: number
}

/** What a compaction the user asked for did, and what its requests cost. */
export interface CompactSpend {
  compacted: boolean
  usage: TurnUsage
  /** At the session's model's prices. Null where it has none. */
  costUsd: number | null
}

export class Session {
  readonly bus: EventBus
  readonly access: AccessGate
  private readonly secrets: SecretVault
  private readonly messages: ChatMessage[] = []
  private readonly reads: ReadIndex
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
   * The part of `totalUsage` the harness spent on its own behalf and not on
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
   * The subagents' and the harness's shares of the turn in hand, and what the
   * second of them cost. The session-wide totals beside them cannot answer
   * "who spent this turn", which is what the usage log records and the cost
   * dashboard groups by.
   */
  private turnSubagentUsage = emptyUsage()
  private turnHarnessUsage = emptyUsage()
  private turnHarnessCostUsd = 0
  /** Generating time this turn, summed over its rounds, with no tool time in it. */
  private turnStreamMs = 0
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
  /**
   * What is known about the model. Starts as `options.facts` and changes when
   * settings are edited under a running session, which a price or a window
   * typed by hand should reach without the session being rebuilt.
   */
  private facts: ModelFacts | undefined
  private autoCompact: boolean
  private contextLimit: number | undefined
  /** The tool schemas by the estimator. The tool list is fixed for a session's life. */
  private readonly toolSize: number
  /** The last measured request, while it still describes what goes out. */
  private anchor: Anchor | null = null
  private readonly calibration: Calibration
  private readonly compactions: CompactionRecord[]
  /**
   * Automatic compaction ran and left the context over the threshold anyway,
   * because what is kept verbatim is that large on its own. Running it again
   * each round would pay for a summary every round and free nothing, so it
   * waits for the next turn, and a refusal from the provider is the backstop.
   */
  private compactionStuck = false
  /** True while `compact()` runs, which `stop()` treats differently from a turn. */
  private compactingByHand = false
  /** Where the current turn's user message is in `messages`, or -1 between turns. */
  private turnUser = -1
  /** How many times Stop hooks have kept the turn in hand going. */
  private stopContinues = 0

  constructor(
    readonly options: SessionOptions,
    private readonly provider: ChatProvider,
    private readonly tools: Tool[],
    bus?: EventBus,
  ) {
    this.bus = bus ?? new EventBus()
    this.access = options.access ?? workspaceGate(options.cwd)
    // A session rebuilt from stored messages inherits the reads it cannot see:
    // they are in the transcript the model reads and in no structure here.
    this.reads = new ReadIndex((options.history?.length ?? 0) > 0)
    this.secrets = options.secrets ?? new SecretVault()
    this.facts = options.facts
    this.autoCompact = options.autoCompact ?? true
    this.contextLimit = options.contextLimit
    this.calibration = new Calibration(options.calibration)
    this.toolSize = toolTokens(tools.map(t => t.input))
    this.compactions = (options.compactions ?? []).map(one => ({ ...one }))
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
    // Copied, because compaction marks messages in place and the caller's
    // array is not this session's to mark.
    for (const message of options.history ?? []) {
      if (message.role !== 'system') this.messages.push({ ...message })
    }
    // Turn numbers continue where the stored conversation left off, so the
    // usage log of a resumed session does not restart at 1. A summary and a
    // Stop hook's reply are sent as user messages and are not turns.
    this.turn = this.messages.filter(m => m.role === 'user' && m.summary !== true && m.hook !== true).length
  }

  /**
   * What the provider is sent: the system prompt, the live summary if there
   * is one, and every message not folded into a summary, with pruned tool
   * results in their shortened form. `messages` keeps everything, so this is
   * built fresh each time and the markers are the only thing compaction
   * writes.
   *
   * The summary goes first wherever it sits in `messages`, since it stands for
   * the start of the conversation. It keeps `summary: true`, which the wires
   * ignore and the estimator reads.
   */
  wireMessages(): ChatMessage[] {
    const [system, ...rest] = this.messages
    const out: ChatMessage[] = system === undefined ? [] : [{ role: 'system', content: system.content }]
    const summary = this.liveSummary()
    if (summary !== undefined) out.push({ role: 'user', content: wrapSummary(summary.content), summary: true })
    // A model known not to read images, which a session switched to one after
    // pictures were sent can be, is told they were there and not sent them.
    const blind = this.facts?.vision === false
    for (const m of rest) {
      if (m === summary || m.compacted === 'compacted') continue
      out.push(wireCopy(m, blind))
    }
    return out
  }

  /** The summary the wire view opens with, if a compaction has run. */
  private liveSummary(): ChatMessage | undefined {
    return this.messages.find(m => m.role === 'user' && m.summary === true && m.compacted === undefined)
  }

  /** How big the next request is and how close it is to the window. */
  get context(): ContextLedger {
    return buildLedger({
      messages: this.wireMessages(),
      tools: this.toolSize,
      anchor: this.anchor,
      factor: this.calibration.factor,
      model: this.options.model,
      window: this.facts?.context,
      limit: this.contextLimit,
      reserve: reserveFor(this.provider.declaredOutput?.(this.limits()), this.facts?.maxOutput),
      auto: this.autoCompact,
      compactions: this.compactions,
    })
  }

  private emitContext(): void {
    this.bus.emit({ type: 'context', sessionId: this.options.sessionId, ledger: this.context, at: Date.now() })
  }

  /**
   * New facts for the model, from a settings edit. The turn in flight uses them
   * from its next request, and so do this session's subagents.
   */
  setFacts(facts: ModelFacts | undefined): void {
    this.facts = facts
    this.options.spawn?.setFacts(facts)
    this.emitContext()
  }

  /** Turn automatic compaction on or off, for this session and its subagents. */
  setAutoCompact(on: boolean): void {
    this.autoCompact = on
    this.options.spawn?.setAutoCompact(on)
    this.emitContext()
  }

  /** Set or clear the user's limit on the context, for this session and its subagents. */
  setContextLimit(limit: number | undefined): void {
    this.contextLimit = limit
    this.options.spawn?.setContextLimit(limit)
    this.emitContext()
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
   * one. A compaction the user started is stopped alone: the background jobs
   * running beside it between turns were started by an earlier turn and are
   * not what the user is stopping.
   */
  stop(): void {
    if (!this.compactingByHand) this.options.spawn?.stopAll()
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

  /** The harness's own share of `spent`: approval checks and compaction summaries. */
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
    addInto(this.turnSubagentUsage, delta)
    this.emitUsage()
  }

  /**
   * Tokens the harness spent on a side-call of its own, an approval check or a
   * compaction summary, with what it cost at that model's prices. Null when nobody has priced the model:
   * an unpriced call adds its tokens and leaves the money alone.
   */
  addHarnessUsage(delta: TurnUsage, costUsd: number | null): void {
    this.addUsage(delta)
    addInto(this.harnessUsage, delta)
    addInto(this.turnHarnessUsage, delta)
    if (costUsd !== null) {
      this.harnessCostUsd += costUsd
      this.turnHarnessCostUsd += costUsd
    }
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

  /**
   * The last turn's rate, for a re-opened session to show. Subagent and
   * harness output came off streams `streamMs` did not time, so it is left out.
   */
  get lastRate(): TurnRate | undefined {
    const output = this.turnUsage.output - this.turnSubagentUsage.output - this.turnHarnessUsage.output
    if (output <= 0 || this.turnStreamMs <= 0) return undefined
    return { output, streamMs: this.turnStreamMs }
  }

  /**
   * The most recent `run()` alone, where `run()` returns the session total.
   * This is what the usage log records, so everything the cost dashboard
   * attributes a turn by is on it.
   */
  get lastTurn(): TurnSpend {
    return {
      usage: { ...this.turnUsage },
      subagent: { ...this.turnSubagentUsage },
      harness: { ...this.turnHarnessUsage },
      costUsd: this.turnCost(),
      subagentCostUsd: this.priced(this.turnSubagentUsage) ?? 0,
      harnessCostUsd: this.turnHarnessCostUsd,
      streamMs: this.turnStreamMs,
    }
  }

  /**
   * What the turn in hand cost. The conversation and its subagents are priced
   * at the model this session runs; the harness's side-calls come already
   * priced at the models that answered them, which are usually cheaper ones.
   *
   * Null where the session's model carries no prices, or where the provider
   * sent a usage report that could not be read: a turn nobody can price is not
   * a turn that cost nothing.
   */
  private turnCost(): number | null {
    const conversation = this.priced(subtract(this.turnUsage, this.turnHarnessUsage))
    return conversation === null ? null : conversation + this.turnHarnessCostUsd
  }

  /** `usage` at this session's model's prices, or null when it has none. */
  private priced(usage: TurnUsage): number | null {
    const facts = this.facts
    if (facts === undefined || this.turnUsageProblem) return null
    return costOf(usage, facts)
  }

  async run(userText: string, images: readonly ImagePart[] = []): Promise<TurnUsage> {
    // A compaction the user started is still rewriting the history this turn
    // would be appended to.
    if (this.running) throw new Error('this session is busy; wait for the turn or the compaction to finish')
    // Only a model known not to read images is refused. One nobody has
    // described is sent them, and the provider says whether it can.
    if (images.length > 0 && this.facts?.vision === false) {
      throw new Error(`${this.options.model} does not take images. Send the message without them, or switch to a model that reads images.`)
    }
    this.turn += 1
    this.turnUsage = emptyUsage()
    this.turnSubagentUsage = emptyUsage()
    this.turnHarnessUsage = emptyUsage()
    this.turnHarnessCostUsd = 0
    this.turnStreamMs = 0
    this.turnUsageProblem = false
    this.turnTally = emptyToolStats()
    this.turnPrevented = []
    this.turnFiles.clear()
    this.stopContinues = 0
    this.turnStartedAt = Date.now()
    this.stopped = false
    this.compactionStuck = false
    this.controller = new AbortController()
    const sessionId = this.options.sessionId
    this.bus.emit({ type: 'session.started', sessionId, cwd: this.options.cwd, at: Date.now() })
    // Anything a background job finished with between turns goes in first: it
    // happened before this message, and the model should read it that way.
    this.flushPending()
    this.turnUser = this.messages.length
    const asked: ChatMessage = { role: 'user', content: userText, ...(images.length === 0 ? {} : { images: [...images] }) }
    this.messages.push(asked)
    this.emitContext()

    try {
      return await this.runRounds(sessionId)
    } catch (err) {
      // A turn that failed before the model answered may have failed on the
      // pictures. Left on the message they would go out again with every later
      // request, and a provider that refused them once would refuse each one.
      if (asked.images !== undefined && !this.messages.slice(this.messages.indexOf(asked) + 1).some(m => m.role === 'assistant')) {
        delete asked.images
      }
      // A tool that threw can be quoting the arguments it was given, which by
      // then held the real value.
      const message = this.secrets.redact(err instanceof Error ? err.message : String(err))
      this.record('error', message)
      this.bus.emit({ type: 'session.error', sessionId, turn: this.turn, message, at: Date.now() })
      throw err
    } finally {
      this.controller = null
      this.turnUser = -1
      // What the turn came to, before anything else is folded in, so the line
      // lands under the turn it is about. Every way out of a turn passes here.
      // Priced from the model that actually ran it, which is why this is here
      // and not in the window: the window knows only what is selected now.
      // A turn whose usage nobody reported is not a turn that cost nothing, so
      // the cost is left off the line and never printed as $0.
      const counted = this.turnUsage.input + this.turnUsage.output + this.turnUsage.cacheRead + this.turnUsage.cacheWrite
      const spent = counted > 0 ? this.turnCost() : null
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
      // Before every request and not once a turn: a subagent's whole life is
      // one turn, and a main session running tools can reach the window in
      // the middle of one.
      await this.fitContext()
      const { text, toolCalls, usage, thinking, streamMs } = await this.drainRound()
      this.addUsage(usage)
      // A round the provider never timed adds nothing: the turn's rate is over
      // the stream this session held a clock on, not over the wall clock.
      if (streamMs !== undefined) this.turnStreamMs += streamMs
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
      this.emitContext()

      if (this.stopped) {
        // Whatever the model had already asked for still needs an answer, or the
        // next request carries tool calls nothing ever replied to.
        for (const call of toolCalls) this.noteSkipped(call)
        this.record('stopped', 'Stopped.')
        this.bus.emit({ type: 'session.stopped', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      if (toolCalls.length === 0) {
        if (await this.stopHookContinues(text)) continue
        // No answer, no error and nothing on screen is the one ending the user
        // cannot act on, so the turn says so.
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
      this.emitContext()

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
    // A refusal for length is answered once, by compacting harder. A second
    // one ends the turn, since whatever is left will not get any shorter.
    let rescued = false
    let attempt = 1
    for (;;) {
      // Stop pressed during a compaction before this request, or during the
      // rescue after the last one. An empty round is what an aborted stream
      // hands back, so the turn winds down as stopped.
      if (this.stopped) return { text: '', toolCalls: [], usage: carried, thinking: [], streamMs: 0 }
      const spent = emptyUsage()
      this.bus.emit({ type: 'round.started', sessionId, turn: this.turn, at: Date.now() })
      try {
        const round = await this.attemptRound(spent)
        // A fresh total and not a running one: `round.usage` is the object
        // the provider handed over, and the caller reads it again.
        const usage = emptyUsage()
        addInto(usage, round.usage)
        addInto(usage, carried)
        return { ...round, usage }
      } catch (err) {
        addInto(carried, spent)
        // The rescue is not a retry of the same bytes, so it spends no attempt.
        if (!this.stopped && !rescued && this.autoCompact && isContextOverflow(err)) {
          rescued = true
          if ((await this.rescue()) || this.stopped) continue
        }
        if (this.stopped || attempt >= ROUND_ATTEMPTS || !isRetryable(err)) throw err
        const why = this.secrets.redact(err instanceof Error ? err.message : String(err))
        const text = `The request failed (${why}). Asking again: attempt ${attempt + 1} of ${ROUND_ATTEMPTS}.`
        // Journalled without an event of its own, because `round.retry` is the
        // event and carries the same words. Replay reads it back from here.
        this.record('note', text)
        this.bus.emit({ type: 'round.retry', sessionId, turn: this.turn, attempt: attempt + 1, of: ROUND_ATTEMPTS, text, at: Date.now() })
        await sleep(backoffFor(err, attempt, BACKOFF_MS), this.controller?.signal)
        // Stop pressed during the wait. An empty round is what an aborted
        // stream hands back, so the loop winds down the way it knows and the
        // turn does not end as an error.
        if (this.stopped) return { text: '', toolCalls: [], usage: carried, thinking: [], streamMs: 0 }
        attempt += 1
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
    // Timed from the first chunk, not from the request, so the number is
    // generation speed without however long the request queued.
    let firstChunkAt = 0

    const messages = this.wireMessages()
    const estimated = partsTotal(estimateParts(messages, this.toolSize))
    const chunks = this.provider.stream(this.request(messages, this.tools.map(t => t.input)))

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
            else this.measured(chunk.usage, estimated)
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

  /** A request with this session's model, settings and stop button. */
  private request(messages: ChatMessage[], tools: ToolInput[]): ChatInput {
    return {
      model: this.options.model,
      messages,
      tools,
      conversationId: this.options.sessionId,
      ...this.limits(),
      ...(this.controller === null ? {} : { signal: this.controller.signal }),
    }
  }

  /** The effort and output ceiling every request of this session carries. */
  private limits(): Pick<ChatInput, 'effort' | 'maxTokens'> {
    return {
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.facts?.maxOutput === undefined ? {} : { maxTokens: this.facts.maxOutput }),
    }
  }

  /**
   * A response said how big its prompt was. That becomes the anchor, and the
   * pair of figures moves the calibration. A report of zero is a server that
   * sends no usage, and is no measurement.
   */
  private measured(usage: TurnUsage, estimated: number): void {
    const reported = usage.input + usage.cacheRead + usage.cacheWrite
    if (reported <= 0) return
    this.calibration.sample(reported, estimated)
    this.anchor = { reported, estimated }
  }

  /**
   * Compact now, between turns, because the user asked. `compacted` is false
   * when there was nothing to compact, the summary could not be made or the
   * user stopped it, and the session's notes say which. It is also false while
   * a turn runs, with no note, since the window offers no way to ask then and
   * the turn checks the context before every request anyway. The spend is the
   * summary requests alone, for the usage log, which has no turn to put them
   * under.
   */
  async compact(): Promise<CompactSpend> {
    if (this.running) return { compacted: false, usage: emptyUsage(), costUsd: null }
    const before = { ...this.harnessUsage }
    const cost = this.harnessCostUsd
    this.stopped = false
    this.controller = new AbortController()
    this.compactingByHand = true
    try {
      const compacted = await this.summarise('manual')
      const usage = subtract(this.harnessUsage, before)
      const priced = this.facts !== undefined && costOf(usage, this.facts) !== null
      return { compacted, usage, costUsd: priced ? this.harnessCostUsd - cost : null }
    } finally {
      this.controller = null
      this.compactingByHand = false
      this.flushPending()
    }
  }

  /**
   * The check before each request. Past the threshold the conversation is
   * summarised through the cache. Past the usable space the summary request
   * would not fit either, so tool results are pruned first and the history is
   * summarised flat if that is not enough. Whatever happens here the round
   * goes ahead, and the provider's answer settles whether it fitted.
   */
  private async fitContext(): Promise<void> {
    if (!this.autoCompact || this.compactionStuck || this.stopped) return
    const ledger = this.context
    if (ledger.threshold === null || ledger.usable === null || ledger.tokens <= ledger.threshold) return
    if (ledger.tokens <= ledger.usable) await this.summarise('auto')
    else await this.shrink('auto', ledger.tokens)
    const after = this.context
    if (after.threshold !== null && after.tokens > after.threshold) this.compactionStuck = true
  }

  /**
   * The provider refused the request as too long. The estimate put it under
   * the window, so the estimate is raised to meet what the refusal proves, and
   * the history is shrunk without the cache, which a request that long cannot
   * be read through. True when something was shrunk and the round is worth
   * asking for again.
   */
  private async rescue(): Promise<boolean> {
    const refused = partsTotal(estimateParts(this.wireMessages(), this.toolSize))
    // Against the window and never the user's limit: a limit above a window
    // nobody has stated would raise the factor past what the refusal proves.
    const { window, reserve } = this.context
    this.anchor = null
    if (window !== null && window > reserve) this.calibration.atLeast(window - reserve, refused)
    return this.shrink('overflow', this.context.tokens)
  }

  /**
   * Prune every long tool result, the newest included, and summarise the
   * flattened history when that is not enough. The newest is included
   * because a single oversized output in the last round is the likeliest
   * reason a request stopped fitting, and the cache this would keep is
   * already lost.
   */
  private async shrink(reason: CompactionReason, before: number): Promise<boolean> {
    this.bus.emit({ type: 'context.compacting', sessionId: this.options.sessionId, reason, at: Date.now() })
    const pruned: string[] = []
    for (const m of this.messages) {
      if (m.role !== 'tool' || !prunable(m)) continue
      m.compacted = 'pruned'
      pruned.push(m.toolCallId)
    }
    const ledger = this.context
    // With no window there is no size to aim under, so pruning that found
    // nothing to prune is the only sign the flattened summary is needed.
    const over = ledger.threshold === null ? pruned.length === 0 : ledger.tokens > ledger.threshold
    const cut = over ? this.cutFor(ledger) : null
    const summary = cut === null ? null : await this.flatSummary(cut, ledger)
    if (cut !== null && summary !== null) this.applySummary(cut, summary)
    const compacted = summary === null || cut === null ? 0 : cut.compacted.length
    if (pruned.length === 0 && compacted === 0) {
      if (!this.stopped) this.note('The context could not be made smaller: there was no long tool output to shorten and nothing old enough to summarise.')
      return false
    }
    this.compacted(reason, before, compacted, pruned, summary ?? undefined)
    return true
  }

  /**
   * Summarise through the cache, then flat if the model will not do it that
   * way. True when a summary went in.
   */
  private async summarise(reason: CompactionReason): Promise<boolean> {
    const ledger = this.context
    const cut = this.cutFor(ledger)
    if (cut === null) {
      if (reason === 'manual') this.note('There is nothing to compact yet: the whole conversation fits in the part that is kept verbatim.')
      return false
    }
    this.bus.emit({ type: 'context.compacting', sessionId: this.options.sessionId, reason, at: Date.now() })
    const summary = (await this.cachedSummary()) ?? (this.stopped ? null : await this.flatSummary(cut, ledger))
    if (summary === null) {
      // A stopped turn says so itself. A stopped compaction by hand has no
      // turn to say it.
      if (!this.stopped) this.note('The context could not be compacted: the model did not write a summary. The conversation carries on as it was.')
      else if (reason === 'manual') this.note('Compaction stopped. The conversation carries on as it was.')
      return false
    }
    this.applySummary(cut, summary)
    this.compacted(reason, ledger.tokens, cut.compacted.length, [], summary)
    return true
  }

  /**
   * Where this compaction cuts. The kept tail is a share of the window, or of
   * the context itself where the window is unknown, which only a manual
   * compaction or a refusal gets to.
   */
  private cutFor(ledger: ContextLedger): Cut | null {
    const keep = KEEP_RATIO * (ledger.room ?? ledger.tokens)
    return planCut(this.messages, keep, this.calibration.factor, this.turnUser)
  }

  /**
   * The request the session would send next, with the instruction on the end.
   * Every byte before the instruction is the prefix the provider has cached,
   * so the conversation is read at the cached rate.
   */
  private async cachedSummary(): Promise<string | null> {
    for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS && !this.stopped; attempt += 1) {
      const messages: ChatMessage[] = [...this.wireMessages(), { role: 'user', content: SUMMARY_INSTRUCTION }]
      const estimated = partsTotal(estimateParts(messages, this.toolSize))
      const answer = await this.ask(this.request(messages, this.tools.map(t => t.input)))
      if (answer === null) continue
      if (answer.usageRead) this.calibration.sample(answer.usage.input + answer.usage.cacheRead + answer.usage.cacheWrite, estimated)
      if (answer.toolCalls === 0 && answer.text !== '') return answer.text
    }
    return null
  }

  /**
   * The history being folded away, as plain text, summarised with no tools and
   * none of the session's own prompt. It reads nothing from the cache and needs
   * nothing from the model beyond writing text.
   */
  private async flatSummary(cut: Cut, ledger: ContextLedger): Promise<string | null> {
    if (this.stopped) return null
    const earlier = this.liveSummary()
    const folded = cut.compacted.map(i => this.messages[i]).filter((m): m is ChatMessage => m !== undefined)
    const budget = (FLAT_SHARE * (ledger.usable ?? ledger.tokens)) / this.calibration.factor
    const history = flatten(folded, budget, earlier)
    const answer = await this.ask(
      this.request(
        [
          { role: 'system', content: FLAT_SYSTEM },
          { role: 'user', content: flatInstruction(history) },
        ],
        [],
      ),
    )
    return answer === null || answer.toolCalls > 0 || answer.text === '' ? null : answer.text
  }

  /**
   * One side request, billed to the harness. Its stream reaches nobody: the
   * summary is shown once it is whole. Null when the request failed, which
   * the caller answers with its next way of getting a summary.
   */
  private async ask(input: ChatInput): Promise<{ text: string; toolCalls: number; usage: TurnUsage; usageRead: boolean } | null> {
    let text = ''
    let toolCalls = 0
    const spent = emptyUsage()
    let usageRead = true
    let failed = false
    try {
      for await (const chunk of this.provider.stream(input)) {
        if (chunk.kind === 'text') text += chunk.text
        else if (chunk.kind === 'tool') toolCalls += 1
        else if (chunk.kind === 'usage') copyInto(spent, chunk.usage)
        else if (chunk.kind === 'done') {
          copyInto(spent, chunk.usage)
          if (chunk.usageProblem !== undefined) usageRead = false
        } else if (chunk.kind === 'error') throw new ProviderError(chunk.message, chunk.status)
      }
    } catch (err) {
      failed = true
      if (!this.stopped) this.note(`A summary request failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.addHarnessUsage(spent, this.facts === undefined ? null : costOf(spent, this.facts))
    return failed || this.stopped ? null : { text: this.safe(text.trim()), toolCalls, usage: spent, usageRead }
  }

  /** Fold the cut messages into the summary. The old summary, if any, goes with them. */
  private applySummary(cut: Cut, summary: string): void {
    const earlier = this.liveSummary()
    if (earlier !== undefined) earlier.compacted = 'compacted'
    for (const i of cut.compacted) {
      const m = this.messages[i]
      if (m !== undefined) m.compacted = 'compacted'
    }
    // Appended where the compaction happened, so the window draws it at the
    // point in the conversation where it took effect. `wireMessages` sends it
    // first either way.
    this.messages.push({ role: 'user', content: summary, summary: true })
  }

  /**
   * What any compaction ends with. The anchor described a history that no
   * longer goes out, and the read index may be pointing at lines that went
   * into the summary, so both are dropped.
   */
  private compacted(reason: CompactionReason, before: number, compacted: number, pruned: string[], summary?: string): void {
    this.anchor = null
    this.reads.dropSpans()
    const after = this.context.tokens
    const at = Date.now()
    this.compactions.push({ at, reason, before, after })
    this.bus.emit({
      type: 'context.compacted',
      sessionId: this.options.sessionId,
      reason,
      before,
      after,
      compacted,
      pruned,
      ...(summary === undefined ? {} : { summary }),
      at,
    })
    const how = HOW[reason]
    const what = [
      compacted > 0 ? `${compacted} message${compacted === 1 ? '' : 's'} summarised` : '',
      pruned.length > 0 ? `${pruned.length} tool result${pruned.length === 1 ? '' : 's'} shortened` : '',
    ].filter(part => part !== '')
    this.note(`${how}: ${what.join(', ')}, context ${tokensText(before)} to ${tokensText(after)} tokens.`)
    this.emitContext()
  }

  /** A tool call the stop landed on top of. The model is told it never ran. */
  private noteSkipped(call: ToolCall): void {
    const note = NOT_RUN
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
    const hooks = this.options.hooks
    return hooks === undefined ? this.runWithArgs(tool, call.args) : this.hookedRun(tool, call, hooks)
  }

  /**
   * One call with the user's tool hooks around it. The hooks see the arguments
   * as the model wrote them, placeholders and all, and a result with any key
   * already taken out. A PreToolUse refusal stops the call before the
   * permission gate is asked and counts as prevented. What the hooks have to
   * say goes on the end of the result, where the model reads it next.
   */
  private async hookedRun(tool: Tool, call: ToolCall, hooks: Hooks): Promise<ToolResult> {
    const sessionId = this.options.sessionId
    const args = hookArgs(call.args)
    const on = { tool: call.name, ...this.hookSignal() }
    const before = await hooks.run('PreToolUse', sessionId, { tool: call.name, args }, on)
    this.noteHookProblems(before)
    // Stopped while the hook ran, so the call is one the stop landed on.
    if (this.stopped) return { ok: false, summary: NOT_RUN, content: NOT_RUN, isError: true }
    if (before.block !== null) {
      const refused = `a PreToolUse hook refused this call: ${before.block}`
      return { ok: false, summary: refused, content: refused, isError: true, prevented: true }
    }
    const result = this.scrub(await this.runWithArgs(tool, call.args))
    const output = result.content ?? result.summary
    const after = await hooks.run('PostToolUse', sessionId, { tool: call.name, args, result: { ok: result.ok, output } }, on)
    this.noteHookProblems(after)
    const added = [
      ...before.context.map(text => `[PreToolUse hook]\n${text}`),
      ...after.context.map(text => `[PostToolUse hook]\n${text}`),
      ...(after.block === null ? [] : [`[PostToolUse hook]\n${after.block}`]),
    ]
    return added.length === 0 ? result : { ...result, content: [output, ...added].join('\n\n') }
  }

  /**
   * Run the Stop hooks on the answer the turn is about to end with. A refusal
   * goes back to the model as a message of its own, marked as the hook's and
   * not the user's, and the turn carries on. True when it does.
   *
   * The window hears the refusal as a note. It is not written to the journal,
   * because the message itself is in the transcript and is drawn as that note
   * when the session is opened again.
   */
  private async stopHookContinues(answer: string): Promise<boolean> {
    const hooks = this.options.hooks
    if (hooks === undefined || !hooks.has('Stop')) return false
    const verdict = await hooks.run('Stop', this.options.sessionId, { answer, continued: this.stopContinues }, this.hookSignal())
    // Stopped while the hook ran: the turn ends as stopped, not as refused.
    if (this.stopped) return false
    this.noteHookProblems(verdict)
    if (verdict.block === null) return false
    const reason = this.safe(verdict.block)
    if (this.stopContinues >= STOP_CONTINUES) {
      this.note(`A Stop hook refused the answer again, after keeping this turn going ${STOP_CONTINUES} times. The turn ends here anyway. It said: ${reason}`)
      return false
    }
    this.stopContinues += 1
    const text = `A Stop hook did not let the turn end yet. It said:\n${reason}`
    this.messages.push({ role: 'user', content: text, hook: true })
    this.bus.emit({ type: 'session.note', sessionId: this.options.sessionId, turn: this.turn, text, at: Date.now() })
    this.emitContext()
    return true
  }

  /** The turn's signal, so Stop reaches a hook that is running. */
  private hookSignal(): { signal?: AbortSignal } {
    return this.controller === null ? {} : { signal: this.controller.signal }
  }

  private noteHookProblems(verdict: HookVerdict): void {
    for (const problem of verdict.problems) this.note(problem)
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
        reads: this.reads,
        ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
        ...(this.options.job === undefined ? {} : { job: this.options.job }),
      })
    } catch (err) {
      // A tool that threw is still a tool failure, and the loop needs a result
      // either way. Without this the calls beside it have no answer, and the
      // next request carries tool calls nothing replied to.
      const message = `${tool.input.name} failed: ${err instanceof Error ? err.message : String(err)}`
      return { ok: false, summary: message, content: message, isError: true }
    }
  }

  private addUsage(u: TurnUsage): void {
    addInto(this.totalUsage, u)
    addInto(this.turnUsage, u)
  }
}

/**
 * A call's arguments as a hook reads them: the object the model wrote, or the
 * text itself when it is not JSON, so a hook can still see what was asked.
 */
function hookArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** How the note after a compaction starts, by what set it off. */
const HOW: Record<CompactionReason, string> = {
  auto: 'Compacted automatically',
  manual: 'Compacted on request',
  overflow: 'Compacted after the provider refused the request as too long',
}

/**
 * A message as the wire gets it: markers off, a pruned result shortened, and
 * with `blind` set, each picture swapped for a line saying one was sent.
 */
function wireCopy(m: ChatMessage, blind: boolean): ChatMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.compacted === 'pruned' ? prunedText(m.content) : m.content,
      toolCallId: m.toolCallId,
      ...(m.failed === true ? { failed: true } : {}),
    }
  }
  const images = m.images?.length ?? 0
  if (blind && images > 0) {
    const line = `[harness: the user sent ${images === 1 ? 'an image' : `${images} images`} here, left out because this model does not take images]`
    return { role: m.role, content: m.content === '' ? line : `${m.content}\n\n${line}` }
  }
  return {
    role: m.role,
    content: m.content,
    ...(m.images === undefined ? {} : { images: m.images }),
    ...(m.toolCalls === undefined ? {} : { toolCalls: m.toolCalls }),
    ...(m.thinking === undefined ? {} : { thinking: m.thinking }),
  }
}

/** A token count for a sentence: `152k` from ten thousand up, the plain number below. */
function tokensText(tokens: number): string {
  return tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : tokens.toLocaleString('en-US')
}

/** Overwrite a usage report with another, in place. */
function copyInto(target: TurnUsage, source: TurnUsage): void {
  target.input = source.input
  target.output = source.output
  target.cacheRead = source.cacheRead
  target.cacheWrite = source.cacheWrite
  target.reasoning = source.reasoning
}

/** A usage report with one of its shares taken out. */
function subtract(total: TurnUsage, share: TurnUsage): TurnUsage {
  return {
    input: total.input - share.input,
    output: total.output - share.output,
    cacheRead: total.cacheRead - share.cacheRead,
    cacheWrite: total.cacheWrite - share.cacheWrite,
    reasoning: total.reasoning - share.reasoning,
  }
}

/** Add one usage report into a running total, in place. */
function addInto(target: TurnUsage, delta: TurnUsage): void {
  target.input += delta.input
  target.output += delta.output
  target.cacheRead += delta.cacheRead
  target.cacheWrite += delta.cacheWrite
  target.reasoning += delta.reasoning
}