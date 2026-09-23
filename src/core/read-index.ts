// doc: docs/harness/tools.md
import { stat } from 'node:fs/promises'

/**
 * A file as it was when a tool last looked at it. Modification time and size
 * together, because either one alone changes too rarely: a rewrite inside the
 * same millisecond keeps the time, and a swap of two characters keeps the size.
 */
export interface FileVersion {
  mtimeMs: number
  size: number
}

/** A half-open run of lines, zero-based, as `read` serves them. */
export interface Span {
  start: number
  end: number
}

/** What `read` should do with a request. */
export type ReadPlan =
  | { kind: 'serve' }
  /** Already in the conversation at this version, with the spans that hold it. */
  | { kind: 'known'; spans: readonly Span[] }

/** Whether a tool may rewrite a file, and what to say when it may not. */
export type WritePlan = { ok: true } | { ok: false; reason: string }

interface Seen {
  version: FileVersion
  spans: Span[]
}

/** The version of a file on disk, or null when there is no file there. */
export async function versionOf(abs: string): Promise<FileVersion | null> {
  const info = await stat(abs).catch(() => null)
  if (info === null || !info.isFile()) return null
  return { mtimeMs: info.mtimeMs, size: info.size }
}

function same(a: FileVersion, b: FileVersion): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** Written as `12-40`, one-based and inclusive, which is how a person counts lines. */
function spanText(span: Span): string {
  return `${span.start + 1}-${span.end}`
}

/**
 * What this session has already looked at, keyed by absolute path.
 *
 * It answers two questions. `read` asks whether a span of an unchanged file is
 * already in the conversation, and is told to hand back a pointer instead of
 * the bytes. `edit` and `write` ask whether the file has been read at all and
 * whether it has changed since, and are refused when the answer makes the
 * change a guess.
 *
 * The index is per session and lives in memory. A session rebuilt from a
 * stored transcript starts `resumed`, which drops the read-before-write rule
 * for files it has no record of: the reads are in the transcript the model can
 * see, and this index cannot see them. The freshness rule still applies to
 * every file read after the rebuild.
 */
export class ReadIndex {
  private readonly seen = new Map<string, Seen>()

  constructor(private readonly resumed = false) {}

  /** Whether the bytes for this span are already in the conversation. */
  plan(abs: string, span: Span, version: FileVersion): ReadPlan {
    const prior = this.seen.get(abs)
    if (prior === undefined || !same(prior.version, version)) return { kind: 'serve' }
    const covered = prior.spans.filter(held => held.start <= span.start && held.end >= span.end)
    return covered.length === 0 ? { kind: 'serve' } : { kind: 'known', spans: prior.spans }
  }

  /** Note that this span was served. A version that moved on replaces the record. */
  served(abs: string, span: Span, version: FileVersion): void {
    const prior = this.seen.get(abs)
    if (prior === undefined || !same(prior.version, version)) {
      this.seen.set(abs, { version, spans: [span] })
      return
    }
    prior.spans.push(span)
  }

  /**
   * Note that this session wrote the file. The record moves to the new version
   * with no spans, since none of the new content is in the conversation.
   */
  wrote(abs: string, version: FileVersion | null): void {
    if (version === null) this.seen.delete(abs)
    else this.seen.set(abs, { version, spans: [] })
  }

  /** Forget a file that went away. */
  forget(abs: string): void {
    this.seen.delete(abs)
  }

  /**
   * Forget which spans are in the conversation and keep the versions. After a
   * compaction the lines a file was read at may have gone into a summary or
   * been shortened, so `read` serves the bytes again. The versions stay: the
   * file was still read at that version, and the freshness rule for `edit`
   * and `write` compares against the disk.
   */
  dropSpans(): void {
    for (const record of this.seen.values()) record.spans = []
  }

  /**
   * May a tool rewrite this file? Creating one is always allowed. Replacing
   * content nobody looked at, or content that has changed since, is refused:
   * both would write against a view of the file that is out of date.
   */
  mayWrite(abs: string, version: FileVersion | null, label: string): WritePlan {
    if (version === null) return { ok: true }
    const prior = this.seen.get(abs)
    if (prior === undefined) {
      if (this.resumed) return { ok: true }
      return { ok: false, reason: `${label} has not been read in this conversation. Read it, then make the change.` }
    }
    if (same(prior.version, version)) return { ok: true }
    return { ok: false, reason: `${label} has changed on disk since it was read. Read it again, then make the change.` }
  }

  /** The sentence `read` hands back in place of content it has already served. */
  static knownText(label: string, spans: readonly Span[]): string {
    const held = spans.map(spanText).join(', ')
    return `${label} is unchanged since it was read in this conversation, and ${spans.length === 1 ? 'line ' : 'lines '}${held} ${spans.length === 1 ? 'is' : 'are'} already above. Use what is there. Ask for a range outside it to see more.`
  }
}
