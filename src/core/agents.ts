// doc: docs/harness/agents.md
import { EOL } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSystemPrompt } from './prompt.js'
import type { PromptEnvironment } from './prompt.js'
import type { Effort } from './config.js'

/**
 * Three roles, one session at a time (plan §5). A role is not a personality:
 * it is the set of tools the agent gets, how hard it thinks by default, and
 * the paragraph of context it is worth paying for on every request.
 *
 * The registry is data rather than three subclasses, because every consumer —
 * the session builder, the spawn tool's schema, the role chip in the composer
 * — needs to enumerate the roles, and a list is the only shape all three can
 * read.
 */

export type AgentRole = 'builder' | 'planner' | 'harness-editor'

export const AGENT_ROLES: readonly AgentRole[] = ['builder', 'planner', 'harness-editor']

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value)
}

export interface AgentDefinition {
  role: AgentRole
  /** What the role is called in the window. */
  name: string
  /** One line, shown in the UI and in the spawn tool's description. */
  purpose: string
  /** Tool names this role may call. A tool not named here is not offered. */
  tools: readonly string[]
  /**
   * `guarded` swaps the shell for one that refuses the obvious ways to write.
   * It is a screen, not a sandbox — see `writeGuard` in `src/tools/bash.ts`.
   */
  bash: 'full' | 'guarded' | 'none'
  /**
   * How hard this role thinks when nobody has said otherwise. Planning is the
   * role whose whole output is reasoning, and it cannot write anything, so it
   * is the one worth paying thinking tokens for; the harness editor works from
   * a ledger entry that already says what to do.
   */
  defaultEffort: Effort
  /** Role-specific lines appended to the shared system prompt. */
  brief: readonly string[]
}

export const AGENTS: Record<AgentRole, AgentDefinition> = {
  builder: {
    role: 'builder',
    name: 'Builder',
    purpose: 'writes code in the workspace',
    tools: ['bash', 'read', 'write', 'log_improvement', 'spawn', 'job_update'],
    bash: 'full',
    defaultEffort: 'medium',
    brief: [
      'You are the builder: you change code in this workspace.',
      'Read a file before you edit it, and keep the change the size of the request.',
    ],
  },
  planner: {
    role: 'planner',
    name: 'Planner',
    purpose: 'reads and researches, and never writes',
    tools: ['bash', 'read', 'log_improvement', 'spawn', 'job_update'],
    bash: 'guarded',
    defaultEffort: 'high',
    brief: [
      'You are the planner: you read and reason, and you do not change files.',
      'Your shell refuses the usual ways to write, so use it to look, not to edit.',
      'Answer with the plan itself — the files that matter, the order of the work,',
      'and what would make it fail — not with an offer to write the code.',
    ],
  },
  'harness-editor': {
    role: 'harness-editor',
    name: 'Harness editor',
    purpose: 'edits NanoHarness itself, from the improvement ledger',
    tools: ['bash', 'read', 'write', 'log_improvement', 'job_update'],
    bash: 'full',
    defaultEffort: 'low',
    brief: [
      'You are the harness editor: the workspace is NanoHarness itself.',
      'Work from the improvement ledger. Every source file names the doc that',
      'explains it and every doc lists its files back, so a code change that',
      'adds or moves a file changes a doc too; `pnpm doc-check` is the gate.',
      'Never run git commit, git push or git tag. Suggest the commands instead.',
    ],
  },
}

/**
 * The extra context a role is worth carrying. The harness editor gets the doc
 * index and the ledger, which is what turns "fix the thing" into an edit in
 * the right file; the other two get the environment block and nothing more.
 *
 * Read from the workspace, so it is empty when the folder is not the harness —
 * a stale index would be worse than none.
 */
export async function roleContext(role: AgentRole, root: string): Promise<string[]> {
  if (role !== 'harness-editor') return []
  const index = await docIndex(root)
  if (index.length === 0) return []
  return ['', 'The docs that explain this codebase, one line each:', ...index, '', 'The improvement ledger is docs/harness/improvements.md.']
}

/** The `## Index` bullets of the doc map: path plus one line, nothing else. */
async function docIndex(root: string): Promise<string[]> {
  const text = await readFile(join(root, 'docs', 'harness', 'doc-map.md'), 'utf8').catch(() => null)
  if (text === null) return []
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === '## Index')
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- ')) out.push(line)
    else if (out.length > 0 && line.trim() === '') break
  }
  return out
}

/** The whole system prompt for one role: the shared block, then its brief. */
export function agentPrompt(role: AgentRole, env: PromptEnvironment, extra: readonly string[] = []): string {
  return [buildSystemPrompt(env), '', ...AGENTS[role].brief, ...extra].join(EOL)
}
