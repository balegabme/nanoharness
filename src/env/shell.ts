// doc: docs/harness/env-detection.md
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * The shell every command the harness runs goes through: the `bash` tool, the
 * hooks and the environment probe. One place decides which bash that is and
 * what PATH it starts with, so the three of them agree about the machine.
 */

/** Kills the PATH probe if a profile never returns. */
const PROBE_TIMEOUT_MS = 120_000

function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash'
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  return candidates.find(existsSync) ?? null
}

/** The bash binary, or null on a Windows machine without Git for Windows. */
export const bashBin = findBash()

/**
 * The PATH a login shell would have, read once in the background. Sourcing the
 * profile costs three to four seconds on an idle Windows machine, and it is
 * the only source of `~/.local/bin`, `~/.cargo/bin` and the PATH a
 * GUI-launched app inherits on macOS. Git Bash prepends `/mingw64/bin` and
 * `/usr/bin` either way.
 *
 * A command that arrives before the read settles starts its own login shell,
 * and so does every command if the read fails. On Windows `cygpath -w -p`
 * converts the value back to Windows form without losing a segment.
 */
let reading: Promise<void> | undefined
let loginPath: string | undefined

/**
 * Starts the PATH read, and settles when it has finished, found or not. Safe
 * to call twice, and optional: the app starts it without waiting, and a test
 * waits so its commands skip the profile.
 */
export function warmShell(): Promise<void> {
  return bashBin === null ? Promise.resolve() : readLoginPath(bashBin)
}

function readLoginPath(bin: string): Promise<void> {
  reading ??= new Promise<void>(resolve => {
    const print = process.platform === 'win32' ? 'cygpath -w -p "$PATH"' : 'printf %s "$PATH"'
    execFile(bin, ['-lc', print], { windowsHide: true, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      const value = stdout.trim()
      if (error === null && value !== '') loginPath = value
      resolve()
    })
  })
  return reading
}

/** How to start bash: the binary, the flags that go before anything else, and the environment. */
export interface ShellLaunch {
  bin: string
  /** `-l` until the login PATH is known. Once it is, the profile has nothing left to add. */
  args: string[]
  env: NodeJS.ProcessEnv
}

/** Null when there is no bash to launch. Starts the PATH read if nothing has yet. */
export function shellLaunch(): ShellLaunch | null {
  if (bashBin === null) return null
  void readLoginPath(bashBin)
  const path = loginPath
  return path === undefined
    ? { bin: bashBin, args: ['-l'], env: process.env }
    : { bin: bashBin, args: [], env: { ...process.env, PATH: path } }
}
