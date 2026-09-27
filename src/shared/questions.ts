// doc: docs/harness/shared.md
import { isJsonObject } from './json.js'

/**
 * What `ask_user` puts in front of the person, and what comes back. The tool
 * reads the model's arguments with `readQuestions`, the window draws the same
 * shape, and `answerText` words the reply for the model. One module, so the
 * three cannot disagree about the limits.
 */

/** Questions in one call, few enough that the card is answered in a glance. */
export const MAX_QUESTIONS = 4

/** Options per question. Two is the least that is a choice. */
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4

/** The longest header, in characters: it is drawn as a tab above the question. */
export const HEADER_MAX = 16

export interface QuestionOption {
  /** What the person clicks: a few words. */
  label: string
  /** One sentence on what picking it means, drawn under the label. */
  description: string
}

export interface Question {
  /** A short tag for the question, such as "Database" or "Scope". */
  header: string
  /** The whole question, as one or two plain sentences. */
  question: string
  options: QuestionOption[]
  /** True when more than one option may be picked. */
  multiSelect: boolean
}

/** One question's answer: the labels picked, and whatever was typed under "Other". */
export interface QuestionAnswer {
  picked: string[]
  other?: string
}

/** Every question answered, in order, or null when the person closed the card without answering. */
export type QuestionReply = QuestionAnswer[] | null

/** The questions the model asked, checked, or the reason they cannot be shown. */
export function readQuestions(raw: unknown): { ok: true; questions: Question[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'questions must be a non-empty array' }
  if (raw.length > MAX_QUESTIONS) return { ok: false, error: `ask at most ${MAX_QUESTIONS} questions at once` }
  const questions: Question[] = []
  for (const [index, item] of raw.entries()) {
    const where = `question ${index + 1}`
    if (!isJsonObject(item)) return { ok: false, error: `${where} must be an object` }
    const header = typeof item.header === 'string' ? item.header.trim() : ''
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    if (header === '') return { ok: false, error: `${where} needs a header` }
    if (header.length > HEADER_MAX) return { ok: false, error: `${where}: header must be at most ${HEADER_MAX} characters` }
    if (question === '') return { ok: false, error: `${where} needs the question itself` }
    const options = item.options
    if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { ok: false, error: `${where} needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options` }
    }
    const read: QuestionOption[] = []
    for (const option of options) {
      if (!isJsonObject(option) || typeof option.label !== 'string' || option.label.trim() === '') {
        return { ok: false, error: `${where}: every option needs a label` }
      }
      // A bare label makes the user guess what it commits them to, which is
      // the guess the question was asked to avoid.
      const description = typeof option.description === 'string' ? option.description.trim() : ''
      if (description === '') return { ok: false, error: `${where}: option "${option.label.trim()}" needs a description of what choosing it means` }
      read.push({ label: option.label.trim(), description })
    }
    if (new Set(read.map(option => option.label)).size !== read.length) {
      return { ok: false, error: `${where}: two options have the same label` }
    }
    questions.push({ header, question, options: read, multiSelect: item.multiSelect === true })
  }
  return { ok: true, questions }
}

/** The reply as the model reads it: each question, then what the person chose. */
export function answerText(questions: readonly Question[], reply: readonly QuestionAnswer[]): string {
  return questions
    .map((question, index) => {
      const answer = reply[index]
      const chosen = [...(answer?.picked ?? []), ...(answer?.other === undefined ? [] : [`(own words) ${answer.other}`])]
      return `${question.header}: ${question.question}\n-> ${chosen.length === 0 ? '(no answer)' : chosen.join('; ')}`
    })
    .join('\n\n')
}
