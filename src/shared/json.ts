// doc: docs/harness/shared.md

/** A parsed JSON value that is an object, as opposed to an array or null. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value when it is a JSON object, or undefined, for reading a field several levels down with `?.`. */
export function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined
}

/** A string field with its whitespace trimmed, or undefined when it is missing, not a string, or blank. */
export function trimmedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
