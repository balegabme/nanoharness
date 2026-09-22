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
  /**
   * Which conversation this request belongs to, for endpoints that asked to be
   * told. The value has to be stable across a conversation's turns and distinct
   * between conversations, which is what a session id already is. Endpoints use
   * it to pin a conversation to one upstream and to keep its cache warm; those
   * that never asked are sent nothing.
   */
  conversationId?: string
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
 * It comes in two shapes, a count of seconds and an HTTP date, and both are in
 * the spec.
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
 * A stream that broke, as against a request that was refused: the body never
 * arrived, or an event stopped halfway through.
 *
 * A class and not a message, so rewording the sentence cannot stop the retry.
 * It carries no status: the response whose body never arrived had perfectly
 * good headers.
 */
export class StreamBrokenError extends ProviderError {
  constructor(message: string) {
    super(message)
    this.name = 'StreamBrokenError'
  }
}

/** The wording, so both wires break off in the same words. */
export const NO_BODY = 'no response body'
export const BAD_SSE = 'provider sent malformed SSE chunk'

/**
 * The 4xx statuses worth sending the same request again for: each is the
 * server saying "not now" where the rest say "not this". Every other 4xx is
 * the request itself being wrong, and the same bytes are wrong again on
 * arrival.
 */
const RETRY_ANYWAY = new Set([408, 425, 429])

/**
 * Node reports a connection that never delivered a response through `code`, on
 * the error or on something in its `cause` chain. This is a closed, documented
 * set, so naming its members is safe. What is left out is left out on purpose:
 * an expired certificate fails the same way five times running.
 */
const RETRY_CODE = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/**
 * The first `code` in an error's cause chain, which is where the reason for a
 * bare `fetch failed` is kept. The chain is walked because undici nests: a
 * `TypeError` over an `AggregateError` over the real socket error.
 */
export function causeCode(err: unknown): string | undefined {
  for (let at: unknown = err; at instanceof Error; at = at.cause) {
    const code: unknown = (at as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * Whether the same request is worth making again.
 *
 * The rule is the one HTTP already states, so there is no list of statuses to
 * maintain. A 5xx is the server saying it failed. A 4xx is the server saying
 * the request was wrong, and a proxy answering in its own numbers (Cloudflare
 * uses 520 through 527) lands on the right side of that line without anyone
 * adding it.
 *
 * An abort is never retried: the person pressed Stop.
 */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return false
  if (err instanceof ProviderError) {
    // No status means nothing came back carrying one: a broken stream, or a
    // failure the wire reported from inside an already-successful response.
    if (err.status === undefined) return true
    return err.status >= 500 || RETRY_ANYWAY.has(err.status)
  }
  const code = causeCode(err)
  return code !== undefined && RETRY_CODE.has(code)
}

/**
 * How long to wait before attempt number `attempt + 1`, given the schedule of
 * gaps that caller keeps. A provider that sent `Retry-After` is answered on its
 * own terms, capped so an hour-long header does not hang the turn. Otherwise
 * the schedule applies, jittered over its last quarter to break the lockstep.
 */
export function backoffFor(err: unknown, attempt: number, schedule: readonly number[]): number {
  const asked = err instanceof ProviderError ? err.retryAfterMs : undefined
  if (asked !== undefined) return Math.min(asked, RETRY_AFTER_CAP_MS)
  const base = schedule[attempt - 1] ?? schedule.at(-1) ?? 0
  return Math.round(base * (0.75 + Math.random() * 0.25))
}

/**
 * Wait, and stop waiting early if the person presses Stop. It resolves either
 * way and never rejects.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
