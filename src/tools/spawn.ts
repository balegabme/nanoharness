// doc: docs/harness/agents.md
import { defineTool } from '../core/session.js'
import { AGENTS, AGENT_ROLES, isAgentRole } from '../core/agents.js'
import { SPAWN_MODES, isSpawnMode } from '../core/spawn.js'
import type { ArgsParse } from '../core/session.js'
import type { AgentRole } from '../core/agents.js'
import type { SpawnMode } from '../core/spawn.js'
import type { ToolResult } from '../core/types.js'

type SpawnArgs = { role: AgentRole; mode: SpawnMode; task: string; background: boolean }

function parseArgs(args: Record<string, unknown>): ArgsParse<SpawnArgs> {
  if (!isAgentRole(args.role)) return { ok: false, error: `role must be one of ${AGENT_ROLES.join(', ')}` }
  if (typeof args.task !== 'string' || args.task.trim() === '') return { ok: false, error: 'task must be a non-empty string' }
  // A mode is a cost decision, and the cheap one is the safe default.
  const mode = args.mode === undefined ? 'clone' : args.mode
  if (!isSpawnMode(mode)) return { ok: false, error: `mode must be one of ${SPAWN_MODES.join(', ')}` }
  if (args.background !== undefined && typeof args.background !== 'boolean') {
    return { ok: false, error: 'background must be a boolean' }
  }
  return { ok: true, args: { role: args.role, mode, task: args.task, background: args.background === true } }
}

const roles = AGENT_ROLES.map(role => `${role} (${AGENTS[role].purpose})`).join('; ')

export const SPAWN_TOOL = defineTool<SpawnArgs>({
  input: {
    name: 'spawn',
    description: [
      'Hand one self-contained piece of work to another agent and get its answer back.',
      `Roles: ${roles}.`,
      'Modes: clone reuses this conversation\'s prompt and history, so the provider\'s cache pays for most of it — use it by default.',
      'distinct starts the agent from its own prompt with no history: more expensive, and only worth it when it must not see this conversation.',
      'Sequential work belongs in this loop, not in a subagent: splitting it up costs far more and finishes no sooner.',
      'background: true returns a job id immediately and reports in the window while this turn carries on.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: [...AGENT_ROLES], description: 'which agent does the work' },
        mode: { type: 'string', enum: [...SPAWN_MODES], description: 'clone (default, cheap, you again) or distinct (the named role, from scratch)' },
        task: { type: 'string', description: 'the whole job, stated so it can be done without asking you anything' },
        background: { type: 'boolean', description: 'do not wait for it; this is what "as a job" means' },
      },
      required: ['role', 'task'],
      additionalProperties: false,
    },
  },
  parse: parseArgs,
  async run({ role, mode, task, background }, { spawn }): Promise<ToolResult> {
    if (spawn === undefined) {
      const no = 'spawn is not available here: a subagent cannot summon another one'
      return { ok: false, summary: no, content: no, isError: true }
    }

    if (background) {
      const job = spawn.background({ role, mode, task })
      const note = `started ${job.role}/${job.mode} as background job ${job.id}. It reports in the window; do not wait for it.`
      return { ok: true, summary: note, content: note }
    }

    const result = await spawn.run({ role, mode, task })
    const cost = `[${role}/${result.mode}: in ${result.usage.input}, out ${result.usage.output}, cached ${result.usage.cacheRead}]`
    return { ok: true, summary: result.summary, content: `${result.summary}\n\n${cost}` }
  },
})
