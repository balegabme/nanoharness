// doc: docs/harness/overview.md
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

/**
 * Two roots, and they are never the same thing:
 *
 * - the **workspace** is the project the harness is working on (`cwd`);
 * - the **harness root** is the nanoharness install itself.
 *
 * The harness-editor agent edits the harness, so it runs with the harness root
 * as its cwd — not the workspace it happens to have been invoked from (plan §5:
 * "full, harness-repo-scoped"). Keeping the two apart here means no caller has
 * to remember the distinction.
 */

/** Root of the nanoharness install. At runtime this file is `out/core/roots.js`. */
export function harnessRoot(): string {
  return resolve(fileURLToPath(new URL('../../', import.meta.url)))
}

async function packageName(dir: string): Promise<string | null> {
  const manifest = await readFile(join(dir, 'package.json'), 'utf8').catch(() => null)
  if (manifest === null) return null
  try {
    const parsed: unknown = JSON.parse(manifest)
    if (typeof parsed !== 'object' || parsed === null) return null
    const name = (parsed as { name?: unknown }).name
    return typeof name === 'string' ? name : null
  } catch {
    // an unreadable manifest just means "not the nanoharness repo"
    return null
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  return info?.isDirectory() ?? false
}

/** True when `dir` is the nanoharness repo — i.e. the harness is its own workspace. */
export async function isHarnessRepo(dir: string): Promise<boolean> {
  return (await packageName(dir)) === 'nanoharness'
}

/**
 * The cwd a harness-editor agent gets. It is the harness root, and only if that
 * root is an editable source checkout: a packaged install has no `src/` to edit
 * and is never written to (plan §4 rule 5), so ask for a checkout instead of
 * silently editing files inside the app bundle.
 */
export async function harnessEditorCwd(): Promise<string> {
  const root = harnessRoot()
  if ((await isHarnessRepo(root)) && (await isDirectory(join(root, 'src')))) return root
  throw new Error(
    `harness-editor needs a nanoharness source checkout; ${root} is a packaged install. Run the harness from a clone to let it edit itself.`,
  )
}
