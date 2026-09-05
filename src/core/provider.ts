// doc: docs/harness/providers.md
import type { ChatChunk, ChatMessage, ToolInput } from './types.js'
import type { Effort } from './config.js'

export interface ChatProvider {
  stream(input: ChatInput): AsyncGenerator<ChatChunk>
}

export interface ChatInput {
  model: string
  messages: ChatMessage[]
  tools: ToolInput[]
  effort?: Effort
  /** Anthropic requires a ceiling; OpenAI-compatible endpoints ignore it. */
  maxTokens?: number
}
