/**
 * In-app updates via tauri-plugin-updater. The release workflow publishes signed update bundles plus
 * `latest.json` to GitHub Releases; on startup (release builds only) we ask once whether a newer
 * version exists and offer to install it. "Check for Updates" in the palette runs the same check
 * manually and also reports "up to date".
 */
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "./i18n/index.svelte";
import { ui } from "./ui.svelte";
import { flushAutosave, unsavedTabs } from "./state.svelte";

export const updater = $state({ busy: false, progress: 0, version: "" });

getVersion().then((v) => (updater.version = v)).catch(() => {});

export async function checkForUpdates(manual = false) {
  if (updater.busy) return;
  updater.busy = true;
  let update: Update | null = null;
  try {
    update = await check();
  } catch (e) {
    if (manual) ui.toast(t("app.update.failed", { error: String(e) }), "error");
    updater.busy = false;
    return;
  }
  if (!update) {
    if (manual) ui.toast(t("app.update.upToDate", { version: updater.version }));
    updater.busy = false;
    return;
  }
  const notes = update.body?.trim();
  const choice = await ui.choose(
    t("app.update.available", { version: update.version }),
    (notes ? notes + "\n\n" : "") + t("app.update.message", { current: update.currentVersion }),
    [
      { label: t("app.update.later"), value: "later" },
      { label: t("app.update.install"), value: "install", primary: true },
    ],
  );
  if (choice !== "install") {
    updater.busy = false;
    return;
  }
  await flushAutosave();
  // Relaunching drops unsaved tabs (new files, files deleted on disk): ask like on quit (#32).
  const lost = unsavedTabs();
  if (lost.length && !(await ui.confirm(t("app.quitUnsavedTitle", { n: lost.length }), t("app.quitUnsavedMessage"), t("app.quitAnyway"), true))) {
    updater.busy = false;
    return;
  }
  try {
    let total = 0;
    let done = 0;
    ui.toast(t("app.update.downloading"));
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        if (total) updater.progress = done / total;
      }
    });
    await relaunch();
  } catch (e) {
    ui.toast(t("app.update.failed", { error: String(e) }), "error");
  } finally {
    updater.busy = false;
    updater.progress = 0;
  }
}

// Release builds look for an update shortly after startup; dev builds never do.
if (import.meta.env.PROD) setTimeout(() => checkForUpdates(false), 4000);
