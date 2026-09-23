import { describe, expect, it } from 'vitest'
import { bashBin } from './shell.js'
import { hostFacts, hostLines, readProbe } from './probe.js'

/**
 * The machine as the system prompt describes it. The first test probes the
 * machine it runs on, which has bash and node or could not be running the
 * suite. The others feed the reader what a Windows machine prints, including
 * the store stub that answers to `python3` without being Python, and what a
 * probe that ran out of time left behind.
 */

describe('the probe on this machine', () => {
  it.runIf(bashBin !== null)('finds the shell and node', async () => {
    const host = await hostFacts()

    expect(host.shell).toMatch(/^bash \d+\.\d+/)
    expect(host.coreutils).not.toBeNull()
    // The node on the shell's PATH, which need not be the one running the suite.
    expect(host.tools.find(tool => tool.command === 'node')?.version).toMatch(/^\d+\.\d+/)
    expect(hostLines(host).slice(0, 2)).toEqual([`OS: ${host.os}, ${host.arch}`, expect.stringMatching(/^Shell: bash \d/)])
  })
})

describe('what a Windows machine prints', () => {
  const lines = [
    'bash\t5.2.37(1)-release',
    'coreutils\tGNU',
    'git\tgit version 2.47.1.windows.1',
    'node\tv22.11.0',
    'python3\tPython was not found; run without arguments to install from the Microsoft Store',
    'python\tPython 3.12.4',
    'pnpm\t11.12.0',
  ]
  const machine = { os: 'Windows 10.0.26200', arch: 'x64', platform: 'win32' } as const

  it('reports each tool under the command that works, and a stub as missing', () => {
    const host = readProbe([...lines, 'done\t', ''].join('\r\n'), machine)

    expect(hostLines(host)).toEqual([
      'OS: Windows 10.0.26200, x64',
      'Shell: bash 5.2.37 (Git Bash) with the login PATH, running one script per command, with GNU coreutils',
      'Tools: git 2.47.1, node 22.11.0, python 3.12.4, pnpm 11.12.0',
      'Not installed: bun, npm, yarn, rg, fd',
    ])
  })

  it('calls nothing missing when the probe ran out of time', () => {
    const host = readProbe([...lines, ''].join('\r\n'), machine)

    expect(host.tools.map(tool => tool.command)).toEqual(['git', 'node', 'python', 'pnpm'])
    expect(host.missing).toEqual([])
  })
})
