// doc: docs/harness/agents.md
import { defineTool } from '../core/session.js'
import type { ArgsParse } from '../core/session.js'
import type { ToolResult } from '../core/types.js'

type JobUpdateArgs = { note: string }

const NOTE_CAP = 200

function parseArgs(args: Record<string, unknown>): ArgsParse<JobUpdateArgs> {
  if (typeof args.note !== 'string' || args.note.trim() === '') return { ok: false, error: 'note must be a non-empty string' }
  return { ok: true, args: { note: args.note.trim() } }
}

/**
 * How a background job says where it has got to. Nobody is reading its stream —
 * a job runs while the user is doing something else — so this line is the only
 * thing the window can show between "started" and the final answer.
 */
export const JOB_UPDATE_TOOL = defineTool<JobUpdateArgs>({
  input: {
    name: 'job_update',
    description:
      'Report progress on the background job you are running as. One short line, in the window, for the person who started it. Use it when you finish a step, not for every tool call.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'one line: what is done, what is next' } },
      required: ['note'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run({ note }, { job }): Promise<ToolResult> {
    if (job === undefined) {
      const no = 'job_update only works inside a background job; say it in your answer instead'
      return { ok: false, summary: no, content: no, isError: true }
    }
    const line = note.length > NOTE_CAP ? `${note.slice(0, NOTE_CAP - 1)}…` : note
    const posted = job.jobs.update(job.id, line)
    return posted
      ? { ok: true, summary: 'posted', content: 'posted' }
      : { ok: false, summary: 'this job is no longer running', content: 'this job is no longer running', isError: true }
  },
})
