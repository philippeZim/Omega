/** Guest: Save As for a shared tab, which creates a copy in the host's project. */
import { REMOTE, openRemote, remoteFsOp, share } from "./share.svelte";
import { app, type Tab } from "../state.svelte";
import * as ed from "../editor";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

const OPEN_TIMEOUT_MS = 5000;

async function waitForTab(path: string): Promise<Tab | null> {
  const end = Date.now() + OPEN_TIMEOUT_MS;
  for (;;) {
    const tab = app.tabs.find((x) => x.path === path);
    if (tab) return tab;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 40));
  }
}

const errorText = (e: string, name: string) =>
  e === "invalid" ? t("app.invalidEntryName", { name }) : e === "exists" ? t("code.existsAlready", { name }) : e === "unavailable" ? t("ai.collab.fileUnavailable") : e;

/** Asks for a path in the host's project and writes the tab's text there as a new shared file. */
export async function saveCopyToHost(tab: Tab): Promise<boolean> {
  if (!share.hostHasRoot) {
    ui.toast(t("ai.collab.saveCopyNoFolder"), "error");
    return false;
  }
  const current = tab.path!.slice(REMOTE.length);
  const suggested = current.startsWith("tab:") ? tab.name : current;
  const dot = suggested.lastIndexOf(".");
  const rel = await ui.prompt(t("ai.collab.saveCopyTitle"), suggested, t("app.fileNamePlaceholder"), dot > suggested.lastIndexOf("/") + 1 ? dot : undefined);
  if (!rel || rel === current) return false;
  const text = ed.getText(tab.id);
  const err = await remoteFsOp("create", rel);
  if (err) {
    ui.toast(errorText(err, rel), "error");
    return false;
  }
  share.treeGen++;
  await openRemote(rel);
  const copy = await waitForTab(REMOTE + rel);
  if (!copy) {
    ui.toast(t("ai.collab.saveCopyFailed", { name: rel }), "error");
    return false;
  }
  ed.replaceDocText(copy.id, text);
  return true;
}
