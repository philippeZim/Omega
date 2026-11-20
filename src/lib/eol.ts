/**
 * Line endings. CodeMirror normalizes every line break to "\n" on load, so files are read
 * with their ending remembered and written back with it (CRLF files stay CRLF).
 */
export type Eol = "\n" | "\r\n";

/** The ending of the file's first line break ("\n" if it has none). */
export function detectEol(text: string): Eol {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}

/** Text as the editor holds it (only "\n"). */
export const fromDisk = (text: string) => text.replace(/\r\n?/g, "\n");

/** Editor text ("\n" only) with the file's line ending. */
export const toDisk = (text: string, eol: Eol | undefined) => (eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
