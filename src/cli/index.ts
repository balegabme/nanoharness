#!/usr/bin/env node
// doc: docs/harness/cli.md
import { createRequire } from 'node:module'
import { docCheck } from './doc-check.js'
import { runMcp } from './mcp.js'
import { formatReport } from './usage.js'
import { readUsage, usageLogPath } from '../core/usage-log.js'
import { buildReport } from '../core/usage-report.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

const HELP = `nh ${pkg.version}

  nh doc-check [dir]   verify the doc map: every source file linked, every doc backed
  nh usage [--days N] [--json]
                       what has been spent: per day, folder, session, model and agent
  nh mcp <command>     list, add, remove or check MCP servers (nh mcp --help)
  nh --version         print the version
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case 'doc-check':
      return runDocCheck(rest[0] ?? process.cwd())
    case 'usage':
      return runUsage(rest)
    case 'mcp':
      return runMcp(rest)
    // `nh help mcp` is what gets typed when `nh mcp --help` has not occurred to
    // the reader yet. Both work: a help command that has to be spelled the one
    // right way is not help.
    case 'help':
      return runHelp(rest[0])
    case '--version':
    case '-v':
      process.stdout.write(`${pkg.version}\n`)
      return 0
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return 0
    default:
      process.stderr.write(`nh: unknown command "${command}"\n${HELP}`)
      return 2
  }
}

async function runHelp(topic: string | undefined): Promise<number> {
  if (topic === 'mcp') return runMcp(['--help'])
  process.stdout.write(HELP)
  return 0
}

async function runDocCheck(root: string): Promise<number> {
  const { errors, sourceFiles, docFiles } = await docCheck(root)
  if (errors.length === 0) {
    process.stdout.write(`doc-check: ${sourceFiles} source files, ${docFiles} docs, no problems\n`)
    return 0
  }
  for (const error of errors) process.stderr.write(`doc-check: ${error}\n`)
  process.stderr.write(`doc-check: ${errors.length} problem${errors.length === 1 ? '' : 's'}\n`)
  return 1
}

async function runUsage(args: readonly string[]): Promise<number> {
  const days = daysFrom(args)
  const path = usageLogPath()
  const { records, skipped } = await readUsage(path)
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ path, skipped, records }, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${formatReport(buildReport(records, { days, skipped }), path)}\n`)
  return 0
}

/**
 * `--days N` counts back N whole local days, today included; without it the
 * report covers everything the log holds. Anything that is not a day count is
 * refused rather than read as all time, which would print a report for a
 * window nobody asked for.
 */
function daysFrom(args: readonly string[]): number | null {
  const at = args.indexOf('--days')
  if (at === -1) return null
  const value = Number(args[at + 1])
  if (!Number.isInteger(value) || value < 1) throw new Error(`--days wants a whole number of days, got "${args[at + 1] ?? ''}"`)
  return value
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  process.stderr.write(`nh: ${err instanceof Error ? err.message : String(err)}
`)
  process.exitCode = 1
}
