// doc: docs/harness/tools.md
import { defineTool } from '../core/session.js'
import { HEADER_MAX, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, answerText, readQuestions } from '../shared/questions.js'
import type { Question } from '../shared/questions.js'
import type { Tool } from '../core/session.js'

/**
 * A question for the person at the keyboard, asked in the middle of a turn.
 * The turn waits for the answer the way it waits on a permission prompt, and
 * the answer comes back as the tool's result.
 *
 * Only the session the user is talking to can ask. A subagent's context has
 * no `ask`, and its call comes back telling it to put the question in its
 * report, which is the one channel it has to the person.
 */

/** What the model is told when the card was closed without an answer. */
const DISMISSED =
  'The user closed the question without answering. Do not pick an answer for them. Go on with the work that does not depend on it; if nothing does, say what you need to know and stop.'

const NO_USER =
  'There is no user to ask here: this agent is a subagent. Put the open question, with the options you see, in your final report, and do not guess the answer.'

export const ASK_USER_TOOL: Tool = defineTool<{ questions: Question[] }>({
  input: {
    name: 'ask_user',
    description: [
      'Ask the user when a decision is theirs to make, or when something you need is still unknown after you have checked what your tools can check. Never guess and carry on: a wrong assumption costs more than a question.',
      'Do not ask what you can find out yourself, and do not ask for permission to run a tool; that is asked for you.',
      'Each question is one or two plain sentences that make sense on their own, with the context needed to answer it. Each option has a label of a few words and a one-sentence description of what choosing it means.',
      'Put the option you recommend first and end its label with "(recommended)". The user can always answer in their own words instead, so do not add an "Other" option.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: `1 to ${MAX_QUESTIONS} questions, asked together.`,
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: `A tag of at most ${HEADER_MAX} characters, such as "Database" or "Scope".` },
              question: { type: 'string', description: 'The whole question, ending in a question mark.' },
              options: {
                type: 'array',
                description: `${MIN_OPTIONS} to ${MAX_OPTIONS} distinct choices.`,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: 'What the user clicks, a few words.' },
                    description: { type: 'string', description: 'What choosing it means, in one sentence.' },
                  },
                  required: ['label', 'description'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean', description: 'True when more than one option may be chosen.' },
            },
            required: ['header', 'question', 'options'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
  // The questions are text for the window, so a secret in them stays a placeholder.
  keepsPlaceholders: true,
  parse: raw => {
    const read = readQuestions(raw.questions)
    return read.ok ? { ok: true, args: { questions: read.questions } } : { ok: false, error: read.error }
  },
  async run({ questions }, { ask, signal }) {
    if (ask === undefined) return { ok: false, summary: NO_USER, content: NO_USER, isError: true }
    const reply = await ask(questions, signal)
    if (signal?.aborted === true) {
      const stopped = 'stopped by the user while the question was open'
      return { ok: false, summary: stopped, content: stopped, isError: true }
    }
    if (reply === null) return { ok: true, summary: DISMISSED, content: DISMISSED }
    const text = `The user answered:\n\n${answerText(questions, reply)}`
    return { ok: true, summary: text, content: text }
  },
})
