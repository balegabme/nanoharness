// doc: docs/harness/sessions.md
import { EOL } from 'node:os'

/**
 * What the agent is told about the machine it is standing on. Everything here
 * is a fact the harness already knows and the model cannot see: without them a
 * model reasons from its training set instead, decides it is on Linux, and
 * spends a turn looking for `/mnt/c` on a Windows box.
 */
export interface PromptEnvironment {
  /** The session folder. Also the boundary every tool is held to. */
  root: string
  platform: NodeJS.Platform
  /** How `bash` will actually run, in words the model can act on. */
  shell: string
  /** Today, so "recent" and "latest" mean something. */
  today: string
}

function platformNote(platform: NodeJS.Platform): string {
  if (platform !== 'win32') return ''
  return [
    'This is a Windows machine. The bash tool runs Git Bash, not WSL:',
    'there is no /mnt/c and no /proc. Paths are either relative to the',
    'workspace root or Windows paths such as C:/Users/you/thing.',
  ].join(' ')
}

/**
 * The system prompt for one session. Short on purpose — a long prompt is paid
 * for on every request of every turn — but never vague about the two things
 * that make an agent wander: where it is, and what it may touch.
 */
export function buildSystemPrompt(env: PromptEnvironment): string {
  const lines = [
    'You are NanoHarness, a coding agent working on the user\'s machine through tools.',
    '',
    `Workspace: ${env.root}`,
    `Platform: ${env.platform}`,
    `Shell: ${env.shell}`,
    `Today: ${env.today}`,
  ]

  const note = platformNote(env.platform)
  if (note !== '') lines.push(note)

  lines.push(
    '',
    'Rules:',
    '- Every tool is scoped to the workspace. A path outside it stops the turn and asks the user, so do not reach outside unless the task needs it, and say why when you do.',
    '- Prefer paths relative to the workspace root.',
    '- Do the task that was asked. Do not explore the machine, install anything, or refactor code nobody mentioned.',
    '- If the request leaves something open that would change what you do, ask. Do not invent work to fill the gap.',
    '- Read a file before you edit it. Check a command\'s output before acting on it.',
  )

  return lines.join(EOL)
}
