import { t, type Key } from "./i18n/index.svelte";

const CODES = ["not_utf8", "not_found", "permission_denied", "exists", "is_dir", "not_dir", "not_empty", "outside_project", "too_large"] as const;

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Turns an error from a file command into the text shown to the user. The backend (fs.rs) sends
 * known file errors as a code "fs:<code>"; these become a translated message naming the file.
 * Anything else is passed through unchanged.
 */
export function fsErrorText(e: unknown, path: string): string {
  const m = /^fs:([a-z0-9_]+)$/.exec(String(e));
  if (!m || !(CODES as readonly string[]).includes(m[1])) return String(e);
  return t(`app.fsErr.${m[1]}` as Key, { name: baseName(path) });
}
