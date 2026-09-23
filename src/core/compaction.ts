// doc: docs/harness/context.md
import { messageTokens, textTokens } from './context.js'
import type { ChatMessage } from './types.js'

/**
 * What compaction writes and where it cuts. The session decides when to
 * compact and makes the requests; this file holds the pieces that do not need
 * a session: the instruction, the cut, the pruner and the flattened history.
 */

/** The summary goes out wrapped in this tag, so the model can tell a checkpoint from something the user typed. */
const SUMMARY_TAG = 'compacted-summary'

export function wrapSummary(text: string): string {
  return `<${SUMMARY_TAG}>\n${text}\n</${SUMMARY_TAG}>`
}

/** How long a summary is asked to be: long enough for detail under every heading below. */
const SUMMARY_TOKENS = 8_000

const HEADINGS = `Answer with the checkpoint alone, in Markdown, under these headings, in under about ${SUMMARY_TOKENS.toLocaleString('en-US')} tokens:

## Task
What the user asked for, in their words where the wording matters, and any constraints they set.

## Decisions
What was decided and why, with the approaches that were tried and dropped.

## Files
Each file that was read or changed, by path, and what changed in it.

## Commands
The commands that were run and what their output showed.

## Open problems
Errors, failing tests and questions nobody has answered yet.

## Next step
What you were about to do.

Copy paths, identifiers, error messages and numbers exactly as they appear.`

/**
 * The instruction appended to the conversation for a summary that reads the
 * cache. Everything before it is the request the session would have sent, so
 * the tools are still offered and the instruction has to say not to use them.
 */
export const SUMMARY_INSTRUCTION = `The conversation is about to be compacted. Everything above this message, apart from the most recent messages, will be replaced by what you write now, so write the checkpoint you would need to carry on the work without it.

Do not call any tools. ${HEADINGS}`

/** The system prompt for a flattened summary, which carries none of the session's own. */
export const FLAT_SYSTEM = 'You write checkpoints of coding sessions. The agent that continues the session reads your checkpoint in place of the history you are given.'

export function flatInstruction(history: string): string {
  return `Below is the earlier part of a coding session, as plain text, with long tool output cut short. The session continues from what you write, so write the checkpoint the agent needs to carry on the work.

${HEADINGS}

<history>
${history}
</history>`
}

/**
 * Tool results longer than `PRUNE_OVER` characters keep their first
 * `PRUNE_HEAD` and last `PRUNE_TAIL`, with a line in between saying how much
 * went. The start of an output usually says what it is and the end says how
 * it finished. The threshold is about 2,000 tokens, so a result under it costs
 * little to send whole. `renderer/chat.ts` repeats the two lengths in the
 * tooltip on a shortened card, so change both together.
 */
const PRUNE_OVER = 8_192
const PRUNE_HEAD = 4_096
const PRUNE_TAIL = 1_024

export function prunable(message: ChatMessage): boolean {
  return message.role === 'tool' && message.compacted === undefined && message.content.length > PRUNE_OVER
}

/** A pruned tool result as it goes out. The stored message keeps the whole output. */
export function prunedText(content: string): string {
  const removed = content.length - PRUNE_HEAD - PRUNE_TAIL
  return `${content.slice(0, PRUNE_HEAD)}\n[harness: ${removed} characters of this output were removed to save context]\n${content.slice(-PRUNE_TAIL)}`
}

/** What a compaction folds away, by index into the session's messages. */
export interface Cut {
  /** The first message kept verbatim. */
  start: number
  /** The messages going into the summary, in order. */
  compacted: number[]
}

/**
 * Where to cut: keep about `keep` tokens of the newest messages verbatim and
 * summarise the live ones before them.
 *
 * The cut lands on a message boundary, and never on a tool result, because a
 * result sent without the call it answers is a request every wire refuses. It
 * keeps at least the newest round, so the model always sees what it just did.
 * `lifted` is the current turn's user message, which stays verbatim wherever
 * the cut falls. A subagent's whole life is one turn, and summarising the task
 * it was given would leave it working from a paraphrase of its own orders.
 *
 * Null when there is nothing before the cut to summarise.
 */
export function planCut(messages: readonly ChatMessage[], keep: number, factor: number, lifted: number): Cut | null {
  const live = (i: number): boolean => {
    const m = messages[i]
    return i > 0 && m !== undefined && m.compacted !== 'compacted' && !(m.role === 'user' && m.summary === true)
  }
  let start = -1
  let kept = 0
  let newest = -1
  for (let i = messages.length - 1; i > 0; i -= 1) {
    if (!live(i)) continue
    if (newest < 0 && messages[i]?.role !== 'tool') newest = i
    kept += sentTokens(messages[i] as ChatMessage) * factor
    start = i
    if (kept >= keep) break
  }
  if (start < 0) return null
  if (newest >= 0 && start > newest) start = newest
  while (start > 1 && messages[start]?.role === 'tool') start -= 1
  const compacted: number[] = []
  for (let i = 1; i < start; i += 1) if (live(i) && i !== lifted) compacted.push(i)
  return compacted.length === 0 ? null : { start, compacted }
}

/**
 * A message's size as it goes out. A pruned result is sent shortened, and
 * sizing it whole would spend the kept tail on bytes the model never sees.
 */
function sentTokens(message: ChatMessage): number {
  return message.role === 'tool' && message.compacted === 'pruned' ? messageTokens({ ...message, content: prunedText(message.content) }) : messageTokens(message)
}

/**
 * How much of each tool output the flattened history keeps, about 500 tokens.
 * That shows what a call returned, and the whole output stays in the
 * transcript.
 */
const FLAT_TOOL_CHARS = 2_000

/**
 * The messages as plain text, newest kept first, within `budget` tokens. This
 * is the history for a summary made without the cache, after the provider has
 * refused a request, so it has to fit where the conversation did not.
 *
 * `checkpoint` is the summary an earlier compaction wrote. It is counted
 * against the budget before any message, because it is the only record of
 * everything older than them.
 */
export function flatten(messages: readonly ChatMessage[], budget: number, checkpoint?: ChatMessage): string {
  const first = checkpoint === undefined ? '' : flatLine(checkpoint)
  const lines: string[] = []
  let used = textTokens(first)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m === undefined) continue
    const line = flatLine(m)
    if (line === '') continue
    const size = textTokens(line)
    if (used + size > budget) {
      lines.push('[older messages did not fit and are left out]')
      break
    }
    lines.push(line)
    used += size
  }
  if (first !== '') lines.push(first)
  return lines.reverse().join('\n\n')
}

function flatLine(m: ChatMessage): string {
  if (m.role === 'tool') return `Tool result${m.failed === true ? ' (failed)' : ''}:\n${cut(m.content)}`
  if (m.role === 'system') return ''
  if (m.summary === true) return `Earlier checkpoint:\n${m.content}`
  if (m.role === 'user') return `User:\n${m.content}`
  const parts = m.content === '' ? [] : [`Assistant:\n${m.content}`]
  for (const call of m.toolCalls ?? []) parts.push(`Tool call ${call.name}: ${cut(call.args)}`)
  return parts.join('\n')
}

function cut(text: string): string {
  if (text.length <= FLAT_TOOL_CHARS) return text
  return `${text.slice(0, FLAT_TOOL_CHARS)}\n[${text.length - FLAT_TOOL_CHARS} more characters left out]`
}
