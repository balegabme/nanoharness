// doc: docs/harness/skills.md
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Skills, Claude-style and no larger: a folder with a `SKILL.md` whose
 * frontmatter says what it is for (plan §8).
 *
 * The prompt carries the list and not the documents: one line per skill, name
 * and description and path. A skill is often a long document, and the prompt
 * is paid for on every request of every turn. The agent reads the one it needs
 * with the tool it already has.
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
 * Frontmatter, only as much of YAML as the format uses: `key: value` lines
 * between two `---` fences.
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
 * same bytes on every request and the prompt cache survives the turn.
 *
 * A folder without a readable `SKILL.md`, or without a name and a description
 * in it, is skipped.
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
 * workspace without any pays nothing at all.
 */
export function skillsBlock(skills: readonly SkillSummary[]): string[] {
  if (skills.length === 0) return []
  return [
    '',
    'Skills available in this workspace. Each is a document with instructions for one kind of task.',
    'These lines are all you have been given; read the file when a task matches one, and not before.',
    ...skills.map(skill => `- ${skill.name}: ${skill.description} (${skill.path})`),
  ]
}
