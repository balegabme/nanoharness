// doc: docs/harness/tools.md

/**
 * Whether a file's bytes are text a tool may rewrite, and the text when they
 * are. A lossy decode turns an unreadable byte into U+FFFD and writes the
 * replacement back, so invalid UTF-8 is refused here the same way a NUL byte
 * is.
 *
 * `edit` refuses such a file; `write` overwrites it and says it has no diff.
 */
export function decodeText(buffer: Buffer): { text: string } | { error: string } {
  if (buffer.includes(0)) return { error: 'binary file' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    return { error: 'not valid UTF-8 text' }
  }
}
