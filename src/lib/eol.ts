/**
 * Line endings. CodeMirror normalizes every line break to "\n" on load, so files are read
 * with their ending remembered and written back with it (CRLF files stay CRLF).
 * A UTF-8 byte order mark is handled the same way: the editor never shows it, and it is
 * remembered as part of the ending ("\uFEFF\n" / "\uFEFF\r\n") and written back on save.
 */
export type Eol = "\n" | "\r\n" | "\uFEFF\n" | "\uFEFF\r\n";

const BOM = "\uFEFF";

/** The ending of the file's first line break ("\n" if it has none), prefixed with the BOM if the file has one. */
export function detectEol(text: string): Eol {
  const i = text.indexOf("\n");
  const eol = i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
  return (text.startsWith(BOM) ? BOM + eol : eol) as Eol;
}

/** Text without a leading byte order mark. */
export const stripBom = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text);

/** Text as the editor holds it (only "\n", no BOM). */
export const fromDisk = (text: string) => stripBom(text).replace(/\r\n?/g, "\n");

/** Editor text ("\n" only) with the file's line ending (and BOM). */
export function toDisk(text: string, eol: Eol | undefined): string {
  const bom = eol?.startsWith(BOM) ? BOM : "";
  return bom + (eol?.endsWith("\r\n") ? text.replace(/\n/g, "\r\n") : text);
}
