// doc: docs/harness/skills.md
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Skills, Claude-style and no larger: a folder with a `SKILL.md` whose
 * frontmatter says what it is for (plan §8).
 *
 * The whole design is one decision — what gets injected. A skill is a document,
 * often a long one, and putting the documents in the system prompt would mean
 * paying for every skill on every request of every turn whether or not the task
 * has anything to do with them. So the prompt carries the *list*: one line per
 * skill, name and description and path. The agent reads the one it needs with
 * the tool it already has.
 */

export interface SkillSummary {
  name: string
  description: string
  /** Relative to the workspace root, because that is how the agent reads it. */
  path: string
}

/** Where a workspace keeps its skills. One folder, one skill. */
export const SKILLS_DIR = join('.nanoharness', 'skills')

/**
 * Frontmatter, only as much of YAML as the format actually uses: `key: value`
 * lines between two `---` fences. A skill file is written by hand, and a parser
 * that accepts anchors and block scalars would be more code than the feature.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const fields: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const cut = line.indexOf(':')
    if (cut <= 0) continue
    const key = line.slice(0, cut).trim()
    const value = line
      .slice(cut + 1)
      .trim()
      .replace(/^["'](.*)["']$/, '$1')
    if (key !== '' && value !== '') fields[key] = value
  }
  return fields
}

/**
 * Every skill in the workspace, sorted by name so the injected block is the
 * same bytes on every request — a list that reordered itself between turns
 * would invalidate the prompt cache for no reason at all.
 *
 * A folder without a readable `SKILL.md`, or without a name and a description
 * in it, is skipped rather than guessed at: a skill the agent cannot tell apart
 * from another one is worse than a skill it never hears about.
 */
export async function loadSkills(root: string): Promise<SkillSummary[]> {
  const dir = join(root, SKILLS_DIR)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (entries === null) return []

  const skills: SkillSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(SKILLS_DIR, entry.name, 'SKILL.md')
    const text = await readFile(join(root, path), 'utf8').catch(() => null)
    if (text === null) continue
    const fields = parseFrontmatter(text)
    const name = fields.name ?? entry.name
    const description = fields.description
    if (description === undefined) continue
    skills.push({ name, description, path: path.split('\\').join('/') })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The lines that go in the system prompt. Empty when there are no skills, so a
 * workspace without any pays nothing — not even a heading explaining that it
 * has none.
 */
export function skillsBlock(skills: readonly SkillSummary[]): string[] {
  if (skills.length === 0) return []
  return [
    '',
    'Skills available in this workspace. Each is a document with instructions for one kind of task.',
    'These lines are all you have been given; read the file when a task matches one, and not before.',
    ...skills.map(skill => `- ${skill.name} — ${skill.description} (${skill.path})`),
  ]
}
