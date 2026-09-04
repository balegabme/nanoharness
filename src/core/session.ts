// doc: docs/harness/overview.md
import { EventBus } from './event-bus.js'
import type { ChatProvider } from './provider.js'
import { emptyUsage } from './types.js'
import type { ChatMessage, ToolCall, ToolInput, ToolResult, TurnUsage } from './types.js'

export interface Tool {
  input: ToolInput
  run(args: Record<string, unknown>, cwd: string): Promise<ToolResult>
}

export type ArgsParse<A> = { ok: true; args: A } | { ok: false; error: string }

export interface ToolSpec<A> {
  input: ToolInput
  parse(args: Record<string, unknown>): ArgsParse<A>
  run(args: A, cwd: string): Promise<ToolResult>
}

// Tool args arrive as untrusted wire JSON, so the stored Tool keeps an erased
// arg type. defineTool validates once at that boundary; the spec's run() then
// works with a real type instead of casting field by field.
export function defineTool<A>(spec: ToolSpec<A>): Tool {
  return {
    input: spec.input,
    async run(raw, cwd) {
      const parsed = spec.parse(raw)
      if (parsed.ok) return spec.run(parsed.args, cwd)
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
}

export class Session {
  readonly bus: EventBus
  private readonly messages: ChatMessage[] = []
  private turn = 0
  private totalUsage = emptyUsage()
  private turnUsage = emptyUsage()

  constructor(
    readonly options: SessionOptions,
    private readonly provider: ChatProvider,
    private readonly tools: Tool[],
    bus?: EventBus,
  ) {
    this.bus = bus ?? new EventBus()
    this.messages.push({ role: 'system', content: options.systemPrompt })
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
    const sessionId = this.options.sessionId
    this.bus.emit({ type: 'session.started', sessionId, cwd: this.options.cwd, at: Date.now() })
    this.messages.push({ role: 'user', content: userText })

    try {
      return await this.runRounds(sessionId)
    } catch (err) {
      this.bus.emit({ type: 'session.error', sessionId, turn: this.turn, message: err instanceof Error ? err.message : String(err), at: Date.now() })
      throw err
    }
  }

  private async runRounds(sessionId: string): Promise<TurnUsage> {
    for (let round = 0; round <= this.options.maxToolRounds; round += 1) {
      const { text, toolCalls, usage } = await this.drainRound()
      this.addUsage(usage)
      this.bus.emit({ type: 'usage', sessionId, turn: this.turn, usage: { ...this.totalUsage }, at: Date.now() })

      const assistant: ChatMessage =
        toolCalls.length > 0 ? { role: 'assistant', content: text, toolCalls } : { role: 'assistant', content: text }
      this.messages.push(assistant)

      if (toolCalls.length === 0) {
        this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
        return this.totalUsage
      }

      for (const call of toolCalls) {
        await this.executeTool(call)
      }
    }

    this.bus.emit({ type: 'session.finished', sessionId, turn: this.turn, at: Date.now() })
    return this.totalUsage
  }

  private async drainRound(): Promise<{ text: string; toolCalls: ToolCall[]; usage: TurnUsage }> {
    let text = ''
    const toolCalls: ToolCall[] = []
    let usage = emptyUsage()

    const chunks = this.provider.stream({
      model: this.options.model,
      messages: this.messages,
      tools: this.tools.map(t => t.input),
    })

    for await (const chunk of chunks) {
      switch (chunk.kind) {
        case 'text':
          text += chunk.text
          this.bus.emit({ type: 'text_delta', sessionId: this.options.sessionId, text: chunk.text, at: Date.now() })
          break
        case 'thinking':
          this.bus.emit({ type: 'thinking_delta', sessionId: this.options.sessionId, text: chunk.text, at: Date.now() })
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
    return { text, toolCalls, usage }
  }

  private async executeTool(call: ToolCall): Promise<void> {
    const tool = this.tools.find(t => t.input.name === call.name)
    const result = tool ? await this.runWithArgs(tool, call.args) : { ok: false, summary: `unknown tool: ${call.name}` }

    this.bus.emit({ type: 'tool_result', sessionId: this.options.sessionId, callId: call.id, result, at: Date.now() })
    this.messages.push({
      role: 'tool',
      content: result.content ?? result.summary ?? '',
      toolCallId: call.id,
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
    return tool.run(parsed, this.options.cwd)
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