// doc: docs/harness/env-detection.md
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { arch, release, type } from 'node:os'
import { shellLaunch, warmShell } from './shell.js'

/**
 * What the machine has, found out once per launch and written into every
 * system prompt. It sits in the cached prefix, so it holds nothing that moves
 * between two sessions of one launch: no clock, no load, no free disk.
 */
export interface HostFacts {
  /** The operating system and its release, in the words its users call it by. */
  os: string
  arch: string
  /** `bash 5.2.37`, with `(Git Bash)` on Windows, or null when there is no bash to run. */
  shell: string | null
  /** Whose `sed`, `grep` and `find` the shell has. Null when there is no shell to ask. */
  coreutils: 'GNU' | 'BSD' | null
  /** Each tool found, by the command that runs it, with its version. */
  tools: { command: string; version: string }[]
  /** The tools looked for and not found, by the name they are known by. */
  missing: string[]
}

/**
 * The tools looked for, each under every command it is installed as. Debian
 * installs fd as `fdfind`, and a Windows machine often has `python` and no
 * `python3`. The first command that answers with a version is the one
 * reported, since that is the one the agent should type.
 */
const TOOLS: readonly { name: string; commands: readonly string[] }[] = [
  { name: 'git', commands: ['git'] },
  { name: 'node', commands: ['node'] },
  { name: 'bun', commands: ['bun'] },
  { name: 'python', commands: ['python3', 'python'] },
  { name: 'pnpm', commands: ['pnpm'] },
  { name: 'npm', commands: ['npm'] },
  { name: 'yarn', commands: ['yarn'] },
  { name: 'rg', commands: ['rg'] },
  { name: 'fd', commands: ['fd', 'fdfind'] },
]

/**
 * Long enough for every `--version` on a cold Windows machine, where a package
 * manager's launcher can take a second or two to start. A probe that runs out
 * reports what it had found by then, and says nothing about the tools it did
 * not reach.
 */
const PROBE_TIMEOUT_MS = 20_000

const VERSION = /\d+\.\d+(?:\.\d+)?/

/**
 * One script, so the probe is one process and not a dozen. Each line is a
 * key, a tab and a value, and the last is `done`, which a probe that ran out
 * of time never prints. A `--version` that prints no version is how a Windows
 * store stub for `python3` answers, and it counts as not found.
 */
function probeScript(): string {
  const checks = TOOLS.flatMap(tool => tool.commands).map(command => `v ${command}`)
  return [
    `v() { command -v "$1" >/dev/null 2>&1 && printf '%s\\t%s\\n' "$1" "$("$1" --version 2>&1 | head -n 1)"; }`,
    `printf 'bash\\t%s\\n' "$BASH_VERSION"`,
    `if sed --version >/dev/null 2>&1; then printf 'coreutils\\tGNU\\n'; else printf 'coreutils\\tBSD\\n'; fi`,
    ...checks,
    `printf 'done\\t\\n'`,
  ].join('\n')
}

function finished(output: string): boolean {
  return /^done\t/m.test(output)
}

/** Parse the probe's output. Exported so the prompt block can be checked against a known machine. */
export function readProbe(output: string, machine: { os: string; arch: string; platform: NodeJS.Platform }): HostFacts {
  const found = new Map<string, string>()
  let shell: string | null = null
  let coreutils: HostFacts['coreutils'] = null
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const key = line.slice(0, tab)
    const value = line.slice(tab + 1)
    if (key === 'bash') {
      const version = VERSION.exec(value)?.[0]
      shell = `${version === undefined ? 'bash' : `bash ${version}`}${machine.platform === 'win32' ? ' (Git Bash)' : ''}`
    } else if (key === 'coreutils') {
      coreutils = value === 'GNU' ? 'GNU' : 'BSD'
    } else {
      const version = VERSION.exec(value)?.[0]
      if (version !== undefined) found.set(key, version)
    }
  }
  const tools: HostFacts['tools'] = []
  const missing: string[] = []
  const complete = finished(output)
  for (const tool of TOOLS) {
    const command = tool.commands.find(one => found.has(one))
    if (command !== undefined) tools.push({ command, version: found.get(command) as string })
    else if (complete) missing.push(tool.name)
  }
  return { os: machine.os, arch: machine.arch, shell, coreutils, tools, missing }
}

/**
 * The operating system as a person would name it. Linux says which
 * distribution it is in `/etc/os-release`; the kernel release alone does not
 * tell the agent whether to reach for `apt` or `dnf`.
 */
async function osName(): Promise<string> {
  const kind = type()
  if (kind === 'Windows_NT') return `Windows ${release()}`
  if (kind === 'Darwin') return `macOS (Darwin ${release()})`
  if (kind !== 'Linux') return `${kind} ${release()}`
  const text = await readFile('/etc/os-release', 'utf8').catch(() => '')
  const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(text)?.[1]
  return pretty === undefined || pretty === '' ? `Linux ${release()}` : `Linux ${release()} (${pretty})`
}

function runProbe(): Promise<string> {
  const launch = shellLaunch()
  if (launch === null) return Promise.resolve('')
  return new Promise<string>(resolve => {
    execFile(
      launch.bin,
      [...launch.args, '-c', probeScript()],
      { env: launch.env, windowsHide: true, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS },
      // A probe that failed or ran out still printed the lines it got to.
      (_error, stdout) => resolve(stdout),
    )
  })
}

let facts: Promise<HostFacts> | undefined

/**
 * The machine, probed on the first call and answered from memory after it.
 * Every session of a launch gets the same facts, and a tool installed while
 * the app runs shows up at the next launch. A probe that ran out of time is
 * not kept, so the next session to start asks again.
 *
 * The probe waits for the login PATH so it runs with the PATH every command
 * will have, and does not source the profile a second time alongside the read.
 */
export function hostFacts(): Promise<HostFacts> {
  facts ??= (async () => {
    const [os, output] = await Promise.all([osName(), warmShell().then(runProbe)])
    if (!finished(output)) facts = undefined
    return readProbe(output, { os, arch: arch(), platform: process.platform })
  })()
  return facts
}

/** The facts as the system prompt carries them: a few lines, in a fixed order. */
export function hostLines(host: HostFacts): string[] {
  const shell =
    host.shell === null
      ? 'none found, so the bash tool cannot run'
      : `${host.shell} with the login PATH, running one script per command${host.coreutils === null ? '' : `, with ${host.coreutils} coreutils`}`
  const lines = [`OS: ${host.os}, ${host.arch}`, `Shell: ${shell}`]
  if (host.tools.length > 0) lines.push(`Tools: ${host.tools.map(tool => `${tool.command} ${tool.version}`).join(', ')}`)
  if (host.missing.length > 0) lines.push(`Not installed: ${host.missing.join(', ')}`)
  return lines
}
