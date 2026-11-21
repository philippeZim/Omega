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

export const cliCommand = $state({ status: null as CliStatus | null, busy: false });

export async function refreshCliCommand() {
  cliCommand.status = await invoke<CliStatus>("cli_status").catch(() => null);
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
    ui.toast(t("app.cli.failed", { error: String(e) }), "error");
  } finally {
    cliCommand.busy = false;
  }
}
