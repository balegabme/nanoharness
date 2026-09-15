// doc: docs/harness/agents.md
import { defineTool } from '../core/session.js'
import { AGENTS, AGENT_ROLES, isAgentRole } from '../core/agents.js'
import { SPAWN_MODES, isSpawnMode } from '../core/spawn.js'
import type { ArgsParse } from '../core/session.js'
import type { AgentRole } from '../core/agents.js'
import type { SpawnMode } from '../core/spawn.js'
import type { ToolResult, ToolStats } from '../core/types.js'

type SpawnArgs = { role: AgentRole; mode: SpawnMode; task: string; background: boolean }

function parseArgs(args: Record<string, unknown>): ArgsParse<SpawnArgs> {
  if (!isAgentRole(args.role)) return { ok: false, error: `role must be one of ${AGENT_ROLES.join(', ')}` }
  if (typeof args.task !== 'string' || args.task.trim() === '') return { ok: false, error: 'task must be a non-empty string' }
  // Left unsaid, the cheap mode is the default: most delegated work does carry
  // on this conversation. The description says which work does not.
  const mode = args.mode === undefined ? 'clone' : args.mode
  if (!isSpawnMode(mode)) return { ok: false, error: `mode must be one of ${SPAWN_MODES.join(', ')}` }
  if (args.background !== undefined && typeof args.background !== 'boolean') {
    return { ok: false, error: 'background must be a boolean' }
  }
  return { ok: true, args: { role: args.role, mode, task: args.task, background: args.background === true } }
}

const roles = AGENT_ROLES.map(role => `${role} (${AGENTS[role].purpose})`).join('; ')

/**
 * What the subagent did to reach its answer, as the line under its card: how
 * many calls it made, how many worked, how many came back an error.
 * `docs/harness/agents.md` says why an answer alone is not enough to go on.
 */
export function toolsText(tools: ToolStats): string {
  if (tools.calls === 0) return 'no tool calls'
  const plural = tools.calls === 1 ? 'tool call' : 'tool calls'
  return `${tools.calls} ${plural}, ${tools.ok} ok, ${tools.failed} failed`
}

export const SPAWN_TOOL = defineTool<SpawnArgs>({
  input: {
    name: 'spawn',
    description: [
      'Hand one self-contained piece of work to another agent and get its answer back.',
      `Roles: ${roles}.`,
      'Modes: clone reuses this conversation\'s prompt and history, so the provider\'s cache pays for most of it.',
      'distinct starts the agent from its own prompt with no history: it costs more, and that isolation is what you are buying.',
      'Pick by what the work needs, not by price. clone for work that continues this conversation: another pass over the file you are both looking at, a search whose terms only make sense from what was said here, more of a job already under way.',
      'distinct whenever this conversation would bias the answer or is beside the point: reviewing or verifying work done in this turn, a fresh read of code you have already described, an independent estimate, a question from a different part of the repo entirely.',
      'A reviewer, verifier or critic is always distinct: a clone has read your reasoning and will agree with it, which is the one thing a check must not do.',
      'Sequential work belongs in this loop, not in a subagent: splitting it up costs far more and finishes no sooner.',
      'State the task as the outcome you want, with anything the user gave you quoted verbatim: a distinct agent cannot see this conversation. For work you have not done yourself, do not prescribe the mechanism (the file, the field names, the format, the command): the agent doing it can see what you cannot, and a guess in the task becomes a requirement it has to satisfy or disprove. Ask it to report the files it touched and the diff.',
      'background: true returns a job id immediately and lets this turn carry on. You do not have to poll it or go looking for its output: when it finishes, what it answered is delivered into this conversation as a message, in full. That may be later in this turn or at the start of the next one, so start the ones you need early and use them when they land.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: [...AGENT_ROLES], description: 'which agent does the work' },
        mode: {
          type: 'string',
          enum: [...SPAWN_MODES],
          description:
            'clone (default, cheap, you again with this history) or distinct (the named role, from scratch, blind to this conversation, which is what a review or verification needs)',
        },
        task: { type: 'string', description: 'the outcome you want, stated so it can be reached without asking you anything' },
        background: { type: 'boolean', description: 'do not wait for it; its answer is delivered to you in full when it finishes' },
      },
      required: ['role', 'task'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  // The task becomes a subagent's first message, so it must stay as written: a
  // key substituted in here would be sent to the provider by the child.
  keepsPlaceholders: true,
  async run({ role, mode, task, background }, { spawn }): Promise<ToolResult> {
    if (spawn === undefined) {
      const no = 'spawn is not available here: a subagent cannot summon another one'
      return { ok: false, summary: no, content: no, isError: true }
    }

    if (background) {
      const job = spawn.background({ role, mode, task })
      // The marker is how the window finds the subagent behind a tool call, in
      // a live turn and in a transcript re-opened a week later: it is stored
      // with the result, so the conversation itself points at the subagent's
      // own conversation.
      const note = `started ${job.role}/${job.mode} as background job ${job.id}. Do not wait for it and do not go looking for its output: when it finishes, what it answered arrives here as a message. It only survives while the app is open, so do not end the work on the promise of one: say what you have, and what is still out. [subagent:${job.id}]`
      return { ok: true, summary: note, content: note }
    }

    const result = await spawn.run({ role, mode, task })
    const cost = `[${role}/${result.mode}: ${toolsText(result.tools)} · in ${result.usage.input}, out ${result.usage.output}, cached ${result.usage.cacheRead}] [subagent:${result.id}]`
    return { ok: true, summary: result.summary, content: `${result.summary}\n\n${cost}` }
  },
})
