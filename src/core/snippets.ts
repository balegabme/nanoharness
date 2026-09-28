// doc: docs/harness/commands.md
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatter } from './skills.js'

/**
 * Prompt snippets (plan §9): short directives the user adds to a message from
 * the composer. They go into the user's message and never into the system
 * prompt, so adding one moves nothing the provider has cached.
 *
 * Three folders are read, each overriding the one before by file name: the
 * snippets shipped with the app, the user's own in the data directory, and a
 * project's in `.nanoharness/snippets/`.
 */

export type SnippetPlacement = 'prepend' | 'append'
export type SnippetSource = 'built-in' | 'user' | 'project'

export interface Snippet {
  /** The file name, which is what a later folder overrides by. */
  file: string
  name: string
  description: string
  placement: SnippetPlacement
  order: number
  body: string
  source: SnippetSource
}

/** Where a project keeps its snippets. */
export const SNIPPETS_DIR = join('.nanoharness', 'snippets')

/** A snippet with no `order` sorts after every one that has one. */
const UNORDERED = Number.MAX_SAFE_INTEGER

/**
 * One file. The name falls back to the file name and the placement to
 * `prepend`. A file with nothing after its frontmatter is no snippet.
 */
function parseSnippet(file: string, text: string, source: SnippetSource): Snippet | null {
  const fields = parseFrontmatter(text)
  const lines = text.split(/\r?\n/)
  const close = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && line.trim() === '---') : -1
  const body = (close === -1 ? text : lines.slice(close + 1).join('\n')).trim()
  if (body === '') return null
  const order = Number(fields.order)
  return {
    file,
    name: fields.name ?? file.replace(/\.md$/i, ''),
    description: fields.description ?? '',
    placement: fields.placement === 'append' ? 'append' : 'prepend',
    order: fields.order !== undefined && Number.isFinite(order) ? order : UNORDERED,
    body,
    source,
  }
}

/** Every snippet across the folders, later ones winning by file name, sorted by `order` and then name. */
export async function loadSnippets(folders: readonly { dir: string; source: SnippetSource }[]): Promise<Snippet[]> {
  const byFile = new Map<string, Snippet>()
  for (const { dir, source } of folders) {
    const names = await readdir(dir).catch(() => [])
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.md') || name.toLowerCase() === 'readme.md') continue
      const text = await readFile(join(dir, name), 'utf8').catch(() => null)
      const snippet = text === null ? null : parseSnippet(name, text, source)
      if (snippet !== null) byFile.set(name, snippet)
    }
  }
  return [...byFile.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}
