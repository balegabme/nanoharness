// doc: docs/harness/cli.md
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const SRC_DIR = 'src'
const DOC_DIR = 'docs/harness'
const DOC_TAG = /^\/\/ doc:\s*(\S+?\.md)(?:#\S+)?\s*$/
const HEADER_LINES = 5

// The map itself and the ledger describe the convention rather than code, so
// they are the only docs allowed to have no `Files:` section.
const DOCLESS = new Set(['doc-map.md', 'improvements.md'])

export interface DocCheckResult {
  errors: string[]
  sourceFiles: number
  docFiles: number
}

export async function docCheck(root: string): Promise<DocCheckResult> {
  // A missing directory has to be an error, not an empty scan: a wrong path
  // would otherwise report "no problems" and turn the CI gate green.
  for (const dir of [SRC_DIR, DOC_DIR]) {
    const info = await stat(join(root, dir)).catch(() => null)
    if (!info?.isDirectory()) {
      return { errors: [`${dir}: not a directory under ${root}`], sourceFiles: 0, docFiles: 0 }
    }
  }

  const sources = await walk(join(root, SRC_DIR), root)
  const docs = await listDocs(join(root, DOC_DIR), root)
  const errors: string[] = []

  const docLists = new Map<string, Set<string>>()
  for (const doc of docs) {
    const text = await readFile(join(root, doc), 'utf8')
    const listed = filesSection(text)
    if (listed === null) {
      if (!DOCLESS.has(doc.slice(DOC_DIR.length + 1))) {
        errors.push(`${doc}: no "Files:" section (doc-map rule 2)`)
      }
      continue
    }
    docLists.set(doc, listed)
    for (const file of listed) {
      if (!sources.includes(file)) errors.push(`${doc}: lists ${file}, which does not exist`)
    }
  }

  for (const file of sources) {
    const text = await readFile(join(root, file), 'utf8')
    const doc = docTag(text)
    if (doc === null) {
      errors.push(`${file}: missing "// doc: ${DOC_DIR}/<file>.md" header (doc-map rule 1)`)
      continue
    }
    if (!docs.includes(doc)) {
      errors.push(`${file}: doc link points at ${doc}, which does not exist`)
      continue
    }
    if (!docLists.get(doc)?.has(file)) {
      errors.push(`${doc}: does not list ${file} under "Files:" (doc-map rule 2)`)
    }
  }

  return { errors: errors.sort(), sourceFiles: sources.length, docFiles: docs.length }
}

function docTag(text: string): string | null {
  for (const line of text.split('\n').slice(0, HEADER_LINES)) {
    const match = DOC_TAG.exec(line.trim())
    if (match?.[1]) return match[1]
  }
  return null
}

// A `Files:` section is the run of `- path — summary` bullets that follows the
// heading, ending at the first blank line.
function filesSection(text: string): Set<string> | null {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() === 'Files:')
  if (start === -1) return null
  const files = new Set<string>()
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (trimmed === '') break
    const match = /^-\s+(\S+)/.exec(trimmed)
    if (match?.[1]) files.add(match[1])
  }
  return files
}

async function walk(dir: string, root: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, root)))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(toPosix(relative(root, full)))
  }
  return out.sort()
}

async function listDocs(dir: string, root: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => toPosix(relative(root, join(dir, e.name))))
    .sort()
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}
