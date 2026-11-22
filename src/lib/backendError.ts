import { t, type Key } from "./i18n/index.svelte";

/** Known codes per backend area (installs.rs, tools.rs, proc.rs); keys "tools.err.<area>.<code>". */
const CODES: Record<string, readonly string[]> = {
  installs: ["not_in_repos", "unknown_manager", "no_version", "not_ours", "system_rust_analyzer", "unknown"],
  tools: ["download_failed", "download_aborted", "unpack_failed", "no_asset", "no_version", "unsupported", "bin_missing", "ocaml_missing", "ocaml_not_managed", "ocaml_failed", "mojo_unsupported", "mojo_failed", "go_missing", "go_failed"],
  proc: ["not_found", "connect_failed", "not_connected", "no_auto_install", "debugpy_failed", "no_version", "unknown_debugger"],
};

/**
 * Turns an error from an install/tool/process command into the text shown to the user. The backend
 * sends known errors as "<area>:<code>" or "<area>:<code>:<detail>" (the detail is a name, URL or
 * the underlying error); these become a translated message. Anything else is passed through, also
 * when the code sits inside a longer text (an Error message, "… failed: tools:…").
 */
export function backendErrorText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.replace(/\b(installs|tools|proc):([a-z_]+)(?::([^\n]*))?/, (all, area: string, code: string, detail?: string) =>
    CODES[area]?.includes(code) ? t(`tools.err.${area}.${code}` as Key, { detail: detail ?? "" }) : all,
  );
}
