// doc: docs/harness/providers.md
import type { ChatChunk, ChatMessage, ToolInput } from './types.js'

export interface ChatProvider {
  stream(input: ChatInput): AsyncGenerator<ChatChunk>
}

export interface ChatInput {
  model: string
  messages: ChatMessage[]
  tools: ToolInput[]
  effort?: 'low' | 'medium' | 'high'
}