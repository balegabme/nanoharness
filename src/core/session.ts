// doc: docs/harness/overview.md
import { EventBus } from './event-bus.js'
import type { ChatProvider } from './provider.js'
import type { Effort } from './config.js'
import { workspaceGate } from './scope.js'
import type { AccessGate } from './scope.js'
import { emptyUsage } from './types.js'
import type { ChatMessage, SessionNote, ThinkingBlock, ToolCall, ToolInput, ToolResult, TurnUsage } from './types.js'
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
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

export type ArgsParse<A> = { ok: true; args: A } | { ok: false; error: string }

export interface ToolSpec<A> {
  input: ToolInput
  parse(args: Record<string, unknown>): ArgsParse<A>
  run(args: A, ctx: ToolContext): Promise<ToolResult>
}

// Tool args arrive as untrusted wire JSON, so the stored Tool keeps an erased
// arg type. defineTool validates once at that boundary; the spec's run() then
// works with a real type instead of casting field by field.
export function defineTool<A>(spec: ToolSpec<A>): Tool {
  return {
    input: spec.input,
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
 * a bug, and the failure it produces is the worst one there is: a turn that
 * ends mid-investigation, with no answer and nothing on screen to say why.
 *
 * What is caught instead is a model going in circles, which is a different
 * thing and is detectable: the *same* tool with the *same* arguments, over and
 * over. The third identical call is not run — the answer would be the answer it
 * already has — and the model is told so; if it keeps asking after that, the
 * turn ends with a note that says exactly this happened.
 */
const REPEAT_REFUSE = 3
const REPEAT_ABORT = 6

/** Failures in a row after which the model is told it is thrashing. Not a stop. */
const FAILURE_NUDGE = 5

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
}

export class Session {
  readonly bus: EventBus
  readonly access: AccessGate
  private readonly messages: ChatMessage[] = []
  private readonly journal: SessionNote[] = []
  private turn = 0
  /** The last tool call and how many times in a row it has been asked for. */
  private repeat: { key: string; count: number } = { key: '', count: 0 }
  private failures = 0
  private totalUsage = emptyUsage()
  private turnUsage = emptyUsage()
  // Stop is cooperative: the in-flight request is aborted and the loop ends at
  // the next boundary, leaving the transcript in a shape the model can be
  // asked to continue from.
  private controller: AbortController | null = null
  private stopped = false

  constructor(
    readonly options: SessionOptions,
    private readonly provider: ChatProvider,
    private readonly tools: Tool[],
    bus?: EventBus,
  ) {
    this.bus = bus ?? new EventBus()
    this.access = options.access ?? workspaceGate(options.cwd)
    this.messages.push({ role: 'system', content: options.systemPrompt })
    // A resumed session keeps its running total: the turns it is resuming from
    // were paid for, and a counter that restarts at zero says they were not.
    this.totalUsage = { ...(options.usage ?? emptyUsage()) }
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
    this.record('note', text)
    this.bus.emit({ type: 'session.note', sessionId: this.options.sessionId, turn: this.turn, text, at: Date.now() })
  }

  /**
   * The journal half of a line the window is already being told about another
   * way — an error, a stop. Recorded without an event, so the renderer draws it
   * once live and once on replay, never twice.
   */
  private record(kind: SessionNote['kind'], text: string): void {
    this.journal.push({ kind, text, turn: this.turn, after: this.transcript.length, at: Date.now() })
  }

  /** Notes from an earlier run of this session, replayed alongside the history. */
  restoreNotes(notes: readonly SessionNote[]): void {
    this.journal.push(...notes)
  }

  /** True while a turn is running, which is the only time `stop()` does anything. */
  get running(): boolean {
    return this.controller !== null
  }

  /** End the turn now: abort the request in flight and stop the tool loop. */
  stop(): void {
    if (this.controller === null) return
    this.stopped = true
    this.controller.abort()
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
    this.messages.push({ role: 'user', content: userText })

    try {
      return await this.runRounds(sessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.record('error', message)
      this.bus.emit({ type: 'session.error', sessionId, turn: this.turn, message, at: Date.now() })
      throw err
    } finally {
      this.controller = null
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
      const { text, toolCalls, usage, thinking } = await this.drainRound()
      this.addUsage(usage)
      this.bus.emit({ type: 'usage', sessionId, turn: this.turn, usage: { ...this.totalUsage }, at: Date.now() })

      // An assistant message with no text, no tool calls and no thinking is not
      // a message: it is a blank in the window and a block some providers
      // refuse to be sent back. The round is still over — that is handled
      // below — but nothing is written down.
      if (text !== '' || toolCalls.length > 0 || thinking.length > 0) {
        this.messages.push({
          role: 'assistant',
          content: text,
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

      for (const call of toolCalls) {
        if (this.stopped) this.noteSkipped(call)
        else await this.executeTool(call)
      }

      if (this.stopped) {
        this.record('stopped', 'Stopped.')
        this.bus.emit({ type: 'session.stopped', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      if (this.repeat.count >= REPEAT_ABORT) {
        const stuck = `The same tool call was asked for ${this.repeat.count} times in a row, so the turn was ended here. Nothing was cut for length — this one call was going round in circles.`
        this.note(stuck)
        this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }
    }
  }

  private async drainRound(): Promise<{ text: string; toolCalls: ToolCall[]; usage: TurnUsage; thinking: ThinkingBlock[] }> {
    let text = ''
    const toolCalls: ToolCall[] = []
    const thinking: ThinkingBlock[] = []
    let usage = emptyUsage()

    const chunks = this.provider.stream({
      model: this.options.model,
      messages: this.messages,
      tools: this.tools.map(t => t.input),
      ...(this.options.effort === undefined ? {} : { effort: this.options.effort }),
      ...(this.controller === null ? {} : { signal: this.controller.signal }),
    })

    try {
      for await (const chunk of chunks) {
        switch (chunk.kind) {
          case 'text':
            text += chunk.text
            this.bus.emit({ type: 'text_delta', sessionId: this.options.sessionId, text: chunk.text, at: Date.now() })
            break
          case 'thinking':
            this.bus.emit({ type: 'thinking_delta', sessionId: this.options.sessionId, text: chunk.text, at: Date.now() })
            break
          case 'thinking_block':
            thinking.push(chunk.block)
            break
          case 'tool':
            toolCalls.push(chunk.tool)
            this.bus.emit({ type: 'tool_call', sessionId: this.options.sessionId, call: chunk.tool, at: Date.now() })
            break
          case 'done':
            usage = chunk.usage
            break
          case 'error':
            throw new Error(chunk.message)
        }
      }
    } catch (err) {
      // Stop aborts the request mid-stream, so the abort is the expected end of
      // this round, not a failure: keep what arrived and let the loop wind down.
      if (!this.stopped) throw err
    }
    return { text, toolCalls, usage, thinking }
  }

  /** A tool call the stop landed on top of. The model gets told, not ignored. */
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

  private async executeTool(call: ToolCall): Promise<void> {
    const result = await this.resultFor(call)

    this.failures = result.ok ? 0 : this.failures + 1
    // A run of failures is not a reason to end the turn — debugging is mostly
    // failures — but it is worth saying out loud, because a model that cannot
    // see the pattern will keep going the same way.
    if (this.failures === FAILURE_NUDGE) {
      result.content = `${result.content ?? result.summary}\n\n[harness: ${this.failures} tool calls in a row have failed. Change approach, or tell the user what is blocking you.]`
    }

    this.bus.emit({ type: 'tool_result', sessionId: this.options.sessionId, callId: call.id, result, at: Date.now() })
    // The failure is stored, not only emitted: a re-opened session has to show
    // a refused tool as refused rather than as a successful call.
    this.messages.push({
      role: 'tool',
      content: result.content ?? result.summary ?? '',
      toolCallId: call.id,
      ...(result.ok ? {} : { failed: true }),
    })
  }

  /**
   * The result of one call, or the harness's answer to a call it has already
   * answered twice. The refusal is deliberately a tool result rather than an end
   * to the turn: the model is told the loop it is in and given the round to get
   * out of it.
   */
  private async resultFor(call: ToolCall): Promise<ToolResult> {
    const key = `${call.name}\u0000${call.args}`
    this.repeat = key === this.repeat.key ? { key, count: this.repeat.count + 1 } : { key, count: 1 }

    if (this.repeat.count >= REPEAT_REFUSE) {
      const same = `this is call ${this.repeat.count} to ${call.name} with identical arguments; it was not run, because the answer is the one you already have. Do something different, or answer the user with what you know.`
      return { ok: false, summary: same, content: same, isError: true }
    }

    const tool = this.tools.find(t => t.input.name === call.name)
    if (tool === undefined) return { ok: false, summary: `unknown tool: ${call.name}` }
    return this.runWithArgs(tool, call.args)
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
    return tool.run(parsed, {
      cwd: this.options.cwd,
      access: this.access,
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
      ...(this.options.job === undefined ? {} : { job: this.options.job }),
    })
  }

  private addUsage(u: TurnUsage): void {
    for (const target of [this.totalUsage, this.turnUsage]) {
      target.input += u.input
      target.output += u.output
      target.cacheRead += u.cacheRead
      target.cacheWrite += u.cacheWrite
      target.reasoning += u.reasoning
    }
  }
}