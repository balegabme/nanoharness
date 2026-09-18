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
  /**
   * The most output this model will produce, where anyone has said. Anthropic
   * requires a ceiling on every request and the thinking budget is fitted
   * inside this one; OpenAI-compatible endpoints ignore it.
   */
  maxTokens?: number
  /** Aborted when the person hits Stop. The provider passes it to `fetch`. */
  signal?: AbortSignal
}

/**
 * A request that reached the provider and came back wrong. The status is kept
 * because it is the only thing that separates a rate limit from a bad key, and
 * the session retries one and not the other.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** How long the provider asked to be left alone, from `Retry-After`. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

/**
 * `Retry-After` in milliseconds, or undefined when there is no usable header.
 *
 * The header comes in two shapes, a count of seconds and an HTTP date, and both
 * are in the spec, so both are read. A provider that says when it will be ready
 * knows its own load better than any schedule written here.
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(header)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/** The longest a Retry-After is honoured before the schedule takes over. */
export const RETRY_AFTER_CAP_MS = 60_000

/**
 * The two failures a provider reports by breaking rather than by answering.
 * `isRetryable` matches on them, so they are named here and thrown from there
 * instead of each wire spelling its own string.
 */
export const NO_BODY = 'no response body'
export const BAD_SSE = 'provider sent malformed SSE chunk'

/**
 * Statuses worth sending the same request again for: the provider is busy, in
 * front of something that is, or briefly broken. Everything else is the request
 * itself being wrong, and a second identical attempt would be told so again.
 */
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

/** Node's fetch reports a dropped connection through `cause.code`. */
const RETRY_CODE = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET'])

/**
 * Whether the same request is worth making again.
 *
 * An abort is never retried: it is the person having pressed Stop, and trying
 * again would be the harness arguing with them.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return false
  // A stream that stopped mid-event, or never started, is a connection that
  // broke rather than a conversation the provider refused. These are checked
  // ahead of the status, because a body that never arrived is thrown with the
  // response's own status, and that status is a 2xx: the headers were fine.
  if (err.message === BAD_SSE) return true
  if (err.message === NO_BODY) return true
  if (err.message === 'fetch failed') return true
  if (err instanceof ProviderError) return err.status === undefined || RETRY_STATUS.has(err.status)
  const code: unknown = err.cause instanceof Error ? (err.cause as { code?: unknown }).code : undefined
  return typeof code === 'string' && RETRY_CODE.has(code)
}
