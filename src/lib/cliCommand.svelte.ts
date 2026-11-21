// Settings → Installations: the `omega` terminal command.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n/index.svelte";
import { ui } from "./ui.svelte";

export interface CliStatus {
  state: "missing" | "installed" | "stale" | "foreign";
  path: string;
  dir: string;
  onPath: boolean;
  available: boolean;
}

export const cliCommand = $state({ status: null as CliStatus | null, busy: false, error: "" });

/** Backend errors "launcher:<code>" become a translated text; anything else is shown as it is. */
export function launcherError(e: unknown): string {
  const text = String(e);
  if (text === "launcher:foreign") return t("app.cli.err.foreign");
  if (text === "launcher:non_ascii") return t("app.cli.err.nonAscii");
  if (text === "launcher:test_instance") return t("app.cli.err.testInstance");
  return text;
}

export async function refreshCliCommand() {
  try {
    cliCommand.status = await invoke<CliStatus>("cli_status");
    cliCommand.error = "";
  } catch (e) {
    // Stays visible in Settings instead of the section just being gone.
    cliCommand.status = null;
    cliCommand.error = t("app.cli.statusFailed", { error: launcherError(e) });
  }
}

export async function installCliCommand() {
  const s = cliCommand.status;
  if (!s || cliCommand.busy) return;
  // Someone else's `omega` is only replaced after asking.
  if (s.state === "foreign" && !(await ui.confirm(t("app.cli.foreignTitle"), t("app.cli.foreignMessage", { path: s.path }), t("app.cli.replace"), true))) return;
  cliCommand.busy = true;
  try {
    cliCommand.status = await invoke<CliStatus>("cli_install", { replace: s.state === "foreign" });
    ui.toast(t("app.cli.installed"));
  } catch (e) {
    ui.toast(t("app.cli.failed", { error: launcherError(e) }), "error");
  } finally {
    cliCommand.busy = false;
  }
}
