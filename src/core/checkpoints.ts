// doc: docs/harness/checkpoints.md
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ChatMessage, CompactionMark } from './types.js'

/**
 * The largest file a checkpoint keeps a copy of. A bigger one is recorded as
 * changed and not restorable, so rewriting a large generated file does not
 * copy it into the data directory on every turn.
 */
const SNAPSHOT_CAP = 16 * 1024 * 1024

/** A file as it was before the first change a checkpoint saw. */
export type Snapshot =
  /** Its bytes, stored once under their SHA-256 however many checkpoints hold them. */
  | { kind: 'kept'; hash: string }
  /** No file was there. Rewinding deletes whatever is there now. */
  | { kind: 'absent' }
  /** Something the store could not copy, and why. Rewinding reports it and leaves the file alone. */
  | { kind: 'lost'; reason: string }

/** Transcript indexes `[start, end)` that all carry `mark`. */
export type MarkRun = [start: number, end: number, mark: CompactionMark]

/** The state of a session at the moment one of its turns began. */
export interface Checkpoint {
  id: string
  /** The turn that began here, numbered as the usage log numbers it. */
  turn: number
  at: number
  /** The first line of the user's message, for a list to show. */
  prompt: string
  /**
   * The conversation marker: how many transcript messages came before the
   * turn's own message. Cutting the transcript to this length puts the
   * conversation back where it stood when the turn began.
   */
  marker: number
  /**
   * The compaction marks on those messages when the turn began. A compaction
   * later on marks earlier messages in place, and cutting the transcript takes
   * away the summary that stood for them, so the marks have to go back too.
   */
  marks: MarkRun[]
  /** How many compactions the context panel listed when the turn began. */
  compactions: number
  /** Each file changed while this was the latest checkpoint, by absolute path, as it was before the first change. */
  files: Record<string, Snapshot>
}

/** A checkpoint as a list shows it: what began there, and every file a rewind to it would put back. */
export interface CheckpointEntry {
  id: string
  turn: number
  at: number
  prompt: string
  /** Where the turn's own message sits in the transcript, which is how the window finds it on screen. */
  marker: number
  /**
   * How many files this checkpoint holds its own copy of: those changed while
   * it was the latest, and any a kept rewind handed to it.
   */
  edited: number
  files: string[]
}

/** What `edit` and `write` call before they change a file, so the file can be put back. */
export interface FileGuard {
  before(abs: string): Promise<void>
}

/** What a rewind puts back: the conversation, the files, or both. */
export type RewindMode = 'conversation' | 'code' | 'both'

export interface Restored {
  restored: string[]
  failed: { path: string; reason: string }[]
  /** Why the index could not be written afterwards. What changed holds in memory all the same, for this run. */
  unsaved?: string
}

/**
 * A rewind the session has not built on yet. Its files are already back on
 * disk, and the conversation is whole until the next turn or compaction keeps
 * the rewind and cuts it. Until then it can be moved to another checkpoint or
 * undone.
 */
interface Held {
  /** The checkpoint the session went back to. */
  id: string
  mode: RewindMode
  /**
   * Each file a rewind in this series changed, as it stood before the first
   * of them. Undoing the rewind puts these back.
   */
  redo: Record<string, Snapshot>
  /** What the latest rewind could not put back, for the note the rewind leaves when it is kept. */
  failed: Restored['failed']
}

/** A held rewind as the window shows it. */
export interface HeldView {
  id: string
  mode: RewindMode
}

/** A rewind the session is keeping, with what it needs to cut its conversation to match. */
export interface Kept {
  point: Checkpoint
  mode: RewindMode
  /** Every file changed from the checkpoint on, which the kept conversation may have seen in another state. */
  changed: string[]
  /** The files the rewind left different from how it found them. */
  restored: string[]
  failed: Restored['failed']
  unsaved?: string
}

const PROMPT_CAP = 120

/** A path relative to the session's folder, or whole when it lies outside it. */
export function shownPath(root: string, abs: string): string {
  const rel = relative(root, abs)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? abs : rel.split(sep).join('/')
}

/** The first line of a message with something on it, short enough for one row. */
export function promptLine(text: string): string {
  const line = text.split('\n').map(one => one.trim()).find(one => one !== '') ?? ''
  return line.length > PROMPT_CAP ? `${line.slice(0, PROMPT_CAP)}…` : line
}

/** The compaction marks on a transcript, as runs. */
export function marksOf(transcript: readonly ChatMessage[]): MarkRun[] {
  const runs: MarkRun[] = []
  transcript.forEach((message, index) => {
    const mark = message.compacted
    if (mark === undefined) return
    const last = runs.at(-1)
    if (last !== undefined && last[1] === index && last[2] === mark) last[1] = index + 1
    else runs.push([index, index + 1, mark])
  })
  return runs
}

/** Put a transcript's compaction marks back to `runs`, clearing every other mark. */
export function applyMarks(transcript: readonly ChatMessage[], runs: readonly MarkRun[]): void {
  for (const message of transcript) delete message.compacted
  for (const [start, end, mark] of runs) {
    for (const message of transcript.slice(start, end)) message.compacted = mark
  }
}

/** For each file changed in `entries`, the snapshot from the earliest one that has it. */
function earliest(entries: readonly Checkpoint[]): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>()
  for (const entry of entries) {
    for (const [abs, snapshot] of Object.entries(entry.files)) if (!out.has(abs)) out.set(abs, snapshot)
  }
  return out
}

const HASH = /^[0-9a-f]{64}$/

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  if (raw.kind === 'kept') return typeof raw.hash === 'string' && HASH.test(raw.hash)
  if (raw.kind === 'lost') return typeof raw.reason === 'string'
  return raw.kind === 'absent'
}

function isMarkRun(value: unknown): value is MarkRun {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1]) &&
    (value[2] === 'compacted' || value[2] === 'pruned')
  )
}

export const REWIND_MODES: readonly string[] = ['conversation', 'code', 'both'] satisfies RewindMode[]

function isHeld(value: unknown): value is Held {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.id === 'string' &&
    typeof raw.mode === 'string' &&
    REWIND_MODES.includes(raw.mode) &&
    typeof raw.redo === 'object' &&
    raw.redo !== null &&
    Object.values(raw.redo).every(isSnapshot) &&
    Array.isArray(raw.failed) &&
    raw.failed.every(miss => typeof miss === 'object' && miss !== null && typeof miss.path === 'string' && typeof miss.reason === 'string')
  )
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== 'object' || value === null) return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.id === 'string' &&
    Number.isInteger(raw.turn) &&
    typeof raw.at === 'number' &&
    typeof raw.prompt === 'string' &&
    Number.isInteger(raw.marker) &&
    Array.isArray(raw.marks) &&
    raw.marks.every(isMarkRun) &&
    Number.isInteger(raw.compactions) &&
    typeof raw.files === 'object' &&
    raw.files !== null &&
    Object.values(raw.files).every(isSnapshot)
  )
}

/**
 * One session's checkpoints, in a folder of their own: `index.json` for the
 * list, and `blobs/` for the file contents, each named by its hash.
 *
 * A checkpoint begins with each turn. The first time `edit` or `write` is about
 * to change a file, the file's current content goes into the latest
 * checkpoint, and later changes to that file in the same checkpoint copy
 * nothing. So a checkpoint holds each file as it stood when its turn began,
 * for every file changed from then until the next turn began.
 *
 * A rewind is held before it is kept. `stage` puts the files back at once and
 * remembers how it found them, and until `commit` it can be moved to another
 * checkpoint or undone with `unstage`. The held rewind is in the index, so it
 * outlives the app.
 *
 * Every operation runs in turn on one queue, because a background subagent can
 * write while its parent is between turns. The index is written after every
 * change, so a turn that dies halfway still leaves its snapshots behind.
 */
export class CheckpointStore implements FileGuard {
  private entries: Checkpoint[] = []
  private held: Held | null = null
  private queue: Promise<unknown>

  constructor(private readonly dir: string) {
    this.queue = this.load()
  }

  private get indexPath(): string {
    return join(this.dir, 'index.json')
  }

  private blobPath(hash: string): string {
    return join(this.dir, 'blobs', hash)
  }

  /** A missing index is an empty one, and so is one this code cannot read. */
  private async load(): Promise<void> {
    const text = await readFile(this.indexPath, 'utf8').catch(() => null)
    if (text === null) return
    try {
      const parsed = JSON.parse(text) as { checkpoints?: unknown; held?: unknown }
      if (Array.isArray(parsed.checkpoints)) this.entries = parsed.checkpoints.filter(isCheckpoint)
      const held = parsed.held
      if (isHeld(held) && this.entries.some(entry => entry.id === held.id)) this.held = held
    } catch {
      this.entries = []
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.indexPath}.tmp`
    await writeFile(tmp, `${JSON.stringify({ checkpoints: this.entries, held: this.held })}\n`, 'utf8')
    await rename(tmp, this.indexPath)
  }

  /**
   * Save after a rewind has changed the files, and sweep the blobs nothing
   * needs any more when `sweep` is set. The change is made in memory first,
   * so a failure here is returned for the caller to report and never thrown.
   */
  private async settle(sweep: boolean): Promise<string | undefined> {
    try {
      await this.save()
      if (sweep) await this.sweep()
      return undefined
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  private indexOf(id: string): number {
    const index = this.entries.findIndex(entry => entry.id === id)
    if (index === -1) throw new Error('that checkpoint is gone')
    return index
  }

  /** Every checkpoint, oldest first, and the rewind held over them if there is one. */
  list(): Promise<{ entries: CheckpointEntry[]; held: HeldView | null }> {
    return this.serial(async () => {
      // From the newest back, so each entry's files are its own and every later one's.
      const entries: CheckpointEntry[] = []
      const after = new Set<string>()
      for (const entry of [...this.entries].reverse()) {
        for (const abs of Object.keys(entry.files)) after.add(abs)
        entries.push({
          id: entry.id,
          turn: entry.turn,
          at: entry.at,
          prompt: entry.prompt,
          marker: entry.marker,
          edited: Object.keys(entry.files).length,
          files: [...after],
        })
      }
      const held = this.held === null ? null : { id: this.held.id, mode: this.held.mode }
      return { entries: entries.reverse(), held }
    })
  }

  /** Start a checkpoint for a turn that is beginning, and return its id. */
  begin(start: Omit<Checkpoint, 'id' | 'files'>): Promise<string> {
    return this.serial(async () => {
      const id = randomUUID()
      this.entries.push({ ...start, marks: start.marks.map(run => [...run] as MarkRun), id, files: {} })
      await this.save()
      return id
    })
  }

  before(abs: string): Promise<void> {
    return this.serial(async () => {
      const latest = this.entries.at(-1)
      if (latest === undefined || abs in latest.files) return
      latest.files[abs] = await this.capture(abs)
      await this.save()
    })
  }

  private async capture(abs: string): Promise<Snapshot> {
    const info = await stat(abs).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
    if (info instanceof Error) {
      return (info as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'lost', reason: info.message }
    }
    if (!info.isFile()) return { kind: 'lost', reason: 'not a regular file' }
    if (info.size > SNAPSHOT_CAP) return { kind: 'lost', reason: `larger than ${SNAPSHOT_CAP / 1024 / 1024} MB` }
    try {
      const bytes = await readFile(abs)
      const hash = createHash('sha256').update(bytes).digest('hex')
      await this.keep(hash, bytes)
      return { kind: 'kept', hash }
    } catch (err) {
      return { kind: 'lost', reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Store a blob once. It goes in under a temporary name so a half-written one never carries a hash. */
  private async keep(hash: string, bytes: Buffer): Promise<void> {
    const path = this.blobPath(hash)
    if (await stat(path).then(() => true, () => false)) return
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${randomUUID()}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  }

  /**
   * Go back to checkpoint `id` and hold the rewind there. For the code and for
   * both, every file changed since `id` began is put back to how it was then.
   * A file changed in several later checkpoints takes its snapshot from the
   * earliest of them, the one taken closest to `id`.
   *
   * Before a file is first put back, its current content is copied, so undoing
   * the rewind can return it. A rewind held already is moved: a file the
   * earlier one changed and this one does not cover goes back to how the
   * earlier one found it. A file already as it should be is left untouched, so
   * going back and forth does not rewrite it or move its modification time.
   *
   * A file that cannot be copied first, because it is too large or cannot be
   * read, is left as it is and reported, since nothing could undo the change.
   */
  stage(id: string, mode: RewindMode): Promise<Restored & { point: Checkpoint }> {
    return this.serial(async () => {
      const index = this.indexOf(id)
      const plan = mode === 'conversation' ? new Map<string, Snapshot>() : earliest(this.entries.slice(index))
      const redo = { ...this.held?.redo }
      for (const abs of plan.keys()) if (!(abs in redo)) redo[abs] = await this.capture(abs)
      const targets = new Map<string, Snapshot>()
      const stuck: Restored['failed'] = []
      for (const [abs, found] of Object.entries(redo)) {
        if (found.kind === 'lost') stuck.push({ path: abs, reason: `left as it is, because it could not be copied first: ${found.reason}` })
        else targets.set(abs, plan.get(abs) ?? found)
      }
      const out = await this.putAll(targets)
      out.failed.push(...stuck)
      this.held = { id, mode, redo, failed: out.failed }
      const unsaved = await this.settle(false)
      return { ...out, ...(unsaved === undefined ? {} : { unsaved }), point: structuredClone(this.entries[index] as Checkpoint) }
    })
  }

  /** Undo the held rewind: every file it changed goes back to how it found it. */
  unstage(): Promise<Restored> {
    return this.serial(async () => {
      if (this.held === null) return { restored: [], failed: [] }
      const out = await this.putAll(new Map(Object.entries(this.held.redo).filter(([, found]) => found.kind !== 'lost')))
      this.held = null
      const unsaved = await this.settle(true)
      return unsaved === undefined ? out : { ...out, unsaved }
    })
  }

  /**
   * Keep the held rewind, for a session about to build on it. Returns null
   * when nothing is held.
   *
   * A code rewind is a change to the files it put back, so the latest
   * checkpoint takes their content from before the rewind, as it would from
   * any other first change, and a later rewind can undo this one.
   *
   * A rewind of the conversation drops `id` and every checkpoint after it.
   * The checkpoint before `id` takes over the snapshots of files it never
   * touched itself. Such a file was unchanged through that checkpoint's turn,
   * so its content when `id` began is also its content when the earlier turn
   * began, and a rewind past `id` can still put it back.
   *
   * A failed write of the index comes back in `unsaved`, and the index
   * catches up with the next save.
   */
  commit(): Promise<Kept | null> {
    return this.serial(async () => {
      const held = this.held
      if (held === null) return null
      const index = this.indexOf(held.id)
      const point = structuredClone(this.entries[index] as Checkpoint)
      const changed = [...earliest(this.entries.slice(index)).keys()]
      const failed = new Set(held.failed.map(miss => miss.path))
      const restored: string[] = []
      for (const [abs, found] of Object.entries(held.redo)) {
        if (!failed.has(abs) && !(await this.matches(abs, found))) restored.push(abs)
      }
      if (held.mode === 'code') {
        const latest = this.entries.at(-1) as Checkpoint
        for (const [abs, found] of Object.entries(held.redo)) if (!(abs in latest.files)) latest.files[abs] = found
      } else {
        const dropped = this.entries.splice(index)
        const previous = this.entries.at(-1)
        if (previous !== undefined) {
          for (const [abs, snapshot] of earliest(dropped)) if (!(abs in previous.files)) previous.files[abs] = snapshot
        }
      }
      this.held = null
      const unsaved = await this.settle(true)
      return { point, mode: held.mode, changed, restored, failed: held.failed, ...(unsaved === undefined ? {} : { unsaved }) }
    })
  }

  /** Put each file to its target, skipping any already there. */
  private async putAll(targets: ReadonlyMap<string, Snapshot>): Promise<Restored> {
    const out: Restored = { restored: [], failed: [] }
    for (const [abs, snapshot] of targets) {
      try {
        if (await this.matches(abs, snapshot)) continue
        await this.put(abs, snapshot)
        out.restored.push(abs)
      } catch (err) {
        out.failed.push({ path: abs, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    return out
  }

  /** Whether the file already holds what the snapshot does. Sizes are compared before any bytes are read. */
  private async matches(abs: string, snapshot: Snapshot): Promise<boolean> {
    if (snapshot.kind === 'lost') return false
    const info = await stat(abs).catch(() => null)
    if (snapshot.kind === 'absent') return info === null
    if (info === null || !info.isFile()) return false
    const blob = await stat(this.blobPath(snapshot.hash)).catch(() => null)
    if (blob === null || blob.size !== info.size) return false
    const bytes = await readFile(abs).catch(() => null)
    return bytes !== null && createHash('sha256').update(bytes).digest('hex') === snapshot.hash
  }

  private async put(abs: string, snapshot: Snapshot): Promise<void> {
    if (snapshot.kind === 'lost') throw new Error(snapshot.reason)
    // Without `recursive`, a directory that has since taken the path is an
    // error, and it is reported instead of deleted.
    if (snapshot.kind === 'absent') return rm(abs, { force: true })
    const bytes = await readFile(this.blobPath(snapshot.hash)).catch(() => null)
    if (bytes === null) throw new Error('its saved copy is gone')
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, bytes)
  }

  /** Delete every blob nothing refers to, and any left half-written. */
  private async sweep(): Promise<void> {
    const used = new Set<string>()
    const snapshots = this.entries.flatMap(entry => Object.values(entry.files))
    if (this.held !== null) snapshots.push(...Object.values(this.held.redo))
    for (const snapshot of snapshots) if (snapshot.kind === 'kept') used.add(snapshot.hash)
    const names = await readdir(join(this.dir, 'blobs')).catch(() => [])
    for (const name of names) if (!used.has(name)) await unlink(join(this.dir, 'blobs', name)).catch(() => undefined)
  }
}
