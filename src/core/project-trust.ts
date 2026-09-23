// doc: docs/harness/hooks.md
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { userDataDir } from './usage-log.js'

/**
 * A file inside a project that makes the harness run something: its hooks, or
 * the MCP servers it starts. Whoever wrote the project chose what is in it, so
 * opening a cloned repository must not be enough to run any of it.
 */
export interface ProjectFile {
  path: string
  /** The whole file, which is what the user is shown and what an approval covers. */
  text: string
  /** SHA-256 of the text, in hex. What an approval pins. */
  hash: string
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Where the approvals are kept: the app's data folder, which the CLI reads too. */
export function projectTrustPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userDataDir(env), 'project-trust.json')
}

/**
 * Which project files the user has approved. An approval names the file's path
 * and the SHA-256 of the text the user was shown, so any edit to the file asks
 * again, and approving one file in a folder approves nothing else in it.
 *
 * The store maps each path to the one hash approved for it. A refusal is kept
 * in memory for the rest of the run, so a file the user said no to is not
 * asked about again at every session they open. So is an approval, which then
 * holds for the run even when the store cannot be written.
 */
export class ProjectTrust {
  private readonly refused = new Set<string>()
  private readonly approvedThisRun = new Set<string>()
  /** Questions in flight, so two sessions opening in one folder at once ask the user once. */
  private readonly asking = new Map<string, Promise<boolean>>()
  /** Writes run one after another, so two approvals landing together both survive. */
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** Whether `file` has been approved in exactly this form. Asks nobody. */
  async approved(file: ProjectFile): Promise<boolean> {
    return this.approvedThisRun.has(key(file)) || (await this.read())[file.path] === file.hash
  }

  /**
   * Whether `file` may be used as it reads now: approved before in exactly
   * this form, or approved now by `ask`. A refusal holds until the app
   * restarts or the file changes. An approval that cannot be written holds
   * for this run, and the next launch asks again, which is the safe way for it
   * to fail.
   */
  check(file: ProjectFile, ask: () => Promise<boolean>): Promise<boolean> {
    const id = key(file)
    const pending = this.asking.get(id)
    if (pending !== undefined) return pending
    const asked = (async () => {
      if (await this.approved(file)) return true
      if (this.refused.has(id)) return false
      if (!(await ask())) {
        this.refused.add(id)
        return false
      }
      this.approvedThisRun.add(id)
      await this.approve(file).catch((err: unknown) => {
        process.stderr.write(`project trust: ${err instanceof Error ? err.message : String(err)}\n`)
      })
      return true
    })().finally(() => this.asking.delete(id))
    this.asking.set(id, asked)
    return asked
  }

  private approve(file: ProjectFile): Promise<void> {
    const next = this.writing.then(async () => {
      const stored = await this.read()
      stored[file.path] = file.hash
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
    })
    // A failed write is reported by `check`. The chain carries on past it.
    this.writing = next.catch(() => undefined)
    return next
  }

  /** The stored approvals. A missing or unreadable file approves nothing. */
  private async read(): Promise<Record<string, string>> {
    const text = await readFile(this.file, 'utf8').catch(() => null)
    if (text === null) return {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [path, hash] of Object.entries(parsed)) if (typeof hash === 'string') out[path] = hash
      return out
    } catch {
      return {}
    }
  }
}

function key(file: ProjectFile): string {
  return `${file.path}\u0000${file.hash}`
}
