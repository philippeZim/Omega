import { openDialog, saveDialog, openUrl } from "./native";
import { basename, dirname, extname, fsApi, joinPath, normPath, wellFormed } from "./api";
import * as ed from "./editor";
import { modeForExtension, type Mode } from "./modes";
import { ui } from "./ui.svelte";
import type { SpellLang } from "./spell";
import { setLinkHandler, resolvePath } from "./markdown/livePreview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as latexCtl from "./latex/controller.svelte";
import { setLspHooks } from "./code/lspExtension";
import { allClients, fileUri } from "./code/lsp.svelte";
import { t } from "./i18n/index.svelte";
import { onFilesChanged, watchRoot } from "./fsWatch.svelte";
import { detectEol, fromDisk, toDisk, type Eol } from "./eol";
import { findHeadingLine } from "./headingAnchor";

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
  if (href.startsWith("#")) return jumpToHeading(href.slice(1));
  let p = resolvePath(href, fromPath);
  if (!p) return ui.toast(t("app.relativeLinkUnsaved"), "error");
  if (!(await fsApi.exists(p)) && (await fsApi.exists(p + ".md"))) p += ".md";
  if (!(await fsApi.exists(p))) return ui.toast(t("app.fileNotFound", { path: p }), "error");
  // A folder can't be opened as a tab: say so instead of the raw OS error (#48).
  if (await fsApi.listDir(p).then(() => true, () => false)) return ui.toast(t("app.linkIsFolder", { path: p }), "error");
  await openFile(p);
  const hash = href.indexOf("#");
  if (hash >= 0 && href.length > hash + 1 && activeTab()?.path === p) jumpToHeading(href.slice(hash + 1));
});

/** "[x](#sec-two)": moves the cursor in the active tab to that heading (#42). */
function jumpToHeading(fragment: string) {
  const id = app.activeId;
  const view = ed.getView();
  if (!id || !view) return;
  const line = findHeadingLine(ed.getText(id), fragment);
  if (line < 0) return ui.toast(t("app.headingNotFound", { name: fragment }), "error");
  const pos = view.state.doc.line(line + 1).from;
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

const spellLangs: Record<string, SpellLang> = JSON.parse(localStorage.getItem("spellLangs") || "{}");

export interface Tab {
  id: string;
  path: string | null;
  name: string;
  dirty: boolean;
  /** Project folder that was open when the tab was opened (for the "other project" hint). */
  root?: string | null;
  /** Line ending of the file on disk (the editor always uses "\n"); undefined = "\n". */
  eol?: Eol;
  /** The file was deleted outside Omega: the tab stays dirty, autosave skips it (#32). */
  deleted?: boolean;
}

export const app = $state({
  mode: (localStorage.getItem("mode") as Mode) || "text",
  root: localStorage.getItem("root") as string | null,
  tabs: [] as Tab[],
  activeId: null as string | null,
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
    // Per file only: other files keep their language (#45).
    spellLangs[path] = lang;
    localStorage.setItem("spellLangs", JSON.stringify(spellLangs));
  } else {
    // No file (untitled tab or no tab): sets the default for files without their own choice.
    app.spellDefault = lang;
    localStorage.setItem("spellDefault", lang);
  }
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
  tabClosed: (_path: string | null, _id: string) => {},
  pathMoved: (_from: string, _to: string | null) => {},
};
export const isRemotePath = (p: string | null | undefined) => !!p && p.startsWith("collab:");

/** Resolves "." and ".." segments of an absolute path ("/p/../x" → "/x"). */
export function resolveDots(path: string): string {
  if (!/(^|\/)\.\.?(\/|$)/.test(path)) return path;
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length > 1 || (out.length === 1 && out[0] !== "" && !/^[A-Za-z]:$/.test(out[0]))) out.pop();
    } else out.push(seg);
  }
  const r = out.join("/") || "/";
  return /^[A-Za-z]:$/.test(r) ? r + "/" : r;
}

/** True if `path` lies inside the folder `root`. */
export function inRoot(path: string, root: string | null): boolean {
  if (!root) return false;
  path = resolveDots(path);
  root = resolveDots(root);
  const r = root.endsWith("/") ? root : root + "/";
  return path === root || path.startsWith(r);
}

/**
 * For a tab whose file lies outside the open project: the name of the project (or folder) it
 * belongs to, shown as a hint in the tab bar. Null for tabs of the current project.
 */
export function foreignProject(tab: Tab): string | null {
  if (!tab.path || isRemotePath(tab.path) || !app.root || inRoot(tab.path, app.root)) return null;
  return basename(tab.root && inRoot(tab.path, tab.root) ? tab.root : dirname(tab.path));
}

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
  if (!t?.path || !t.dirty || t.deleted || isRemotePath(t.path)) return;
  // Deleted outside Omega before the watcher noticed: don't bring the file back (#32).
  if (!(await fsApi.exists(t.path))) return markDeleted(t);
  await save(id);
}

/** The tab's file is gone from disk: keep the buffer, but as unsaved, so closing it asks (#32). */
function markDeleted(tab: Tab) {
  if (tab.deleted) return;
  tab.deleted = true;
  tab.dirty = true;
  ui.toast(t("app.deletedOnDisk", { name: tab.name }));
}

/**
 * Tabs whose edits would be lost on quit after flushAutosave(): new files that never got a path and
 * files deleted outside Omega (autosave skips those, #32).
 */
export const unsavedTabs = () => app.tabs.filter((t) => t.dirty && (!t.path || t.deleted));

/** Writes every modified file that has a path. */
export async function flushAutosave() {
  await Promise.all(app.tabs.filter((t) => t.path && t.dirty && !isRemotePath(t.path)).map((t) => autosave(t.id)));
}

window.addEventListener("blur", () => flushAutosave());

/** Tabs Omega is writing right now (watcher events for them are our own). */
const writing = new Set<string>();
/** Tabs with a pending "changed on disk" question. */
const conflicts = new Set<string>();
let conflictQueue: Promise<unknown> = Promise.resolve();

/** `raw`: the file content as read from disk. */
function reloadTab(tab: Tab, raw: string) {
  tab.eol = detectEol(raw);
  ed.replaceDocText(tab.id, fromDisk(raw));
  ed.markSaved(tab.id);
  tab.dirty = false;
}

/**
 * A tab with unsaved edits whose file changed on disk since it was loaded or saved: asks whether
 * to reload it or overwrite the file. One question at a time; resolves to true once tab and file
 * agree again.
 */
function resolveConflict(tab: Tab): Promise<boolean> {
  if (conflicts.has(tab.id)) return Promise.resolve(false);
  conflicts.add(tab.id);
  const run = conflictQueue.then(() => askConflict(tab)).finally(() => conflicts.delete(tab.id));
  conflictQueue = run.catch(() => {});
  return run;
}

async function askConflict(tab: Tab): Promise<boolean> {
  if (!tab.path || ed.savedText(tab.id) === null) return false; // closed meanwhile
  const choice = await ui.choose(t("app.changedOnDiskTitle", { name: tab.name }), t("app.changedOnDiskMessage"), [
    { label: t("app.keepMine"), value: "keep", danger: true },
    { label: t("app.reloadFromDisk"), value: "reload", primary: true },
  ]);
  if (choice === "keep") return save(tab.id, false, true);
  if (choice !== "reload" || !tab.path) return false; // dismissed: stays dirty, asked again on the next save
  try {
    reloadTab(tab, await fsApi.readFile(tab.path));
    return true;
  } catch (e) {
    ui.toast(t("app.cannotOpenFile", { error: String(e) }), "error");
    return false;
  }
}

/**
 * Reloads open tabs whose file changed on disk (watcher events, git pull/checkout, other editors,
 * agents in the terminal), like PyCharm. `paths`: only check these files. Tabs with unsaved edits
 * are never overwritten silently; the user is asked instead.
 */
let syncing = false;
let syncAgain = false;
export async function syncFromDisk(paths?: string[]) {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    let only = paths ? new Set(paths) : null;
    do {
      syncAgain = false;
      for (const t of app.tabs) {
        if (!t.path || isRemotePath(t.path) || (only && !only.has(t.path))) continue;
        if (writing.has(t.id) || conflicts.has(t.id)) continue;
        const saved = ed.savedText(t.id);
        let raw: string;
        try {
          raw = await fsApi.readFile(t.path);
        } catch {
          // Deleted: keep the buffer, but mark the tab. Unreadable: just keep the buffer.
          if (!t.deleted && !(await fsApi.exists(t.path).catch(() => true))) markDeleted(t);
          continue;
        }
        if (t.deleted) {
          // The file is back (git checkout, undo in another program).
          t.deleted = false;
          t.dirty = ed.isDirty(t.id);
        }
        // Skip if Omega saved the tab while we were reading.
        if (saved === null || writing.has(t.id) || ed.savedText(t.id) !== saved) continue;
        const disk = fromDisk(raw);
        // Unchanged since we loaded or wrote it (this also covers events caused by our own saves);
        // only the line ending may have been converted, or lone surrogates replaced by U+FFFD (#21).
        if (disk === wellFormed(saved)) {
          t.eol = detectEol(raw);
          continue;
        }
        if (!t.dirty) reloadTab(t, raw);
        else if (ed.getText(t.id) === disk) {
          t.eol = detectEol(raw);
          ed.markSaved(t.id);
          t.dirty = false;
        } else void resolveConflict(t);
      }
      only = null; // a call came in meanwhile: check every tab
    } while (syncAgain);
  } finally {
    syncing = false;
  }
}
window.addEventListener("focus", () => syncFromDisk());
onFilesChanged((files) => syncFromDisk(files));
document.addEventListener("visibilitychange", () => document.hidden && flushAutosave());
getCurrentWindow()
  .onCloseRequested(async (e) => {
    await flushAutosave();
    const lost = unsavedTabs();
    if (!lost.length) return;
    e.preventDefault();
    const ok = await ui.confirm(t("app.quitUnsavedTitle", { n: lost.length }), t("app.quitUnsavedMessage"), t("app.quitAnyway"), true);
    if (ok) await getCurrentWindow().destroy();
  })
  .catch(() => {});

ed.setCallbacks({
  onDirty(id, dirty) {
    const t = app.tabs.find((t) => t.id === id);
    if (t && isRemotePath(t.path)) dirty = false; // the host saves shared files
    if (t?.deleted) dirty = true; // only an explicit save brings the file back
    if (t && t.dirty !== dirty) t.dirty = dirty;
    if (dirty) scheduleAutosave(id);
  },
  onCursor(line, col, selected) {
    app.cursor = { line, col, selected };
  },
  onChange(id) {
    // Only the active buffer: a background tab reloaded from disk must not be compiled under the
    // active tab's path (#50). The controller recompiles on dependency changes by itself.
    if (app.mode === "latex" && id === app.activeId) latexCtl.schedule(id, activeTab()?.path ?? null);
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
  path = resolveDots(normPath(path));
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
  app.tabs.push({ id, path, name: basename(path), dirty: false, root: inRoot(path, app.root) ? app.root : null, eol: detectEol(content) });
  const suggested = modeForExtension(extname(path));
  if (suggested && suggested !== app.mode) {
    app.mode = suggested;
    localStorage.setItem("mode", suggested);
  }
  activate(id);
  collabHooks.tabOpened(id, path);
}

/**
 * Explorer "New File / New Folder": creates `name` inside `dir` and opens a new file. Uses
 * create_file, which never truncates an existing file (#6). Returns false on failure (toast shown).
 */
export async function createEntry(dir: string, name: string, isDir: boolean): Promise<boolean> {
  // "sub/x.txt" creates the folders in between; anything that could leave `dir` ("..", a
  // leading "/") or name nothing (empty parts, trailing "/", ".") is rejected (#35).
  if (name.split(/[\\/]/).some((seg) => seg === "" || seg === "." || seg === "..")) {
    ui.toast(t("app.invalidEntryName", { name }), "error");
    return false;
  }
  const p = joinPath(dir, name);
  try {
    if (isDir) await fsApi.createDir(p);
    else await fsApi.createFile(p);
  } catch (e) {
    ui.toast(!isDir && (await fsApi.exists(p)) ? t("code.existsAlready", { name }) : String(e), "error");
    return false;
  }
  app.treeVersion++;
  if (!isDir) openFile(p);
  return true;
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
  collabHooks.tabClosed(tab.path, tab.id);
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

/** `overwrite`: write even if the file changed on disk since it was loaded (the user chose so). */
export async function save(id = app.activeId, forceDialog = false, overwrite = false): Promise<boolean> {
  const tab = app.tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (isRemotePath(tab.path)) return true; // saved by the host
  let path = tab.path;
  if (!path || forceDialog) {
    const chosen = await saveDialog({ defaultPath: path ?? (app.root ? `${app.root}/${tab.name}` : undefined) });
    if (!chosen) return false;
    path = normPath(chosen);
  }
  if (path === tab.path && !overwrite) {
    // Never silently overwrite a change made outside Omega (also for files outside the watched folder).
    if (conflicts.has(tab.id)) return false;
    let disk: string | null = null;
    try {
      disk = fromDisk(await fsApi.readFile(path));
    } catch {} // missing: nothing to protect
    const saved = ed.savedText(tab.id);
    // write_file replaced lone surrogates with U+FFFD, so compare against that (#21).
    if (disk !== null && saved !== null && disk !== wellFormed(saved) && disk !== wellFormed(ed.getText(tab.id))) return resolveConflict(tab);
  }
  const snapshot = ed.getDoc(tab.id);
  // Never write without a live document (e.g. after an editor reset) – that would empty the file.
  if (!snapshot) return false;
  writing.add(tab.id);
  try {
    await fsApi.writeFile(path, toDisk(snapshot.toString(), tab.eol));
  } catch (e) {
    ui.toast(t("app.saveFailed", { error: String(e) }), "error");
    return false;
  } finally {
    writing.delete(tab.id);
  }
  ed.markSaved(tab.id, snapshot);
  tab.deleted = false;
  window.dispatchEvent(new CustomEvent("omega:saved", { detail: path }));
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
  if (dir) dir = normPath(dir);
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
  watchRoot(dir);
}
watchRoot(app.root);

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
  collabHooks.pathMoved(from, to);
  app.treeVersion++;
}

export function cycleTab(dir: 1 | -1) {
  if (!app.tabs.length) return;
  const i = app.tabs.findIndex((t) => t.id === app.activeId);
  const next = app.tabs[(i + dir + app.tabs.length) % app.tabs.length];
  activate(next.id);
}
