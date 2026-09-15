// doc: docs/harness/tools.md

/**
 * Whether a file's bytes are text a tool may rewrite, and the text when they
 * are. A lossy decode would turn a byte it cannot read into U+FFFD, write that
 * replacement back and call it an edit, so invalid UTF-8 is refused here the
 * same way a NUL byte is. This is the reference behaviour in `deepseek-harness`
 * (`readForEdit`).
 *
 * Both tools that rewrite a file ask this, and the answer has to be the same
 * for both: `edit` refuses the file, and `write` overwrites it but says it has
 * no diff to show.
 */
export function decodeText(buffer: Buffer): { text: string } | { error: string } {
  if (buffer.includes(0)) return { error: 'binary file' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    return { error: 'not valid UTF-8 text' }
  }
}
