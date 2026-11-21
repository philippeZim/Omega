import { t, type Key } from "../i18n/index.svelte";

const CODES = ["invalid_ticket", "timeout", "connect_failed", "not_connected", "already_connected", "busy", "expired", "other_window"] as const;

/**
 * Turns an error from a collab command into the text shown to the user. The backend (collab.rs)
 * sends known errors as "collab:<code>" or "collab:<code>:<detail>"; these become a translated
 * message (with the detail, e.g. the network error). Anything else is passed through unchanged.
 */
export function collabErrorText(e: unknown): string {
  const m = /^collab:([a-z_]+)(?::([\s\S]*))?$/.exec(String(e));
  if (!m || !(CODES as readonly string[]).includes(m[1])) return String(e);
  return t(`ai.collab.err.${m[1]}` as Key, { detail: m[2] ?? "" });
}
