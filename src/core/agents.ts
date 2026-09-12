// doc: docs/harness/agents.md
import { EOL } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSystemPrompt } from './prompt.js'
import type { PromptEnvironment } from './prompt.js'

/**
 * Three roles, one session at a time (plan §5). A role is not a personality:
 * it is the set of tools the agent gets and the paragraph of context it is
 * worth paying for on every request. Effort is not part of it: how hard to
 * think is the user's setting, and a role that quietly overrode it made the
 * chip on the composer a lie for every agent but the builder.
 *
 * The registry is data rather than three subclasses, because every consumer
 * needs to enumerate the roles: the session builder, the spawn tool's schema
 * and the role chip in the composer. A list is the only shape all three can
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
   * It is a screen, not a sandbox. See `writeGuard` in `src/tools/bash.ts`.
   */
  bash: 'full' | 'guarded' | 'none'
  /** Role-specific lines appended to the shared system prompt. */
  brief: readonly string[]
}

/**
 * Prompt to instruct when and how to summon a harness editor subagent
 */
const HARNESS_HANDOFF: readonly string[] = [
  'Anything about NanoHarness itself goes to a harness-editor subagent: changing it, configuring it, adding an MCP server or a skill, or a question about how it behaves. Use `spawn` with role harness-editor and mode distinct.',
  'Answer it yourself only when the answer is already in this conversation. Anything else means reading the harness, and this prompt does not tell you where it is: the subagent is told, knows its way around, and is back in a couple of calls.',
  'Write the task as the outcome you want plus whatever the user gave you, quoted verbatim: a URL, a key, a command line. It cannot see this conversation.',
  'Do not write the mechanism into the task: not the file to edit, not the field names, not the format, not which command to run. You have not read the harness and it has. A guess you put in the task arrives as a requirement, and the subagent then spends its rounds satisfying or disproving something you made up.',
  'Ask it to report the files it touched and the diff, and pass that on rather than a claim that it worked.',
]

export const AGENTS: Record<AgentRole, AgentDefinition> = {
  builder: {
    role: 'builder',
    name: 'Builder',
    purpose: 'writes code in the workspace',
    tools: ['bash', 'read', 'write', 'log_improvement', 'spawn', 'job_update'],
    bash: 'full',
    brief: [
      'You are the builder: you change code in this workspace.',
      'Read a file before you edit it, and keep the change the size of the request.',
      ...HARNESS_HANDOFF,
    ],
  },
  planner: {
    role: 'planner',
    name: 'Planner',
    purpose: 'reads and researches, and never writes',
    tools: ['bash', 'read', 'log_improvement', 'spawn', 'job_update'],
    bash: 'guarded',
    brief: [
      'You are the planner: you read and reason, and you do not change files.',
      'Your shell refuses the usual ways to write, so use it to look, not to edit.',
      'Answer with the plan itself: the files that matter, the order of the work,',
      'and what would make it fail. Do not answer with an offer to write the code.',
      ...HARNESS_HANDOFF,
    ],
  },
  'harness-editor': {
    role: 'harness-editor',
    name: 'Harness editor',
    purpose: 'answers questions about NanoHarness and edits it',
    tools: ['bash', 'read', 'write', 'log_improvement', 'job_update'],
    bash: 'full',
    brief: [
      'You are the harness editor: you answer questions about NanoHarness and you change it.',
      'You are the only role told where the harness lives, so those questions come to you. Answer them.',
      'Do not wander. The doc map in your context says which file explains what: open that file, not a search. A couple of calls to an answer is the shape of your work.',
      'The harness configures itself through its own CLI: its config files, meaning MCP servers and anything else `nh` writes, are not to be hand-edited, and their format is not to be derived from the source. Run the command, `--help` first if you do not know the flags. One help call is cheaper than reading the parser, and the command refuses an entry the harness would ignore, which hand-written JSON does not.',
      'The task you are given was written by an agent that has not read this code. Where it names a file, a field or a mechanism, treat that as a guess: do what the harness actually does, and say in your report that you did something else and why. Do not research a wrong assumption to exhaustion: correct it in one line and finish the job.',
      'Work from the improvement ledger. Every source file names the doc that explains it and every doc lists its files back, so a code change that adds or moves a file changes a doc too; `pnpm doc-check` is the gate.',
      'Never run git commit, git push or git tag. Suggest the commands instead.',
      'End with what you actually changed: the files, and `git diff --stat` (or the diff itself) for them. Whoever asked sees your last message and nothing else, so a claim with no diff behind it is all they get.',
      'A change to the harness reaches the running app when it is rebuilt and restarted. Say so; do not report it as live.',
    ],
  },
}

/**
 * Where NanoHarness's own code is on this machine, and how to run its CLI from
 * anywhere. Both are facts the app knows and the agent cannot see, and both are
 * the difference between answering a question about the harness and asking the
 * user for permission to go and look.
 */
export interface HarnessFacts {
  root: string
  /** The whole command, ready to run: `"<node>" "<path>/cli/index.js"`. */
  cli: string
}

/**
 * The extra context a role is worth carrying.
 *
 * Where the harness lives is one role's fact. The harness editor alone is told
 * the source root, the doc map and the CLI command; builder and planner get
 * nothing, which is what keeps their handoff rule honest: an agent whose
 * prompt never names the harness cannot go and read it, so the subagent is the
 * only route an answer can take. The editor also gets the doc index and the
 * ledger, which is what turns "fix the thing" into an edit in the right file.
 *
 * The index is read from the harness checkout when the facts are known, and
 * from the workspace only as a fallback, for the case where the app is packaged
 * but the session is open on a checkout anyway.
 */
export async function roleContext(role: AgentRole, root: string, harness?: HarnessFacts): Promise<string[]> {
  if (role !== 'harness-editor') return []
  const lines: string[] = []
  if (harness !== undefined) {
    lines.push(
      '',
      `NanoHarness, the harness you are running in, is source you can read at ${harness.root}. That folder is readable without asking, even from another workspace; ${join(harness.root, 'docs', 'harness', 'doc-map.md')} is the index of what explains what.`,
      `Its CLI is ${harness.cli}: append a command and run it from any folder. It is how the harness is configured: \`nh --help\` lists the areas, \`nh mcp --help\` (or any area) lists its flags, and \`nh mcp add\`/\`remove\` write the config files so you never hand-edit them.`,
    )
  }
  const index = await docIndex(harness?.root ?? root)
  if (index.length === 0) return lines
  return [...lines, '', 'The docs that explain this codebase, one line each:', ...index, '', 'The improvement ledger is docs/harness/improvements.md.']
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
