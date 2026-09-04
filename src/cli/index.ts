#!/usr/bin/env node
// doc: docs/harness/cli.md
import { createRequire } from 'node:module'
import { docCheck } from './doc-check.js'
import { formatSummary, summarize } from './usage.js'
import { readUsage, usageLogPath } from '../core/usage-log.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

const HELP = `nh ${pkg.version}

  nh doc-check [dir]   verify the doc map: every source file linked, every doc backed
  nh usage [--json]    dump recorded token usage and cache hit rate
  nh --version         print the version
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case 'doc-check':
      return runDocCheck(rest[0] ?? process.cwd())
    case 'usage':
      return runUsage(rest.includes('--json'))
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

async function runUsage(json: boolean): Promise<number> {
  const path = usageLogPath()
  const { records, skipped } = await readUsage(path)
  if (json) {
    process.stdout.write(`${JSON.stringify({ path, skipped, records }, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${formatSummary(summarize(records), path, skipped)}\n`)
  return 0
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  process.stderr.write(`nh: ${err instanceof Error ? err.message : String(err)}
`)
  process.exitCode = 1
}
