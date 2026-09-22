import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKILLS_DIR, loadSkills, skillsBlock } from './skills.js'

/**
 * Skills are read off a real workspace, because the whole feature is about what
 * a folder on disk turns into: a few lines in the system prompt, and never the
 * documents themselves. A test with a hand-built array of summaries would prove
 * nothing about either half of that.
 */

let root: string

const BODY = 'Run the full suite, then tag the commit, then push the tag.'

async function skill(folder: string, frontmatter: string): Promise<void> {
  const dir = join(root, SKILLS_DIR, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `${frontmatter}\n\n# ${folder}\n\n${BODY}\n`, 'utf8')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nh-skills-'))
  await skill('release', '---\nname: release-checklist\ndescription: "What to do before tagging a release"\n---')
  await skill('audit', '---\nname: audit\ndescription: Read a diff for security problems\n---')
  // No description: the agent could not tell what it is for, so it is not offered.
  await skill('nameless', '---\nname: nameless\n---')
  // Not a skill at all. A stray folder is common; a crash over one is not acceptable.
  await mkdir(join(root, SKILLS_DIR, 'empty'), { recursive: true })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a workspace with skills', () => {
  it('reads the frontmatter and skips what it cannot describe', async () => {
    const skills = await loadSkills(root)
    expect(skills).toEqual([
      { name: 'audit', description: 'Read a diff for security problems', path: '.nanoharness/skills/audit/SKILL.md' },
      {
        name: 'release-checklist',
        description: 'What to do before tagging a release',
        path: '.nanoharness/skills/release/SKILL.md',
      },
    ])
  })

  it('injects the list and never the documents', async () => {
    const block = skillsBlock(await loadSkills(root)).join('\n')
    expect(block).toContain('- audit: Read a diff for security problems (.nanoharness/skills/audit/SKILL.md)')
    expect(block).toContain('- release-checklist: What to do before tagging a release (.nanoharness/skills/release/SKILL.md)')
    // The point of the whole design: the body is paid for only when read.
    expect(block).not.toContain(BODY)
  })

  it('is the same bytes on every request, whatever order the folders come back in', async () => {
    const once = skillsBlock(await loadSkills(root))
    const again = skillsBlock(await loadSkills(root))
    expect(again).toEqual(once)
  })
})

describe('a workspace with no skills', () => {
  it('pays nothing for the feature', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'nh-bare-'))
    expect(await loadSkills(bare)).toEqual([])
    expect(skillsBlock([])).toEqual([])
    await rm(bare, { recursive: true, force: true })
  })
})
