// doc: docs/harness/commands.md
import { costOf } from '../shared/facts.js'
import { emptyUsage } from '../shared/usage.js'
import type { ModelFacts } from './config.js'

/**
 * `/tldr`: the last answer, shortened. The session makes the request; this
 * file holds the instructions and the choice of how to ask.
 *
 * There are two ways to ask. The whole conversation with the instruction on
 * the end reads the prefix the provider has cached, and the model knows what
 * the answer was for, which gives the better TL;DR. The answer alone is a
 * small request with no context. The whole conversation is chosen unless it
 * costs more than `CONTEXT_WORTH` times the answer alone.
 */

/** How much more the whole conversation may cost than the answer alone and still be chosen. */
const CONTEXT_WORTH = 2

/**
 * How long after the last request a cached prefix is assumed to still be
 * there. Endpoints that cache keep a prefix for at least five minutes after it
 * was last read, and some for longer, but none of them says so in its answer.
 * Assuming the shortest keeps a TL;DR from being priced as a hit on a prefix
 * that has already gone.
 */
export const CACHE_WARM_MS = 5 * 60_000

/** Appended to the conversation. The tools are still offered, so it says not to use them. */
export const TLDR_INSTRUCTION = `Write a TL;DR of your last answer above: its conclusion and anything the user has to do or decide, in a few short lines or bullets. Add nothing the answer did not say, and do not call any tools. Answer with the TL;DR alone.`

/** The system prompt for the answer sent alone, which carries none of the session's own. */
export const TLDR_SYSTEM = 'You shorten answers a coding agent gave, for a reader who has no time to read them whole.'

export function aloneInstruction(answer: string): string {
  return `Write a TL;DR of the answer below: its conclusion and anything the reader has to do or decide, in a few short lines or bullets. Add nothing the answer did not say. Answer with the TL;DR alone.

<answer>
${answer}
</answer>`
}

export type TldrRoute = 'whole' | 'alone'

export interface TldrSizes {
  /** The whole request, in tokens: the conversation as it would go next, with the instruction. */
  whole: number
  /** How much of `whole` is expected to be read from the cache. Zero when the cache is cold. */
  cached: number
  /** The request with the answer alone, in tokens. */
  alone: number
}

/**
 * Which way to ask. Only the prompt is compared: the TL;DR is about as long
 * either way. A cold prefix is written again, at the write rate where the
 * model has one. Where the prices are unknown, a warm cache is taken as cheap
 * enough, and a cold one is compared by size.
 */
export function tldrRoute(sizes: TldrSizes, facts: ModelFacts | undefined): TldrRoute {
  const whole = facts === undefined ? null : costOf({ ...emptyUsage(), cacheRead: sizes.cached, cacheWrite: sizes.whole - sizes.cached }, facts)
  const alone = facts === undefined ? null : costOf({ ...emptyUsage(), input: sizes.alone }, facts)
  if (whole === null || alone === null) return sizes.cached > 0 || sizes.whole <= CONTEXT_WORTH * sizes.alone ? 'whole' : 'alone'
  return whole <= CONTEXT_WORTH * alone ? 'whole' : 'alone'
}
