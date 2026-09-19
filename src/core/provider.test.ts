import { describe, expect, it } from 'vitest'
import { BAD_SSE, ProviderError, RETRY_AFTER_CAP_MS, StreamBrokenError, backoffFor, causeCode, isRetryable, retryAfterMs } from './provider.js'

/**
 * Whether to send a request a second time. The thing worth pinning is that the
 * answer comes from a rule rather than from a list of numbers somebody has to
 * remember to extend.
 */

/** A socket error the way Node hands one over: the reason is down in `cause`. */
function dropped(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code }) })
}

describe('whether a request is worth making again', () => {
  it('retries every 5xx, including the ones no list here has heard of', () => {
    for (const status of [500, 502, 503, 504, 507, 520, 522, 524, 529, 599]) {
      expect(isRetryable(new ProviderError(`provider ${status}`, status))).toBe(true)
    }
  })

  it('does not retry a request the provider read and refused', () => {
    // Each of these is the same request being wrong, and it is wrong in the
    // same way the second time. 409 is here on purpose: a conflict with the
    // server's state is not resolved by repeating the request that caused
    // it.
    for (const status of [400, 401, 403, 404, 409, 413, 422]) {
      expect(isRetryable(new ProviderError(`provider ${status}`, status))).toBe(false)
    }
  })

  it('retries the three 4xx that mean “not now” rather than “not this”', () => {
    for (const status of [408, 425, 429]) {
      expect(isRetryable(new ProviderError(`provider ${status}`, status))).toBe(true)
    }
  })

  it('retries a stream that broke without reading the message it broke with', () => {
    // The point of the class: the retry hangs on the type, so rewording the
    // message cannot switch it off.
    const broken = new StreamBrokenError(BAD_SSE)
    broken.message = 'something else entirely'
    expect(isRetryable(broken)).toBe(true)
  })

  it('retries a connection that never delivered a response, whatever fetch called it', () => {
    expect(isRetryable(dropped('ECONNRESET'))).toBe(true)
    expect(isRetryable(dropped('EAI_AGAIN'))).toBe(true)
    expect(isRetryable(dropped('UND_ERR_CONNECT_TIMEOUT'))).toBe(true)
  })

  it('does not retry a connection that failed for a reason four more attempts will not change', () => {
    expect(isRetryable(dropped('CERT_HAS_EXPIRED'))).toBe(false)
    expect(isRetryable(dropped('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe(false)
  })

  it('never retries the person pressing Stop, or something that is not an error', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isRetryable(abort)).toBe(false)
    expect(isRetryable('503')).toBe(false)
  })

  it('reads the code out of a nested cause, which is where undici puts it', () => {
    expect(causeCode(dropped('ECONNREFUSED'))).toBe('ECONNREFUSED')
    expect(causeCode(new Error('plain'))).toBeUndefined()
  })
})

describe('how long to wait first', () => {
  it('takes the provider at its word, capped', () => {
    expect(backoffFor(new ProviderError('slow down', 429, 5_000), 1, [500])).toBe(5_000)
    expect(backoffFor(new ProviderError('slow down', 429, 60 * 60 * 1000), 1, [500])).toBe(RETRY_AFTER_CAP_MS)
  })

  it('otherwise follows the schedule, spread so retries do not land in lockstep', () => {
    const wait = backoffFor(new Error('x'), 2, [500, 1500])
    expect(wait).toBeGreaterThanOrEqual(1125)
    expect(wait).toBeLessThanOrEqual(1500)
  })

  it('holds at the last gap rather than falling off the end of the schedule', () => {
    expect(backoffFor(new Error('x'), 9, [500, 1500])).toBeGreaterThanOrEqual(1125)
  })

  it('reads Retry-After as seconds or as a date', () => {
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThan(3_000)
    expect(retryAfterMs('soon')).toBeUndefined()
    expect(retryAfterMs(null)).toBeUndefined()
  })
})
