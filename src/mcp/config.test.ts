import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServers, mcpPaths } from './config.js'

/**
 * The two config files, read off disk the way a session reads them. What is
 * being pinned here is the layering — a server configured once for every
 * workspace, a project that can replace or switch off any of them — and the
 * fact that a workspace with no files gets no servers at all. Nothing is
 * installed by default, so an agent that reports a search tool it was never
 * given is reporting a bug.
 */

let home: string
let project: string

async function config(root: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, '.nanoharness'), { recursive: true })
  await writeFile(join(root, '.nanoharness', 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2), 'utf8')
}

/** A home directory of this test's own, which is what `NANOHARNESS_HOME` is for. */
function env(): NodeJS.ProcessEnv {
  return { NANOHARNESS_HOME: home, TAVILY_API_KEY: 'set-but-irrelevant' }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'nh-home-'))
  project = await mkdtemp(join(tmpdir(), 'nh-project-'))
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('a workspace with nothing configured', () => {
  it('connects to nothing, whatever is in the environment', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'nh-empty-'))
    const loaded = await loadServers(empty, { NANOHARNESS_HOME: empty, TAVILY_API_KEY: 'set' })
    expect(loaded).toEqual({ servers: [], problems: [] })
    await rm(empty, { recursive: true, force: true })
  })
})

describe('the global file and the project file', () => {
  it('reads a server configured once for every workspace', async () => {
    await config(home, { search: { command: 'npx', args: ['-y', 'some-search-mcp'], envPassthrough: ['SEARCH_KEY'] } })
    const loaded = await loadServers(project, env())
    expect(loaded.servers).toEqual([
      { name: 'search', transport: 'stdio', command: 'npx', args: ['-y', 'some-search-mcp'], envPassthrough: ['SEARCH_KEY'], enabled: true },
    ])
  })

  it('lets a project replace a global server outright, and add its own', async () => {
    await config(project, {
      search: { command: 'uvx', args: ['project-search'] },
      tickets: { url: 'https://mcp.example.com/mcp', tokenEnv: 'TICKETS_TOKEN' },
    })
    const loaded = await loadServers(project, env())
    const search = loaded.servers.find(server => server.name === 'search')
    // Replaced, not merged: the global args are gone rather than half-applied.
    expect(search).toEqual({ name: 'search', transport: 'stdio', command: 'uvx', args: ['project-search'], envPassthrough: [], enabled: true })
    expect(loaded.servers.find(server => server.name === 'tickets')).toEqual({
      name: 'tickets',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      tokenEnv: 'TICKETS_TOKEN',
      enabled: true,
    })
  })

  it('lets a project switch a global server off without editing the global file', async () => {
    await config(project, { search: { command: 'npx', args: ['-y', 'some-search-mcp'], enabled: false } })
    const loaded = await loadServers(project, env())
    expect(loaded.servers).toEqual([])
    expect(loaded.problems).toEqual([])
  })
})

describe('a config file that will not parse', () => {
  it('is reported by name, and the other file still loads', async () => {
    await mkdir(join(project, '.nanoharness'), { recursive: true })
    await writeFile(join(project, '.nanoharness', 'mcp.json'), '{ "mcpServers": { "oops": }', 'utf8')
    const loaded = await loadServers(project, env())
    // The global server survives a broken project file.
    expect(loaded.servers.map(server => server.name)).toEqual(['search'])
    expect(loaded.problems).toHaveLength(1)
    expect(loaded.problems[0]).toContain(mcpPaths(project, env()).project)
  })
})
