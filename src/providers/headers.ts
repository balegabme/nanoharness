// doc: docs/harness/providers.md
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/**
 * What the harness calls itself on the wire. Node sends the name of its HTTP
 * library unless told otherwise, and endpoints route, rate-limit and refuse on
 * this field, so every request the harness makes says what it is.
 */
export const USER_AGENT = `nanoharness/${pkg.version}`

/**
 * The headers both wires carry on every request, whatever else they add.
 *
 * `sessionHeader` is the name an endpoint wants the conversation id under.
 * There is no standard one. Endpoints that pin a conversation to a single
 * upstream, or keep a prompt cache warm for it, each chose their own spelling,
 * and most ask for nothing at all. With no name or no conversation, the user
 * agent goes alone.
 */
export function wireHeaders(sessionHeader?: string, conversationId?: string): Record<string, string> {
  const name = sessionHeader?.trim() ?? ''
  const id = conversationId?.trim() ?? ''
  if (name === '' || id === '') return { 'user-agent': USER_AGENT }
  return { 'user-agent': USER_AGENT, [name]: id }
}
