// doc: docs/harness/providers.md
import { createAnthropicProvider, listModels as listAnthropicModels } from './anthropic.js'
import { createOpenAIProvider, listModels as listOpenAIModels } from './openai.js'
import { createResponsesProvider } from './responses.js'
import { catalogueFor, describe } from './catalogue.js'
import { defaultSessionHeader } from './profiles.js'
import type { ChatProvider } from '../core/provider.js'
import type { ModelOffer, ProviderKind } from '../core/config.js'

export interface Endpoint {
  kind: ProviderKind
  baseURL: string
  apiKey: string
  /** Where this endpoint wants the conversation id, where it wants one. */
  sessionHeader?: string
  /**
   * The wire the model being asked for takes, where the catalogue named one
   * that is not the record's. A gateway can hold a model reachable on one wire
   * alone, so it is stored with that model's prices and read back here.
   */
  wire?: ProviderKind
}

/**
 * The one place a provider kind turns into a client. Everything above this
 * line (sessions, settings, the model picker) deals in records and never in
 * wire formats, so adding a third kind touches this file and nothing else.
 */
export function createProvider(endpoint: Endpoint): ChatProvider {
  const { baseURL, apiKey } = endpoint
  // What the record says, else what this address is known to want. Pasting an
  // address and a key is enough for an endpoint anyone has met before; a
  // record that named a header itself outranks the address.
  const sessionHeader = endpoint.sessionHeader ?? defaultSessionHeader(baseURL)
  const opts = { baseURL, apiKey, ...(sessionHeader === undefined ? {} : { sessionHeader }) }
  // The model's own wire outranks the record's, the other way round from the
  // session header above: a header the user typed is a preference, and a wire
  // the endpoint refuses is a 400.
  const kind = endpoint.wire ?? endpoint.kind
  if (kind === 'anthropic') return createAnthropicProvider(opts)
  if (kind === 'responses') return createResponsesProvider(opts)
  return createOpenAIProvider(opts)
}

export async function listModelsFor(endpoint: Endpoint, timeoutMs?: number): Promise<ModelOffer[]> {
  const { baseURL, apiKey } = endpoint
  // Responses is a wire for asking a model something and publishes no catalogue
  // of its own; the endpoints that speak it list their models on the same
  // `/v1/models` the older wire uses.
  const offers =
    endpoint.kind === 'anthropic'
      ? await listAnthropicModels({ baseURL, apiKey }, timeoutMs)
      : await listOpenAIModels({ baseURL, apiKey }, timeoutMs)
  // An endpoint that publishes a bare list has described nothing, and every
  // model it offers would reach settings under a warning mark. The catalogue
  // fills those gaps and overwrites none of them.
  return describe(offers, await catalogueFor(baseURL, timeoutMs))
}
