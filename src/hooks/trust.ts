// doc: docs/harness/hooks.md
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Which project hook files the user has approved. A project's hooks are
 * commands whoever wrote the project chose, so opening a cloned repository
 * must not be enough to run them. An approval names the workspace root and the
 * SHA-256 of the file the user was shown, so any edit to the file asks again.
 *
 * The file maps each root to the one hash approved for it. A refusal is kept
 * in memory for the rest of the run, so a file the user said no to is not
 * asked about again at every session they open.
 */
export class HookTrust {
  private readonly refused = new Set<string>()
  /** Writes run one after another, so two approvals landing together both survive. */
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async approved(root: string, hash: string): Promise<boolean> {
    const stored = await this.read()
    return stored[root] === hash
  }

  refusedThisRun(root: string, hash: string): boolean {
    return this.refused.has(key(root, hash))
  }

  approve(root: string, hash: string): Promise<void> {
    this.refused.delete(key(root, hash))
    const next = this.writing.then(async () => {
      const stored = await this.read()
      stored[root] = hash
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
    })
    // A failed write is the caller's to report. The chain carries on past it.
    this.writing = next.catch(() => undefined)
    return next
  }

  refuse(root: string, hash: string): void {
    this.refused.add(key(root, hash))
  }

  /** The stored approvals. A missing or unreadable file approves nothing. */
  private async read(): Promise<Record<string, string>> {
    const text = await readFile(this.file, 'utf8').catch(() => null)
    if (text === null) return {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [root, hash] of Object.entries(parsed)) if (typeof hash === 'string') out[root] = hash
      return out
    } catch {
      return {}
    }
  }
}

function key(root: string, hash: string): string {
  return `${root}\u0000${hash}`
}
