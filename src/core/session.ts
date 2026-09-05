// doc: docs/harness/overview.md
import { EventBus } from './event-bus.js'
import type { ChatProvider } from './provider.js'
import type { Effort } from './config.js'
import { workspaceGate } from './scope.js'
import type { AccessGate } from './scope.js'
import { emptyUsage } from './types.js'
import type { ChatMessage, ThinkingBlock, ToolCall, ToolInput, ToolResult, TurnUsage } from './types.js'

/**
 * What a tool is handed instead of a bare cwd. `access` is the scope guard: a
 * tool asks it before touching a path, so no tool has to remember the rule and
 * none can forget it (see `scope.ts`).
 */
export interface ToolContext {
  cwd: string
  access: AccessGate
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

export interface SessionOptions {
  sessionId: string
  cwd: string
  model: string
  systemPrompt: string
  maxToolRounds: number
  effort?: Effort
  /** Defaults to a hard block outside `cwd`; the app passes one that can ask. */
  access?: AccessGate
  /** Messages from an earlier run of this session, replayed as history. */
  history?: ChatMessage[]
}

export class Session {
  readonly bus: EventBus
  readonly access: AccessGate
  private readonly messages: ChatMessage[] = []
  private turn = 0
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
      this.bus.emit({ type: 'session.error', sessionId, turn: this.turn, message: err instanceof Error ? err.message : String(err), at: Date.now() })
      throw err
    } finally {
      this.controller = null
    }
  }

  private async runRounds(sessionId: string): Promise<TurnUsage> {
    for (let round = 0; round <= this.options.maxToolRounds; round += 1) {
      const { text, toolCalls, usage, thinking } = await this.drainRound()
      this.addUsage(usage)
      this.bus.emit({ type: 'usage', sessionId, turn: this.turn, usage: { ...this.totalUsage }, at: Date.now() })

      this.messages.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(thinking.length > 0 ? { thinking } : {}),
      })

      if (this.stopped) {
        // Whatever the model had already asked for still needs an answer, or the
        // next request carries tool calls nothing ever replied to.
        for (const call of toolCalls) this.noteSkipped(call)
        this.bus.emit({ type: 'session.stopped', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      if (toolCalls.length === 0) {
        this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      for (const call of toolCalls) {
        if (this.stopped) this.noteSkipped(call)
        else await this.executeTool(call)
      }

      if (this.stopped) {
        this.bus.emit({ type: 'session.stopped', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }
    }

    this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
    return this.totalUsage
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
    const tool = this.tools.find(t => t.input.name === call.name)
    const result = tool ? await this.runWithArgs(tool, call.args) : { ok: false, summary: `unknown tool: ${call.name}` }

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
    return tool.run(parsed, { cwd: this.options.cwd, access: this.access })
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