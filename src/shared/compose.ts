// doc: docs/harness/shared.md

/** Where the user's own words sit in a message, as a start and end offset into its text. */
export type SaidSpan = readonly [number, number]

/**
 * A message as it is sent: the snippets placed above, the user's own words,
 * the snippets placed below, a blank line between each, and empty parts left
 * out. `said` marks the user's words in the result, and is set only when
 * there was a snippet to tell them apart from.
 */
export function compose(own: string, before: readonly string[] = [], after: readonly string[] = []): { text: string; said?: SaidSpan } {
  const said = own.trim()
  const head = before.map(part => part.trim()).filter(part => part !== '')
  const tail = after.map(part => part.trim()).filter(part => part !== '')
  const text = [...head, said, ...tail].filter(part => part !== '').join('\n\n')
  if (head.length === 0 && tail.length === 0) return { text }
  const lead = head.join('\n\n')
  const start = lead === '' ? 0 : said === '' ? lead.length : lead.length + 2
  return { text, said: [start, start + said.length] }
}

/** The words the user typed in a message: the span `said` marks, or the whole text when it marks none. */
export function ownWords(text: string, said: SaidSpan | undefined): string {
  return said === undefined ? text : text.slice(said[0], said[1])
}
