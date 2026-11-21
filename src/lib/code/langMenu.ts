/** The language menu of the active file (picker in the tab bar, command palette). */
import { app, activeTab, isRemotePath } from "../state.svelte";
import * as ed from "../editor";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";
import { LANGUAGES, langFor } from "./languages";
import { closeLspDoc } from "./lsp.svelte";
import { onLanguageOverride, overrideFor, setLanguageOverride } from "./langOverride.svelte";

// Whatever changed the choice (this menu, another window): the open editor follows at once. The
// old server closes the document first, so it never keeps it under the previous language.
onLanguageOverride((path) => {
  closeLspDoc(path);
  for (const tab of app.tabs) if (tab.path === path) ed.refreshLanguage(tab.id, path);
});

export function openLanguageMenu(x?: number, y?: number) {
  const path = activeTab()?.path;
  if (!path || isRemotePath(path)) return ui.toast(t("code.lang.needsFile"));
  const current = overrideFor(path);
  const auto = langFor(path)?.label ?? t("code.lang.plain");
  const mark = (on: boolean) => (on ? "✓" : "");
  ui.openMenu(new MouseEvent("contextmenu", { clientX: x ?? window.innerWidth / 2 - 120, clientY: y ?? 90 }), [
    { label: t("code.lang.automatic", { lang: auto }), shortcut: mark(!current), action: () => void setLanguageOverride(path, null) },
    { label: "", separator: true },
    ...LANGUAGES.map((l) => ({ label: l.label, shortcut: mark(current === l.id), action: () => void setLanguageOverride(path, l.id) })),
  ]);
}
