/** The language menu of the active file (picker in the tab bar, command palette). */
import { app, activeTab, isRemotePath } from "../state.svelte";
import * as ed from "../editor";
import { ui, type MenuItem } from "../ui.svelte";
import { t, type Key } from "../i18n/index.svelte";
import { LANGUAGES, langFor } from "./languages";
import { closeLspDoc, statusFor } from "./lsp.svelte";
import { restartLanguageServer } from "./lspExtension";
import { effectiveLang, onLanguageOverride, overrideFor, setLanguageOverride } from "./langOverride.svelte";

// Whatever changed the choice (this menu, another window): the open editor follows at once. The
// old server closes the document first, so it never keeps it under the previous language.
onLanguageOverride((path) => {
  closeLspDoc(path);
  for (const tab of app.tabs) if (tab.path === path) ed.refreshLanguage(tab.id, path);
});

/** Status and restart/install of the file's language server; empty when it has none. */
function serverItems(path: string): MenuItem[] {
  const lang = effectiveLang(path);
  const { status, message } = statusFor(lang, path);
  if (!lang || !status) return [];
  const items: MenuItem[] = [{ label: t(`code.lsp.menu.${status}` as Key), info: { status, message: message?.trim() || undefined } }];
  if (status !== "starting" && status !== "installing") {
    const label = status === "missing" ? `↓ ${t("code.lsp.menu.install")}` : `↻ ${t("code.lsp.menu.restart")}`;
    items.push({ label, action: () => void restartLanguageServer(lang, path) });
  }
  items.push({ label: "", separator: true });
  return items;
}

/** The menu's entries: the server section (if any), then the language choice. */
export function languageMenuItems(path: string): MenuItem[] {
  const current = overrideFor(path);
  const auto = langFor(path)?.label ?? t("code.lang.plain");
  const mark = (on: boolean) => (on ? "✓" : "");
  return [
    ...serverItems(path),
    { label: t("code.lang.automatic", { lang: auto }), shortcut: mark(!current), action: () => void setLanguageOverride(path, null) },
    { label: "", separator: true },
    ...LANGUAGES.map((l) => ({ label: l.label, shortcut: mark(current === l.id), action: () => void setLanguageOverride(path, l.id) })),
  ];
}

export function openLanguageMenu(x?: number, y?: number) {
  const path = activeTab()?.path;
  if (!path || isRemotePath(path)) return ui.toast(t("code.lang.needsFile"));
  ui.openMenu(new MouseEvent("contextmenu", { clientX: x ?? window.innerWidth / 2 - 120, clientY: y ?? 90 }), languageMenuItems(path));
}
