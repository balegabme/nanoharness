// doc: docs/harness/providers.md
import type { ProviderKind } from '../core/config.js'

/**
 * One endpoint the harness has met before.
 *
 * `providers.md` promises a provider kind is a wire format and never a vendor,
 * and that still holds: nothing here changes how a request is built or how an
 * answer is read. What an endpoint charges and which wire each of its models
 * takes are read from the catalogue at fetch time (`catalogue.ts`). What is
 * left is the handful of things nobody publishes: the address itself, and the
 * header this one wants a conversation id under.
 */
export interface KnownProvider {
  id: string
  /** What the picker calls it. */
  label: string
  kind: ProviderKind
  baseURL: string
  /** Where it wants the conversation id, where it wants one. */
  sessionHeader?: string
  /** One line under the picker, for what a person needs to know before paying. */
  note: string
}

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  {
    id: 'opencode-go',
    label: 'opencode Go',
    kind: 'openai',
    baseURL: 'https://opencode.ai/zen/go/v1',
    // Its gateway pins a conversation to one upstream by this header, and
    // refuses any request that arrives without it.
    sessionHeader: 'x-opencode-session',
    note: 'A monthly subscription rather than metered API credit. Paste the key and fetch the models: the plan covers all of them.',
  },
]

/**
 * The header this address is known to want the conversation id in, where it is
 * known to want one.
 */
export function defaultSessionHeader(baseURL: string): string | undefined {
  return knownFor(baseURL)?.sessionHeader
}
/**
 * The entry this address belongs to. Subdomains count: a regional or staging
 * host of a listed endpoint speaks the same protocol as the address people
 * paste.
 */
function knownFor(baseURL: string): KnownProvider | undefined {
  const host = hostOf(baseURL)
  if (host === undefined) return undefined
  return KNOWN_PROVIDERS.find(known => {
    const theirs = hostOf(known.baseURL)
    return theirs !== undefined && (host === theirs || host.endsWith(`.${theirs}`))
  })
}

function hostOf(baseURL: string): string | undefined {
  try {
    return new URL(baseURL).hostname.toLowerCase()
  } catch {
    return undefined
  }
}
