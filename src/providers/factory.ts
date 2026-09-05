// doc: docs/harness/providers.md
import { createAnthropicProvider, listModels as listAnthropicModels } from './anthropic.js'
import { createOpenAIProvider, listModels as listOpenAIModels } from './openai.js'
import type { ChatProvider } from '../core/provider.js'
import type { ProviderKind } from '../core/config.js'

export interface Endpoint {
  kind: ProviderKind
  baseURL: string
  apiKey: string
}

/**
 * The one place a provider kind turns into a client. Everything above this line
 * — sessions, settings, the model picker — deals in records and never in wire
 * formats, so adding a third kind touches this file and nothing else.
 */
export function createProvider(endpoint: Endpoint): ChatProvider {
  const { baseURL, apiKey } = endpoint
  return endpoint.kind === 'anthropic'
    ? createAnthropicProvider({ baseURL, apiKey })
    : createOpenAIProvider({ baseURL, apiKey })
}

export async function listModelsFor(endpoint: Endpoint, timeoutMs?: number): Promise<string[]> {
  const { baseURL, apiKey } = endpoint
  return endpoint.kind === 'anthropic'
    ? listAnthropicModels({ baseURL, apiKey }, timeoutMs)
    : listOpenAIModels({ baseURL, apiKey }, timeoutMs)
}
