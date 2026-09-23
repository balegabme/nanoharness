// doc: docs/harness/context.md
import type { ChatMessage, CompactionRecord, ContextLedger, ContextParts, ToolInput } from './types.js'

/**
 * How big the next request is, and how close that is to the model's window.
 *
 * The provider measures every prompt it answers, and that is the only exact
 * figure there is. The ledger takes the last one as its anchor and estimates
 * what has been appended since. `docs/harness/context.md` has the reasoning.
 */

/**
 * The estimator: characters over four, four tokens per content block and
 * four per message for the role framing around it. It is rough, and needs no
 * tokenizer of its own because calibration corrects it for the one actually
 * answering.
 */
const CHARS_PER_TOKEN = 4
const BLOCK_TOKENS = 4
const MESSAGE_TOKENS = 4

/**
 * Room kept for the answer on a wire that declares no output ceiling of its
 * own: the smaller of this and what the model will produce. It covers a long
 * answer with tool calls in it, and on a large window it costs little.
 */
export const DEFAULT_RESERVE = 20_000

/**
 * Automatic compaction runs once the context passes this share of the usable
 * space, the room less the reserve. The fifth it leaves is the room the
 * summary request needs, since that request is the same prompt with an
 * instruction on the end.
 */
export const AUTO_RATIO = 0.8

/**
 * How much of the room stays verbatim after a summary. It holds the last few
 * rounds the model is working from, and leaves the context well under the
 * threshold once the rest is summarised.
 */
export const KEEP_RATIO = 0.16

/**
 * Calibration moves this far towards each new measurement, and never leaves
 * the clamp. Neither has been measured: the clamp is wide enough for any
 * tokenizer seen so far and narrow enough that one response carrying an image
 * cannot throw the meter off by more than double.
 */
const CALIBRATION_WEIGHT = 0.3
const CALIBRATION_MIN = 0.5
const CALIBRATION_MAX = 2

export function emptyParts(): ContextParts {
  return { system: 0, tools: 0, user: 0, assistant: 0, thinking: 0, toolResults: 0, summary: 0 }
}

export function partsTotal(parts: ContextParts): number {
  return parts.system + parts.tools + parts.user + parts.assistant + parts.thinking + parts.toolResults + parts.summary
}

/** Characters as tokens, by the estimator above. */
export function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * An image as the estimator sizes it: its pixels over 750, the rate plan §15
 * records. Wires that bill by tiles or patches land near it for an image of
 * the size the window sends, and calibration takes up the rest.
 */
function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750)
}

/** The tool schemas as the estimator sizes them. They do not change within a session. */
export function toolTokens(tools: readonly ToolInput[]): number {
  let total = 0
  for (const tool of tools) total += textTokens(JSON.stringify(tool)) + BLOCK_TOKENS
  return total
}

/**
 * The estimated parts of a request, before scaling. `messages` is what goes
 * out, as `Session.wireMessages()` builds it, so the summary is the one
 * message carrying `summary: true`.
 *
 * Thinking is counted only where it goes back on the wire: a signed block and
 * a redacted one. An unsigned block is kept for the window alone and never
 * sent, so counting it would size a request nobody makes.
 */
export function estimateParts(messages: readonly ChatMessage[], tools: number): ContextParts {
  const parts = emptyParts()
  parts.tools = tools
  for (const m of messages) {
    if (m.role === 'tool') {
      parts.toolResults += textTokens(m.content) + BLOCK_TOKENS + MESSAGE_TOKENS
      continue
    }
    if (m.role === 'system') {
      parts.system += textTokens(m.content) + MESSAGE_TOKENS
      continue
    }
    if (m.role === 'user') {
      let size = textTokens(m.content) + BLOCK_TOKENS + MESSAGE_TOKENS
      for (const image of m.images ?? []) size += imageTokens(image.width, image.height) + BLOCK_TOKENS
      if (m.summary === true) parts.summary += size
      else parts.user += size
      continue
    }
    parts.assistant += MESSAGE_TOKENS
    if (m.content !== '') parts.assistant += textTokens(m.content) + BLOCK_TOKENS
    for (const call of m.toolCalls ?? []) parts.assistant += textTokens(call.name) + textTokens(call.args) + BLOCK_TOKENS
    for (const block of m.thinking ?? []) {
      if (block.kind === 'redacted') parts.thinking += textTokens(block.data) + BLOCK_TOKENS
      else if (block.signature !== undefined) parts.thinking += textTokens(block.text) + BLOCK_TOKENS
    }
  }
  return parts
}

/** One message by the estimator, unscaled. */
export function messageTokens(message: ChatMessage): number {
  return partsTotal(estimateParts([message], 0))
}

/**
 * The estimator's error on this tokenizer, as a factor: what the provider
 * reported over what the estimator said, for the same request. Kept per
 * session, and written down on the ledger so a reopened session on the same
 * model starts from it.
 */
export class Calibration {
  private value = 1
  private sampled = false

  /** `initial` is a factor measured before, which counts as the first sample. */
  constructor(initial?: number) {
    if (initial === undefined || !(initial > 0)) return
    this.value = clamp(initial)
    this.sampled = true
  }

  get factor(): number {
    return this.value
  }

  /** One request, as reported and as estimated. */
  sample(reported: number, estimated: number): void {
    if (reported <= 0 || estimated <= 0) return
    const ratio = clamp(reported / estimated)
    // The first sample is taken whole: moving 30% of the way from a factor
    // nobody measured would leave the meter wrong for several responses.
    this.value = this.sampled ? clamp(this.value + (ratio - this.value) * CALIBRATION_WEIGHT) : ratio
    this.sampled = true
  }

  /**
   * The provider refused a request as too long for a window of `floor`
   * tokens, which the estimate had put under it. That is a lower bound on the
   * true size, and the factor is raised to meet it.
   */
  atLeast(floor: number, estimated: number): void {
    if (floor <= 0 || estimated <= 0) return
    this.value = Math.max(this.value, clamp(floor / estimated))
    this.sampled = true
  }
}

function clamp(factor: number): number {
  return Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, factor))
}

/**
 * What the last measured request said about itself: the prompt the provider
 * reported and what the estimator made of the same messages. The difference
 * between that estimate and the current one is what has been appended since.
 */
export interface Anchor {
  reported: number
  estimated: number
}

export interface LedgerInput {
  /** The request as it would go out now. */
  messages: readonly ChatMessage[]
  /** `toolTokens` for the session's tools. */
  tools: number
  anchor: Anchor | null
  factor: number
  /** The model the factor was measured on. */
  model: string
  window: number | undefined
  limit: number | undefined
  reserve: number
  auto: boolean
  compactions: readonly CompactionRecord[]
}

export function buildLedger(input: LedgerInput): ContextLedger {
  const raw = estimateParts(input.messages, input.tools)
  const rawTotal = partsTotal(raw)
  const anchor = input.anchor
  // Everything since the anchor was appended, since anything else drops it, so
  // the estimate can only have grown. The floor is for rounding and nothing
  // more.
  const estimated = anchor === null ? Math.round(rawTotal * input.factor) : Math.round(Math.max(0, rawTotal - anchor.estimated) * input.factor)
  const tokens = (anchor?.reported ?? 0) + estimated
  const room = workingWindow(input.window ?? null, input.limit ?? null)
  // A reserve as large as the room leaves nothing to measure against. Null
  // turns automatic compaction off, where a threshold of 0 would summarise
  // before every request.
  const usable = room !== null && room > input.reserve ? room - input.reserve : null
  return {
    tokens,
    measured: anchor?.reported ?? null,
    estimated,
    window: input.window ?? null,
    limit: input.limit ?? null,
    room,
    reserve: input.reserve,
    usable,
    threshold: usable === null ? null : Math.floor(usable * AUTO_RATIO),
    calibration: input.factor,
    model: input.model,
    parts: scaled(raw, rawTotal, tokens),
    auto: input.auto,
    compactions: input.compactions.map(one => ({ ...one })),
    at: Date.now(),
  }
}

/**
 * The parts, scaled so they add up to the measured total. Each part is an
 * estimate, and the provider's figure is the one that is right, so the error
 * is spread over the parts in proportion to their size. The remainder from
 * rounding goes to the largest part, where it is least visible.
 */
function scaled(raw: ContextParts, rawTotal: number, tokens: number): ContextParts {
  if (rawTotal === 0) return raw
  const ratio = tokens / rawTotal
  const out = emptyParts()
  let largest: keyof ContextParts = 'system'
  let sum = 0
  for (const key of Object.keys(raw) as (keyof ContextParts)[]) {
    out[key] = Math.round(raw[key] * ratio)
    sum += out[key]
    if (out[key] > out[largest]) largest = key
  }
  out[largest] += tokens - sum
  return out
}

/**
 * The window compaction works against: the model's, or the user's limit where
 * that is smaller or the window is unknown. Null when neither is known.
 */
function workingWindow(window: number | null, limit: number | null): number | null {
  if (limit === null) return window
  return window === null ? limit : Math.min(window, limit)
}

/**
 * The room the next answer needs. A wire that declares an output ceiling the
 * server counts against the window gets that ceiling; anything else gets
 * `DEFAULT_RESERVE`, cut to what the model will produce where that is known.
 */
export function reserveFor(declared: number | undefined, maxOutput: number | undefined): number {
  if (declared !== undefined) return declared
  return maxOutput === undefined ? DEFAULT_RESERVE : Math.min(DEFAULT_RESERVE, maxOutput)
}
