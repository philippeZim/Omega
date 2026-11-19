import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { basename, extname, fsApi } from "./api";
import * as ed from "./editor";
import { modeForExtension, type Mode } from "./modes";
import { ui } from "./ui.svelte";
import type { SpellLang } from "./spell";
import { setLinkHandler, resolvePath } from "./markdown/livePreview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as latexCtl from "./latex/controller.svelte";
import { setLspHooks } from "./code/lspExtension";
import { allClients, fileUri } from "./code/lsp.svelte";
import { t } from "./i18n/index.svelte";

setLspHooks({
  workspace: () => app.root,
  askInstall: (_kind, name) =>
    ui.confirm(t("app.lspInstallTitle"), t("app.lspInstallMessage", { name }), t("app.install")),
  navigate: async (path, line, ch) => {
    await openFile(path);
    const view = ed.getView();
    if (!view) return;
    const l = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
    const pos = Math.min(l.to, l.from + ch);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  },
});

setLinkHandler(async (href, fromPath) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return openUrl(href).catch((e) => ui.toast(String(e), "error"));
  if (href.startsWith("#")) return;
  let p = resolvePath(href, fromPath);
  if (!p) return ui.toast(t("app.relativeLinkUnsaved"), "error");
  if (!(await fsApi.exists(p)) && (await fsApi.exists(p + ".md"))) p += ".md";
  if (!(await fsApi.exists(p))) return ui.toast(t("app.fileNotFound", { path: p }), "error");
  openFile(p);
});

const spellLangs: Record<string, SpellLang> = JSON.parse(localStorage.getItem("spellLangs") || "{}");

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  dirty: boolean;
}

export const app = $state({
  mode: (localStorage.getItem("mode") as Mode) || "text",
  root: localStorage.getItem("root") as string | null,
  tabs: [] as Tab[],
  activeId: null as string | null,
  sidebar: true,
  /** Sidebar tab: files / git changes / LaTeX outline */
  sidebarView: "files" as "files" | "changes" | "outline",
  cursor: { line: 1, col: 1, selected: 0 },
  treeVersion: 0,
  spellEnabled: localStorage.getItem("spellEnabled") === "true",
  spellDefault: (localStorage.getItem("spellDefault") as SpellLang) || "de",
});

export function spellLangFor(path: string | null): SpellLang {
  return (path && spellLangs[path]) || app.spellDefault;
}

function cfg(): ed.EditorConfig {
  const path = activeTab()?.path ?? null;
  return { mode: app.mode, path, spell: app.spellEnabled ? spellLangFor(path) : null };
}

export function setSpellLang(lang: SpellLang) {
  const path = activeTab()?.path;
  if (path) {
    spellLangs[path] = lang;
    localStorage.setItem("spellLangs", JSON.stringify(spellLangs));
  }
  app.spellDefault = lang;
  localStorage.setItem("spellDefault", lang);
  if (!app.spellEnabled) app.spellEnabled = true;
  localStorage.setItem("spellEnabled", "true");
  ed.configure(cfg());
}

export function toggleSpell() {
  app.spellEnabled = !app.spellEnabled;
  localStorage.setItem("spellEnabled", String(app.spellEnabled));
  ed.configure(cfg());
}

let untitledCounter = 1;
const uid = () => Math.random().toString(36).slice(2, 10);

/** Live-collaboration hooks (set by collab/share.svelte.ts; avoids an import cycle). */
export const collabHooks = {
  openRemote: (_path: string) => {},
  tabOpened: (_id: string, _path: string) => {},
  tabClosed: (_path: string | null) => {},
};
export const isRemotePath = (p: string | null | undefined) => !!p && p.startsWith("collab:");

export const activeTab = () => app.tabs.find((t) => t.id === app.activeId) ?? null;

// ------------------------------------------------------------------ autosave (like PyCharm)
// Files with a path are written automatically: shortly after typing stops, on tab/mode switch,
// when the window loses focus and when a tab or the app is closed. Ctrl+S still works.

const AUTOSAVE_DELAY = 800;
const autosaveTimers = new Map<string, number>();

function scheduleAutosave(id: string) {
  const t = app.tabs.find((t) => t.id === id);
  if (!t?.path || isRemotePath(t.path)) return;
  clearTimeout(autosaveTimers.get(id));
  autosaveTimers.set(id, window.setTimeout(() => autosave(id), AUTOSAVE_DELAY));
}

async function autosave(id: string | null) {
  if (!id) return;
  clearTimeout(autosaveTimers.get(id));
  autosaveTimers.delete(id);
  const t = app.tabs.find((t) => t.id === id);
  if (t?.path && t.dirty) await save(id);
}

/** Writes every modified file that has a path. */
export async function flushAutosave() {
  await Promise.all(app.tabs.filter((t) => t.path && t.dirty && !isRemotePath(t.path)).map((t) => autosave(t.id)));
}

window.addEventListener("blur", () => flushAutosave());

/**
 * Reloads open tabs whose file changed on disk (git pull/checkout, other editors), like PyCharm.
 * Tabs with unsaved edits are left alone.
 */
let syncing = false;
export async function syncFromDisk() {
  if (syncing) return;
  syncing = true;
  try {
    for (const t of app.tabs) {
      if (!t.path || t.dirty || isRemotePath(t.path)) continue;
      let disk: string;
      try {
        disk = await fsApi.readFile(t.path);
      } catch {
        continue; // deleted or unreadable: keep the buffer
      }
      if (t.dirty) continue; // user typed meanwhile
      const doc = ed.getDoc(t.id);
      if (!doc || doc.toString() === disk) continue;
      ed.replaceDocText(t.id, disk);
      ed.markSaved(t.id);
      t.dirty = false;
    }
  } finally {
    syncing = false;
  }
}
window.addEventListener("focus", () => syncFromDisk());
document.addEventListener("visibilitychange", () => document.hidden && flushAutosave());
getCurrentWindow()
  .onCloseRequested(async () => {
    await flushAutosave();
  })
  .catch(() => {});

ed.setCallbacks({
  onDirty(id, dirty) {
    const t = app.tabs.find((t) => t.id === id);
    if (t && isRemotePath(t.path)) dirty = false; // the host saves shared files
    if (t && t.dirty !== dirty) t.dirty = dirty;
    if (dirty) scheduleAutosave(id);
  },
  onCursor(line, col, selected) {
    app.cursor = { line, col, selected };
  },
  onChange(id) {
    if (app.mode === "latex") latexCtl.schedule(id, activeTab()?.path ?? null);
  },
});

/** Kick off LaTeX compilation when entering LaTeX mode or switching tabs within it. */
function latexHook() {
  const t = activeTab();
  if (app.mode === "latex" && t) latexCtl.schedule(t.id, t.path, 0);
}

export function setMode(mode: Mode) {
  autosave(app.activeId);
  const leavingLatex = app.mode === "latex" && mode !== "latex";
  app.mode = mode;
  localStorage.setItem("mode", mode);
  ed.configure(cfg());
  if (leavingLatex) ed.clearDiagnostics();
  latexHook();
}

/** Recently opened files, most recent first (Search Everywhere shows them for an empty query). */
export const recent = $state<string[]>(JSON.parse(localStorage.getItem("recentFiles") || "[]"));
function touchRecent(path: string | null | undefined) {
  if (!path) return;
  const i = recent.indexOf(path);
  if (i >= 0) recent.splice(i, 1);
  recent.unshift(path);
  if (recent.length > 50) recent.length = 50;
  localStorage.setItem("recentFiles", JSON.stringify(recent));
}

export function activate(id: string) {
  if (app.activeId !== id) autosave(app.activeId);
  app.activeId = id;
  ed.activate(id, cfg());
  latexHook();
  touchRecent(activeTab()?.path);
}

export async function openFile(path: string) {
  const existing = app.tabs.find((t) => t.path === path);
  if (existing) return activate(existing.id);
  if (isRemotePath(path)) return collabHooks.openRemote(path);
  let content: string;
  try {
    content = await fsApi.readFile(path);
  } catch (e) {
    ui.toast(t("app.cannotOpenFile", { error: String(e) }), "error");
    return;
  }
  const id = uid();
  ed.createDoc(id, content);
  app.tabs.push({ id, path, name: basename(path), dirty: false });
  const suggested = modeForExtension(extname(path));
  if (suggested && suggested !== app.mode) {
    app.mode = suggested;
    localStorage.setItem("mode", suggested);
  }
  activate(id);
  collabHooks.tabOpened(id, path);
}

/** Opens a tab whose content doesn't come from disk (shared files of a collab session). */
export function openVirtual(path: string, name: string, content: string): string {
  const existing = app.tabs.find((t) => t.path === path);
  if (existing) {
    activate(existing.id);
    return existing.id;
  }
  const id = uid();
  ed.createDoc(id, content);
  app.tabs.push({ id, path, name, dirty: false });
  const suggested = modeForExtension(extname(path));
  if (suggested && suggested !== app.mode) {
    app.mode = suggested;
    localStorage.setItem("mode", suggested);
  }
  activate(id);
  return id;
}

export function newFile() {
  const id = uid();
  ed.createDoc(id, "");
  app.tabs.push({ id, path: null, name: t("app.untitled", { n: untitledCounter++ }), dirty: false });
  activate(id);
}

const closedPaths: string[] = [];

/** Ctrl+⇧+T: reopens the most recently closed file. */
export async function reopenClosedTab() {
  while (closedPaths.length) {
    const p = closedPaths.pop()!;
    if (!app.tabs.some((t) => t.path === p) && (await fsApi.exists(p))) return openFile(p);
  }
}

export async function closeTab(id: string, force = false) {
  const idx = app.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = app.tabs[idx];
  // Files on disk are simply saved; only unsaved new files (no path yet) need a decision.
  if (tab.dirty && tab.path) await autosave(id);
  if (tab.dirty && !force && !isRemotePath(tab.path)) {
    const choice = await ui.choose(
      t("app.unsavedTitle", { name: tab.name }),
      t("app.unsavedMessage"),
      [
        { label: t("common.cancel"), value: "cancel" },
        { label: t("app.discard"), value: "discard", danger: true },
        { label: t("common.save"), value: "save", primary: true },
      ],
    );
    if (choice === "cancel" || choice === null) return;
    if (choice === "save" && !(await save(id))) return;
  }
  app.tabs.splice(idx, 1);
  collabHooks.tabClosed(tab.path);
  if (tab.path && !isRemotePath(tab.path)) {
    closedPaths.push(tab.path);
    if (closedPaths.length > 30) closedPaths.shift();
  }
  ed.disposeDoc(id);
  if (tab.path) for (const c of allClients()) c.close(fileUri(tab.path));
  if (app.activeId === id) {
    const next = app.tabs[idx] ?? app.tabs[idx - 1];
    if (next) activate(next.id);
    else {
      app.activeId = null;
      ed.activate(null, cfg());
    }
  }
}

export async function save(id = app.activeId, forceDialog = false): Promise<boolean> {
  const tab = app.tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (isRemotePath(tab.path)) return true; // saved by the host
  let path = tab.path;
  if (!path || forceDialog) {
    const chosen = await saveDialog({ defaultPath: path ?? (app.root ? `${app.root}/${tab.name}` : undefined) });
    if (!chosen) return false;
    path = chosen;
  }
  const snapshot = ed.getDoc(tab.id);
  // Never write without a live document (e.g. after an editor reset) – that would empty the file.
  if (!snapshot) return false;
  try {
    await fsApi.writeFile(path, snapshot.toString());
  } catch (e) {
    ui.toast(t("app.saveFailed", { error: String(e) }), "error");
    return false;
  }
  ed.markSaved(tab.id, snapshot);
  window.dispatchEvent(new CustomEvent("studio:saved", { detail: path }));
  for (const c of allClients()) c.save(fileUri(path), ed.getText(tab.id));
  if (tab.path !== path) {
    tab.path = path;
    tab.name = basename(path);
    app.treeVersion++;
    if (tab.id === app.activeId) ed.configure(cfg());
  }
  tab.dirty = ed.isDirty(tab.id);
  if (tab.dirty) scheduleAutosave(tab.id);
  return true;
}

export async function openFolder() {
  const dir = await openDialog({ directory: true, defaultPath: app.root ?? undefined });
  if (typeof dir === "string") setRoot(dir);
}

/** Recently opened folders (most recent first). */
export const recentFolders = $state<string[]>(JSON.parse(localStorage.getItem("recentFolders") || "[]"));

export function setRoot(dir: string | null) {
  if (dir) {
    const i = recentFolders.indexOf(dir);
    if (i >= 0) recentFolders.splice(i, 1);
    recentFolders.unshift(dir);
    if (recentFolders.length > 12) recentFolders.length = 12;
    localStorage.setItem("recentFolders", JSON.stringify(recentFolders));
  }
  app.root = dir;
  if (dir) localStorage.setItem("root", dir);
  else localStorage.removeItem("root");
  app.treeVersion++;
}

/** Called after a rename/delete in the explorer so open tabs follow the file. */
export function pathMoved(from: string, to: string | null) {
  for (const t of app.tabs) {
    if (!t.path) continue;
    if (t.path === from || t.path.startsWith(from + "/")) {
      if (to === null) {
        t.path = null;
        t.dirty = true;
      } else {
        t.path = to + t.path.slice(from.length);
        t.name = basename(t.path);
      }
    }
  }
  app.treeVersion++;
}

export function cycleTab(dir: 1 | -1) {
  if (!app.tabs.length) return;
  const i = app.tabs.findIndex((t) => t.id === app.activeId);
  const next = app.tabs[(i + dir + app.tabs.length) % app.tabs.length];
  activate(next.id);
}
