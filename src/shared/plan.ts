// doc: docs/harness/shared.md
import { isJsonObject } from './json.js'

/**
 * The plan an agent keeps with `todo_write`. The tool checks the model's list
 * with `readPlan`, and the window reads the same arguments back out of the
 * call to draw the plan above the composer. The call in the transcript is the
 * only copy there is, so a session opened tomorrow shows the plan it ended
 * with and nothing has to be stored twice.
 */

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanItem {
  /** The step, in the imperative: "Add the timeout argument". */
  content: string
  status: PlanStatus
}

/** Items in one plan, enough for the steps of one task. */
export const MAX_PLAN_ITEMS = 20

const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed']

/** The list the model sent, checked, or the reason it cannot be kept. */
export function readPlan(raw: unknown): { ok: true; items: PlanItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'todos must be an array' }
  if (raw.length > MAX_PLAN_ITEMS) return { ok: false, error: `a plan holds at most ${MAX_PLAN_ITEMS} items` }
  const items: PlanItem[] = []
  for (const [index, item] of raw.entries()) {
    if (!isJsonObject(item)) return { ok: false, error: `item ${index + 1} must be an object` }
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    if (content === '') return { ok: false, error: `item ${index + 1} needs content` }
    const status = item.status
    if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
      return { ok: false, error: `item ${index + 1}: status must be pending, in_progress or completed` }
    }
    items.push({ content, status: status as PlanStatus })
  }
  return { ok: true, items }
}

/** The plan out of a `todo_write` call's raw arguments, or null when they do not hold one. */
export function planFromArgs(args: string): PlanItem[] | null {
  try {
    const parsed: unknown = JSON.parse(args)
    if (!isJsonObject(parsed)) return null
    const read = readPlan(parsed.todos)
    return read.ok ? read.items : null
  } catch {
    return null
  }
}

/** How far along the plan is, as the widget and the tool result both count it. */
export function planProgress(items: readonly PlanItem[]): { done: number; total: number; current: PlanItem | undefined } {
  return {
    done: items.filter(item => item.status === 'completed').length,
    total: items.length,
    current: items.find(item => item.status === 'in_progress'),
  }
}
