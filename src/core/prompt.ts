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
    'Git Bash prints its own spelling, /c/Users/you/thing, and every tool',
    'here takes either — so a path copied out of shell output works as it is.',
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
    '- Do the task that was asked: no unasked-for exploring, dependency installs, or refactors.',
    '- Never state a rule, a permission or a limit you were not given. Asked what you can do, answer from the tools and the configuration in this prompt: something that is not configured is not configured, which is not the same as forbidden, and you say which one it is.',
    '- If the request leaves something open that would change what you do, ask. Do not invent work to fill the gap.',
    '- Read a file before you edit it. Check a command\'s output before acting on it.',
    '- Look around with `bash`. One command that lists, greps or cats what you need beats a stack of single-file calls: it costs one round trip instead of five, and the user can read it. `read` is for one file you know you want.',
    '- Remove exactly what was named and nothing around it. Deleting the entry you were asked about does not license deleting the file it lived in, or the folder that held it. Then say what you removed, by path.',
  )

  return lines.join(EOL)
}
