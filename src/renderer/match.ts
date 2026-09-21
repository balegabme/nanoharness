// doc: docs/harness/ui.md

/**
 * Finding one model in a list of thirty. Nobody agrees on how to write an id:
 * the same model is `gpt-5.6-luna` at one endpoint and `gpt_5_6_luna` at the
 * next, and the person looking for it types `gpt5`. Punctuation is therefore
 * read as a space on both sides, and the run-together spelling is tried as
 * well, so a query finds an id whichever of them put the separators in.
 */

/** Letters and digits, with every run of anything else read as one space. */
function words(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
}

/** Whether `value` is one of the things somebody typing `query` meant to find. */
export function matches(query: string, value: string): boolean {
  const asked = words(query)
  if (asked === '') return true
  const target = words(value)
  return target.includes(asked) || target.replaceAll(' ', '').includes(asked.replaceAll(' ', ''))
}
