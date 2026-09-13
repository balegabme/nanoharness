import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendUsage, readUsage, USAGE_SCHEMA } from './usage-log.js'

/**
 * The usage log is append-only and outlives the code that wrote it, so a line
 * from last month is read by today's build. Only a line carrying the current
 * schema stamp is counted: another version may mean something different by
 * `input`, and it cannot be converted, so it is skipped like an unreadable
 * one.
 */

let dir = ''
let path = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nh-usage-'))
  path = join(dir, 'usage.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`
}

const spend = { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0, reasoning: 0 }

describe('a usage log that outlived a change to its units', () => {
  it('skips a line from before the version field instead of adding it to the totals', async () => {
    await writeFile(
      path,
      // The first line carries no schema stamp and 10,000 in `input`: a
      // different meaning of the field, which this build cannot add in.
      line({ at: 1, sessionId: 's', turn: 1, model: 'm', usage: { ...spend, input: 10000 } }) +
        line({ v: USAGE_SCHEMA, at: 2, sessionId: 's', turn: 2, model: 'm', usage: spend }),
      'utf8',
    )

    const log = await readUsage(path)
    expect(log.records).toHaveLength(1)
    expect(log.records[0]?.turn).toBe(2)
    expect(log.skipped).toBe(1)
  })

  it('counts an old line and an unreadable one in the same skip total', async () => {
    await writeFile(path, line({ at: 1, sessionId: 's', turn: 1, model: 'm', usage: spend }) + 'not json\n', 'utf8')

    const log = await readUsage(path)
    expect(log.skipped).toBe(2)
    expect(log.records).toHaveLength(0)
  })

  it('stamps the version on the way out, so the caller cannot forget it', async () => {
    await appendUsage({ at: 3, sessionId: 's', turn: 1, model: 'm', usage: spend }, path)

    const written: unknown = JSON.parse((await readFile(path, 'utf8')).trim())
    expect(written).toMatchObject({ v: USAGE_SCHEMA, turn: 1 })

    const log = await readUsage(path)
    expect(log.records).toHaveLength(1)
    expect(log.skipped).toBe(0)
  })
})
