// doc: docs/harness/tools.md
import { defineTool } from '../core/session.js'
import { MAX_PLAN_ITEMS, planProgress, readPlan } from '../shared/plan.js'
import type { PlanItem } from '../shared/plan.js'
import type { Tool } from '../core/session.js'

/**
 * The agent's plan for the task in hand, shown to the user above the composer
 * as it changes. Each call sends the whole list, so there is no id to keep
 * track of and a list that went wrong is fixed by sending it again.
 *
 * The tool keeps nothing: the window reads the plan out of the call's own
 * arguments. What it hands back is one line, the count and the step being
 * worked on. The list itself is already in the model's context as the call it
 * just made, and writing it out a second time would pay for it twice on every
 * request that follows.
 */

export const TODO_TOOL: Tool = defineTool<{ items: PlanItem[] }>({
  input: {
    name: 'todo_write',
    description: [
      'Keep a visible plan for any task of three or more steps, whether or not the user asked for one. The user watches it update, so it is how they follow the work.',
      'Write it before the first step: it can go in the same message as your first reads. When the user asked for several things, each is a step, in their words. Send the whole list every time.',
      'Mark a step in_progress when you start it, and completed as soon as it is done and checked, each in its own update; exactly one step is in_progress while you work. A step that failed or is blocked is never completed: put it back to pending and add a step before it for what unblocks it, and that step is the one in_progress.',
      'Add steps you discover, and drop ones that turn out not to be needed. A new task gets a new list, and an empty list clears a plan you gave up on. Skip the plan for a one-step task or a question.',
      'The user sees the plan as it stands, so do not write it out again in your reply.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: `The whole plan, at most ${MAX_PLAN_ITEMS} steps, in order.`,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The step, in the imperative, short enough to read at a glance.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },
  // It touches nothing, so it may run beside the reads in the same message.
  parallel: true,
  // The list is text for the window and the transcript, so a secret in it stays a placeholder.
  keepsPlaceholders: true,
  parse: raw => {
    const read = readPlan(raw.todos)
    return read.ok ? { ok: true, args: { items: read.items } } : { ok: false, error: read.error }
  },
  async run({ items }) {
    if (items.length === 0) return { ok: true, summary: 'Plan cleared.', content: 'Plan cleared.' }
    const { done, total, current } = planProgress(items)
    const working = items.filter(item => item.status === 'in_progress').length
    const lines = [`Plan updated, ${done} of ${total} done.`]
    if (current !== undefined) lines.push(`Now: ${current.content}`)
    // The call still succeeds with a note. The window draws two live steps
    // well enough, and a refusal would cost the model a round to say it again.
    if (working > 1) lines.push(`${working} steps are in_progress; keep one at a time.`)
    const text = lines.join(' ')
    return { ok: true, summary: text, content: text }
  },
})
