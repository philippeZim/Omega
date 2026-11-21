// "New Window". Separate from windowSession so the command list doesn't import the session code.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n/index.svelte";
import { ui } from "./ui.svelte";

export async function newWindow() {
  try {
    await invoke("window_new");
  } catch (e) {
    ui.toast(t("app.newWindowFailed", { error: String(e) }), "error");
  }
}
