// doc: docs/harness/tools.md
import { randomUUID } from 'node:crypto'
import { isJsonObject } from '../shared/json.js'
import type { Question, QuestionAnswer, QuestionReply } from '../shared/questions.js'

/** What the window is sent: the questions, and the id its answer comes back under. */
export interface QuestionAsk {
  id: string
  sessionId: string
  questions: Question[]
}

interface Pending {
  questions: Question[]
  settle: (reply: QuestionReply) => void
}

/**
 * The questions `ask_user` has put to one window, each waiting on its answer.
 * Built the way the permission broker is: the tool holds a promise, the window
 * answers by id over IPC, and a window that goes away settles every question
 * it was showing, so no turn is left waiting on nobody.
 */
export class QuestionBroker {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly show: (ask: QuestionAsk) => void) {}

  /** Ask, and wait. A stop settles it as unanswered, and the tool reads the signal to say which. */
  ask(sessionId: string, questions: Question[], signal?: AbortSignal): Promise<QuestionReply> {
    const id = randomUUID()
    if (signal?.aborted === true) return Promise.resolve(null)
    return new Promise<QuestionReply>(resolve => {
      const stop = (): void => this.resolve(id, null)
      this.pending.set(id, {
        questions,
        settle: reply => {
          signal?.removeEventListener('abort', stop)
          resolve(reply)
        },
      })
      signal?.addEventListener('abort', stop)
      this.show({ id, sessionId, questions })
    })
  }

  /**
   * The window's answer. It crossed a process boundary, so it is read and not
   * trusted: a label that is not one of the options is dropped, and an answer
   * of the wrong shape counts as no answer. An unknown id is a stale click.
   */
  resolve(id: string, raw: unknown): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    pending.settle(readReply(raw, pending.questions))
  }

  /** Nobody is left to answer, because the window went away. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, null)
  }
}

function readReply(raw: unknown, questions: readonly Question[]): QuestionReply {
  if (!Array.isArray(raw) || raw.length !== questions.length) return null
  const reply: QuestionAnswer[] = []
  for (const [index, question] of questions.entries()) {
    const item: unknown = raw[index]
    if (!isJsonObject(item) || !Array.isArray(item.picked)) return null
    const labels = new Set(question.options.map(option => option.label))
    const picked = item.picked.filter((label): label is string => typeof label === 'string' && labels.has(label))
    const other = typeof item.other === 'string' && item.other.trim() !== '' ? item.other.trim() : undefined
    reply.push({ picked: question.multiSelect ? picked : picked.slice(0, 1), ...(other === undefined ? {} : { other }) })
  }
  return reply
}
