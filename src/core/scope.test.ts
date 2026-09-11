import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativePath, suspectPaths, workspaceGate } from './scope.js'
import { READ_TOOL } from '../tools/read.js'

/**
 * The two spellings of one path. A Windows session runs its shell through Git
 * Bash, which prints `/c/project/file`, and the model writes what it just read
 * into the next `read` call. That has to open the file, not report it missing.
 */

const onWindows = process.platform === 'win32'

describe('a path in the spelling the shell printed', () => {
  it('is the same path to a tool', () => {
    expect(nativePath('/c/blockchain/nanoharness/plan.md', 'win32')).toBe('C:/blockchain/nanoharness/plan.md')
    expect(nativePath('/d/data', 'win32')).toBe('D:/data')
    // A single-letter root and nothing else is still a drive.
    expect(nativePath('/c', 'win32')).toMatch(/^C:[\\/]$/)
  })

  it('leaves a real POSIX path alone, on either platform', () => {
    expect(nativePath('/usr/local/bin/node', 'win32')).toBe('/usr/local/bin/node')
    expect(nativePath('/home/me/project', 'win32')).toBe('/home/me/project')
    expect(nativePath('/c/blockchain/plan.md', 'linux')).toBe('/c/blockchain/plan.md')
  })
})

/**
 * The command lines below are real: they are what a subagent ran while
 * installing an MCP server, and every one of them stopped the turn with a
 * permission prompt for a path it never touched. A prompt naming `C:\.exec` is
 * worse than no prompt, because it is the one that teaches a person to click
 * through the next one without reading it.
 */
describe('what a command reaches for', () => {
  it('does not read a script body as a list of paths', () => {
    const command =
      'cd /c/blockchain/tests && node -e "const p=require(\'path\').join(process.env.USERPROFILE,\'.nanoharness\');' +
      'const m=/tavilyApiKey=([^\\"\' ]+)/.exec(s);console.log(m[1].length);"'

    // `/.exec`, `/tavilyApiKey=` and a bare `/` came out of that regex, and the
    // drive root came with them.
    expect(suspectPaths(command)).toEqual(['/c/blockchain/tests'])
  })

  it('still finds a path written out inside one', () => {
    const command = 'node -e "const s=require(\'fs\').readFileSync(\'C:/Users/me/.nanoharness/mcp.json\',\'utf8\')"'

    expect(suspectPaths(command)).toContain('C:/Users/me/.nanoharness/mcp.json')
    expect(suspectPaths(command).some(path => path.includes("'"))).toBe(false)
  })

  it('leaves a URL to the network it belongs to', () => {
    const paths = suspectPaths(`curl -s 'https://mcp.tavily.com/mcp/?tavilyApiKey=abc' -o out.json`)

    expect(paths).toEqual([])
  })

  it('keeps the plain cases it is there for', () => {
    expect(suspectPaths('cat /etc/passwd')).toEqual(['/etc/passwd'])
    expect(suspectPaths('rm -rf ../../other')).toEqual(['../../other'])
    expect(suspectPaths('cp note.txt ~/notes')).toEqual(['~/notes'])
    expect(suspectPaths('grep -rn x "C:/Users/me/Documents/plan.md"')).toEqual(['C:/Users/me/Documents/plan.md'])
    // A path with a space in it is one path, not two things that are neither.
    expect(suspectPaths('ls "C:\\Program Files\\nodejs"')).toEqual(['C:\\Program Files\\nodejs'])
    // Shell plumbing is not a question for a person.
    expect(suspectPaths('ls -la 2>/dev/null')).toEqual([])
  })
})

describe.runIf(onWindows)('read, given what Git Bash printed', () => {
  it('opens the file rather than saying there is none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-scope-'))
    await writeFile(join(root, 'note.txt'), 'the file is here\n', 'utf8')
    const access = workspaceGate(root)

    // `/c/Users/…/nh-scope-x/note.txt`: the drive letter lowercased and the
    // colon gone, exactly as the shell writes it.
    const asShell = `/${root[0]?.toLowerCase() ?? 'c'}${root.slice(2).replace(/\\/g, '/')}/note.txt`
    const result = await READ_TOOL.run({ path: asShell }, { cwd: root, access })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('the file is here')
    await rm(root, { recursive: true, force: true })
  })

  it('still refuses that spelling when it points outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-scope-'))
    const access = workspaceGate(root)
    const result = await READ_TOOL.run({ path: '/c/Windows/System32/drivers/etc/hosts' }, { cwd: root, access })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain('scoped to')
    await rm(root, { recursive: true, force: true })
  })
})
