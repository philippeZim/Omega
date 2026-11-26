import { openDialog, saveDialog, openUrl } from "./native";
import { onGlobalChange } from "./windowStorage";
import { basename, dirname, extname, fsApi, joinPath, normPath, wellFormed } from "./api";
import * as ed from "./editor";
import { modeForPath, type Mode } from "./modes";
import { moveLanguageOverrides, overrideFor } from "./code/langOverride.svelte";
import { ui } from "./ui.svelte";
import type { SpellLang } from "./spell";
import { setLinkHandler, resolvePath } from "./markdown/livePreview";
import { moveImagePermissions } from "./markdown/remoteImages.svelte";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as latexCtl from "./latex/controller.svelte";
import { setLspHooks } from "./code/lspExtension";
import { closeLspDoc, saveLspDoc } from "./code/lsp.svelte";
import { t } from "./i18n/index.svelte";
import { onFilesChanged, watchRoot } from "./fsWatch.svelte";
import { detectEol, fromDisk, toDisk, type Eol } from "./eol";
import { findHeadingLine } from "./headingAnchor";
import { blockedAsGuest, guestGuard } from "./collab/guard";
import { toolsBeforeSave } from "./collab/guestChanges";
import { byteLength, formatSize } from "./largeFile";
import { isSvgPath, viewerKind, type ViewerKind } from "./viewer";
import { forgetViewer } from "./viewerMemory";
import { emptyGroup, groupOrder, initialGroups, neighbour, nextActive, removeFrom, splitAt, type Group, type Groups, type Side } from "./editorGroups";

setLspHooks({
  workspace: () => app.root,
  askInstall: (_kind, name) =>
    ui.confirm(t("app.lspInstallTitle"), t("app.lspInstallMessage", { name }), t("app.install")),
  navigate: async (path, line, ch) => {
    await openFile(path, false, true);
    // The open can be cancelled (large file) or fail: the cursor must not jump in another file.
    const wanted = resolveDots(normPath(path));
    const tab = activeTab();
    if (tab?.path !== wanted && tab?.headOf !== wanted) return;
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
  if (isRemotePath(fromPath)) return collabHooks.openLink(href, fromPath!, jumpToHeading);
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
  /** Read-only view of the start of this too large file. The tab has no `path`, so nothing can write to it (#174). */
  headOf?: string;
  /** For `headOf`: what the banner says. */
  headNote?: string;
  /** The whole file, 8 to 64 MiB, opened after a warning: editable, saved by hand, no language features (#174). */
  large?: boolean;
  /** Read-only image or PDF view of this file. The tab has no `path`, so no text feature applies to it (#159). */
  viewOf?: string;
  viewer?: ViewerKind;
  /** Bumped when the viewed file changed, so the view loads it again. */
  viewRev?: number;
  /** The mode this tab is shown in; switching to the tab brings it back (#302). */
  mode?: Mode;
}

export const app = $state({
  mode: (localStorage.getItem("mode") as Mode) || "text",
  root: localStorage.getItem("root") as string | null,
  /** Open documents. Each is shown in one or more editor groups (#219). */
  tabs: [] as Tab[],
  /** The focused group's active tab. */
  activeId: null as string | null,
  groups: initialGroups() as Groups,
  cursor: { line: 1, col: 1, selected: 0 },
  treeVersion: 0,
  spellEnabled: localStorage.getItem("spellEnabled") === "true",
  spellDefault: (localStorage.getItem("spellDefault") as SpellLang) || "de",
});

export function spellLangFor(path: string | null): SpellLang {
  return (path && spellLangs[path]) || app.spellDefault;
}

function cfgFor(tab: Tab | null, mode: Mode): ed.EditorConfig {
  const path = tab?.path ?? null;
  if (tab?.headOf) return { mode, path, spell: null, headNote: tab.headNote };
  // The (empty, hidden) buffer behind a viewer tab must not accept text from any command.
  if (tab?.viewOf) return { mode, path, spell: null, headNote: tab.name };
  if (tab?.large) return { mode, path, spell: null, largeNote: t("app.large.reduced") };
  return { mode, path, spell: app.spellEnabled ? spellLangFor(path) : null };
}

const cfg = () => cfgFor(activeTab(), app.mode);

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
  refreshGroups();
}

// Changed in another window.
onGlobalChange(["spellEnabled", "spellDefault", "spellLangs"], () => {
  app.spellEnabled = localStorage.getItem("spellEnabled") === "true";
  app.spellDefault = (localStorage.getItem("spellDefault") as SpellLang) || "de";
  const langs: Record<string, SpellLang> = JSON.parse(localStorage.getItem("spellLangs") || "{}");
  for (const k of Object.keys(spellLangs)) delete spellLangs[k];
  Object.assign(spellLangs, langs);
  refreshGroups();
});

export function toggleSpell() {
  app.spellEnabled = !app.spellEnabled;
  localStorage.setItem("spellEnabled", String(app.spellEnabled));
  refreshGroups();
}

let untitledCounter = 1;
const uid = () => Math.random().toString(36).slice(2, 10);

/** Live-collaboration hooks (set by collab/share.svelte.ts; avoids an import cycle). */
export const collabHooks = {
  openRemote: (_path: string) => {},
  /** The edit being applied right now came from someone who may not cause a compile. */
  editBlocksCompile: () => false,
  openLink: async (_href: string, _from: string, _jumpToHeading: (fragment: string) => void): Promise<void> => {},
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
  if (!t?.path || t.large || isRemotePath(t.path)) return;
  clearTimeout(autosaveTimers.get(id));
  autosaveTimers.set(id, window.setTimeout(() => autosave(id), AUTOSAVE_DELAY));
}

async function autosave(id: string | null) {
  if (!id) return;
  clearTimeout(autosaveTimers.get(id));
  autosaveTimers.delete(id);
  const t = app.tabs.find((t) => t.id === id);
  if (!t?.path || !t.dirty || t.deleted || t.large || isRemotePath(t.path)) return;
  // Deleted outside Omega before the watcher noticed: don't bring the file back (#32).
  if (!(await fsApi.exists(t.path))) return markDeleted(t);
  await save(id);
}

/** The tab's file is gone from disk: keep the buffer, but as unsaved, so closing it asks (#32). */
function markDeleted(tab: Tab) {
  if (tab.deleted) return;
  tab.deleted = true;
  if (tab.viewOf) return ui.toast(t("app.viewer.deleted", { name: tab.name })); // no edits to lose, nothing to write back
  tab.dirty = true;
  ui.toast(t("app.deletedOnDisk", { name: tab.name }));
}

/**
 * Tabs whose edits would be lost on quit after flushAutosave(): new files that never got a path,
 * files deleted outside Omega (#32) and large files (#174): autosave skips all of those.
 */
export const unsavedTabs = () => app.tabs.filter((t) => t.dirty && (!t.path || t.deleted || t.large));

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

/** Large tabs: size and time of the file they match. They aren't re-read on every change (#174). */
const diskStamps = new Map<string, string>();
/** Tabs already told that their file moved on, so a growing log doesn't repeat the message. */
const staleNoticed = new Set<string>();
const stampOf = (i: { size: number; modified: number }) => `${i.size}:${i.modified}`;

async function rememberStamp(id: string, path: string) {
  const info = await fsApi.fileInfo(path).catch(() => null);
  if (info) diskStamps.set(id, stampOf(info));
  staleNoticed.delete(id);
}

function noticeStale(tab: Tab) {
  if (staleNoticed.has(tab.id)) return;
  staleNoticed.add(tab.id);
  ui.toast(t("app.large.changedOnDisk", { name: tab.name }));
}

/** A large tab's file: only its size and time are compared; saving does the full check. */
async function syncLargeTab(tab: Tab & { path: string }) {
  const info = await fsApi.fileInfo(tab.path).catch(() => null);
  if (!info) {
    if (!tab.deleted && !(await fsApi.exists(tab.path).catch(() => true))) markDeleted(tab);
    return;
  }
  if (tab.deleted) {
    tab.deleted = false;
    tab.dirty = ed.isDirty(tab.id);
  }
  if (!writing.has(tab.id) && stampOf(info) !== diskStamps.get(tab.id)) noticeStale(tab);
}

/** A viewer tab's file: reloads the view once a change has settled, follows deletion and return. */
async function syncViewerTab(tab: Tab & { viewOf: string }) {
  if (settling.has(tab.id)) return; // the running wait sees this change too
  const info = await fsApi.fileInfo(tab.viewOf).catch(() => null);
  if (!info) {
    if (!tab.deleted && !(await fsApi.exists(tab.viewOf).catch(() => true))) markDeleted(tab);
    return;
  }
  if (!tab.deleted && stampOf(info) === diskStamps.get(tab.id)) return;
  settleViewerTab(tab, false);
}

/** How long a file must keep its size and time before a viewer loads it, growing while it keeps changing. */
const SETTLE_FIRST_MS = 300;
const SETTLE_MAX_STEP_MS = 1200;
/** Then the old view stays, and the next watcher or focus event tries again. */
const SETTLE_CAP_MS = 15_000;
/** Viewer tabs waiting for their file to stop changing, at most one wait each. */
const settling = new Map<string, { path: string; force: boolean }>();

const viewerStamp = (path: string) => fsApi.fileInfo(path).then(stampOf, () => null);

/** `force`: the open document is known to be another version, so reload even if the stamp looks known. */
function settleViewerTab(tab: Tab & { viewOf: string }, force: boolean) {
  const running = settling.get(tab.id);
  if (running) {
    running.force ||= force;
    return;
  }
  const wait = { path: tab.viewOf, force };
  settling.set(tab.id, wait);
  void awaitSettled(tab.id, wait).finally(() => {
    if (settling.get(tab.id) === wait) settling.delete(tab.id);
  });
}

async function awaitSettled(id: string, wait: { path: string; force: boolean }) {
  const current = () => (settling.get(id) === wait ? app.tabs.find((x) => x.id === id && x.viewOf === wait.path) : undefined);
  const end = Date.now() + SETTLE_CAP_MS;
  let step = SETTLE_FIRST_MS;
  let last = await viewerStamp(wait.path);
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, step));
    if (!current()) return;
    const stamp = await viewerStamp(wait.path);
    const tab = current();
    if (!tab) return;
    if (stamp !== last) {
      last = stamp;
      step = Math.min(step * 1.5, SETTLE_MAX_STEP_MS);
      continue;
    }
    if (stamp === null) {
      if (!tab.deleted && !(await fsApi.exists(wait.path).catch(() => true))) markDeleted(tab);
    } else if (wait.force || tab.deleted || stamp !== diskStamps.get(id)) {
      tab.deleted = false;
      diskStamps.set(id, stamp);
      tab.viewRev = (tab.viewRev ?? 0) + 1;
    }
    return;
  }
}

/** The open document no longer matches its file: loads the file again once it has stopped changing. */
export function reloadViewerTab(id: string) {
  const tab = app.tabs.find((x) => x.id === id);
  if (tab?.viewOf && !isRemotePath(tab.viewOf)) settleViewerTab(tab as Tab & { viewOf: string }, true);
}

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
    if (tab.large) await rememberStamp(tab.id, tab.path);
    reloadTab(tab, await (tab.large ? fsApi.readFileLarge(tab.path) : fsApi.readFile(tab.path)));
    staleNoticed.delete(tab.id);
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
        if (t.viewOf) {
          if (!isRemotePath(t.viewOf) && (!only || only.has(t.viewOf))) await syncViewerTab(t as Tab & { viewOf: string });
          continue;
        }
        if (!t.path || isRemotePath(t.path) || (only && !only.has(t.path))) continue;
        if (writing.has(t.id) || conflicts.has(t.id)) continue;
        if (t.large) {
          await syncLargeTab(t as Tab & { path: string });
          continue;
        }
        const saved = ed.savedText(t.id);
        let raw: string;
        try {
          raw = await fsApi.readFile(t.path);
        } catch {
          // Deleted: keep the buffer, but mark the tab. Unreadable: just keep the buffer.
          if (!t.deleted && !(await fsApi.exists(t.path).catch(() => true))) markDeleted(t);
          else if ((await fsApi.fileInfo(t.path).catch(() => null))?.too_large) noticeStale(t);
          continue;
        }
        staleNoticed.delete(t.id);
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
    // Only a buffer shown as LaTeX in some group: a background tab reloaded from disk must not be
    // compiled under another tab's path (#50). The controller recompiles on dependency changes by itself.
    const tab = app.tabs.find((x) => x.id === id);
    if (!tab || tab.large || !shownAs(id, "latex")) return;
    if (collabHooks.editBlocksCompile()) latexCtl.schedule(id, tab.path, undefined, false);
    else latexCtl.schedule(id, tab.path);
  },
});

/** The group last focused in LaTeX mode: the PDF and outline belong to it (#219). */
let latexGroup: string | null = null;

/** Kick off LaTeX compilation when entering LaTeX mode or switching tabs within it. */
function latexHook() {
  const t = activeTab();
  if (app.mode === "latex") latexGroup = app.groups.focused;
  if (app.mode === "latex" && t && !t.headOf && !t.large && !t.viewOf) latexCtl.schedule(t.id, t.path, 0);
}

/** PDF and outline act on the LaTeX group: it gets the focus if another group has it. */
export function focusLatexGroup() {
  if (app.mode === "latex" || !latexGroup || !app.groups.groups[latexGroup]) return;
  if (groupMode(latexGroup) === "latex") focusGroup(latexGroup);
}

/** The mode a file belongs in by its name or language override; null = no clear one. */
const suggestedMode = (path: string): Mode | null => (overrideFor(path) ? "code" : modeForPath(path));

/**
 * Switches the window's mode without reconfiguring the editor (the caller does that). `samePane`:
 * the focused editor itself leaves LaTeX, so its compile errors go; focusing another group keeps them.
 */
function enterMode(mode: Mode, samePane = true) {
  if (mode === app.mode) return;
  const leavingLatex = app.mode === "latex";
  app.mode = mode;
  localStorage.setItem("mode", mode);
  if (leavingLatex && samePane) ed.clearDiagnostics();
}

/**
 * The user (or a feature) picks a mode: it applies to the active tab in the focused group and stays
 * with it there. Other groups showing the same file keep their own mode (#219).
 */
export function setMode(mode: Mode) {
  autosave(app.activeId);
  const tab = activeTab();
  if (tab && !tab.viewOf) {
    tab.mode = mode;
    focusedGroup().modes[tab.id] = mode;
  }
  enterMode(mode);
  ed.configure(cfg());
  latexHook();
}

// ------------------------------------------------------------------ editor groups (#219)

export const focusedGroup = (): Group => app.groups.groups[app.groups.focused];
const tabById = (id: string | null) => (id ? (app.tabs.find((t) => t.id === id) ?? null) : null);
export const groupCount = () => Object.keys(app.groups.groups).length;

/** The mode a text tab shows in group `g`: chosen there, else the tab's last one, else by its name. */
function modeIn(g: Group, tab: Tab): Mode | null {
  if (tab.viewOf) return null;
  return g.modes[tab.id] ?? tab.mode ?? (tab.path ? suggestedMode(tab.path) : null);
}

/** Mode of the active tab of group `gid`; null for an empty group or a viewer. */
export function groupMode(gid: string): Mode | null {
  const g = app.groups.groups[gid];
  const tab = g && tabById(g.active);
  return tab ? modeIn(g, tab) : null;
}

/** Modes of what the groups show right now (the dock zones open for any of them, #219). */
export function shownModes(): Mode[] {
  const out = new Set<Mode>();
  for (const id of Object.keys(app.groups.groups)) {
    const m = groupMode(id);
    if (m) out.add(m);
  }
  return [...out];
}

/** Document `id` is the active tab of some group that shows it in `mode`. */
export function shownAs(id: string, mode: Mode): boolean {
  // The focused group shows in the window's mode.
  return Object.values(app.groups.groups).some((g) => g.active === id && (g.id === app.groups.focused ? app.mode : g.modes[id]) === mode);
}

/** Puts group `gid`'s active tab into its editor pane (or hides the editor). */
function showGroup(gid: string, focus = false) {
  const g = app.groups.groups[gid];
  if (!g) return;
  const tab = tabById(g.active);
  if (!tab) return ed.show(gid, null, cfgFor(null, app.mode), false);
  const mode = modeIn(g, tab) ?? app.mode;
  if (!tab.viewOf) g.modes[tab.id] = mode;
  ed.show(gid, tab.id, cfgFor(tab, mode), focus);
}

/** Every group's editor again (spellcheck setting changed …). */
function refreshGroups() {
  for (const gid of Object.keys(app.groups.groups)) showGroup(gid);
}

/** A group's editor pane was created (it shows nothing until then). */
export function paneReady(gid: string) {
  showGroup(gid, gid === app.groups.focused);
}

function setFocused(gid: string) {
  app.groups.focused = gid;
  ed.setFocusedPane(gid);
}

/** Click or focus into a group: its active tab becomes the window's, the mode switcher follows it. */
export function focusGroup(gid: string) {
  const g = app.groups.groups[gid];
  if (!g || app.groups.focused === gid) return;
  autosave(app.activeId);
  setFocused(gid);
  app.activeId = g.active;
  const tab = activeTab();
  const mode = tab && modeIn(g, tab);
  if (mode) enterMode(mode, false);
  latexHook();
}

/** Makes `id` the active tab of group `gid` and focuses the group. */
export function activateIn(gid: string, id: string) {
  const g = app.groups.groups[gid];
  const tab = tabById(id);
  if (!g || !tab) return;
  if (app.activeId !== id) autosave(app.activeId);
  const samePane = app.groups.focused === gid;
  if (!g.tabs.includes(id)) g.tabs.splice(g.active ? g.tabs.indexOf(g.active) + 1 : g.tabs.length, 0, id);
  setFocused(gid);
  g.active = id;
  app.activeId = id;
  // A text tab comes back in its own mode (#302). Viewers and untitled tabs without one keep the current mode.
  if (!tab.viewOf) {
    const mode = modeIn(g, tab);
    if (mode) {
      g.modes[id] = tab.mode = mode;
      enterMode(mode, samePane);
    }
  }
  ed.activate(id, cfg());
  latexHook();
  touchRecent(tab.path ?? (isRemotePath(tab.viewOf) ? null : tab.viewOf));
}

/** Removes group `gid` (not the last one); its tabs that are nowhere else close. */
function removeGroup(gid: string) {
  if (groupCount() < 2 || !app.groups.groups[gid]) return;
  const next = neighbour(app.groups.root, gid)!;
  app.groups.root = removeFrom(app.groups.root, gid);
  delete app.groups.groups[gid];
  ed.destroyPane(gid);
  if (app.groups.focused === gid) {
    const g = app.groups.groups[next];
    setFocused(next);
    app.activeId = null;
    if (g.active) activateIn(next, g.active);
    else ed.activate(null, cfg());
  }
}

/** Takes `id` out of group `gid`: the next tab there takes over, an emptied group goes (unless it's the last). */
function dropFromGroup(gid: string, id: string) {
  const g = app.groups.groups[gid];
  if (!g?.tabs.includes(id)) return;
  const next = g.active === id ? nextActive(g.tabs, id) : g.active;
  g.tabs.splice(g.tabs.indexOf(id), 1);
  delete g.modes[id];
  if (!g.tabs.length && groupCount() > 1) return removeGroup(gid);
  g.active = next;
  if (gid !== app.groups.focused) return showGroup(gid);
  if (next) activateIn(gid, next);
  else {
    app.activeId = null;
    ed.activate(null, cfg());
  }
}

/** Closes a tab in one group: the file stays open if another group shows it, else it closes. */
export async function closeInGroup(gid: string, id: string) {
  if (!Object.values(app.groups.groups).some((g) => g.id !== gid && g.tabs.includes(id))) return closeTab(id);
  dropFromGroup(gid, id);
}

/** Splits group `gid`: a new group on `side` shows its active tab too (the same file, kept in sync). */
export function splitGroup(side: Side, gid = app.groups.focused, tabId?: string | null) {
  const src = app.groups.groups[gid];
  if (!src) return;
  const id = uid();
  const g = emptyGroup(id);
  // `null`: the new group starts empty.
  const t = tabId === undefined ? src.active : tabId;
  if (t) {
    g.tabs = [t];
    g.active = t;
    if (src.modes[t]) g.modes[t] = src.modes[t];
  }
  app.groups.groups[id] = g;
  app.groups.root = splitAt(app.groups.root, gid, side, id);
  autosave(app.activeId);
  setFocused(id);
  app.activeId = t ?? null;
  const tab = tabById(t ?? null);
  const mode = tab && modeIn(g, tab);
  if (mode) enterMode(mode, false);
  // The new group's editor pane shows the tab once it's mounted (paneReady).
  return id;
}

/** Drag and drop: moves tab `id` from group `from` into group `to` (at `index`), or next to it on `side`. */
export function moveTab(id: string, from: string, to: string, opts: { index?: number; side?: Side } = {}) {
  const src = app.groups.groups[from];
  if (!src?.tabs.includes(id) || !app.groups.groups[to]) return;
  if (opts.side) {
    if (from === to && src.tabs.length === 1) return; // nothing would change
    const mode = src.modes[id];
    const gid = splitGroup(opts.side, to, id)!;
    if (mode) app.groups.groups[gid].modes[id] = mode;
    dropFromGroup(from, id);
    return;
  }
  const dst = app.groups.groups[to];
  if (from === to && opts.index === undefined) return activateIn(to, id);
  if (from === to) {
    const i = dst.tabs.indexOf(id);
    let j = Math.max(0, Math.min(opts.index ?? dst.tabs.length, dst.tabs.length));
    if (j > i) j--;
    dst.tabs.splice(i, 1);
    dst.tabs.splice(j, 0, id);
    return activateIn(to, id);
  }
  if (!dst.tabs.includes(id)) {
    dst.tabs.splice(Math.max(0, Math.min(opts.index ?? dst.tabs.length, dst.tabs.length)), 0, id);
    if (src.modes[id] && !dst.modes[id]) dst.modes[id] = src.modes[id];
  }
  activateIn(to, id);
  dropFromGroup(from, id);
}

/** All tabs back into the focused group, in reading order; the other groups go. */
export function joinGroups() {
  const order = groupOrder(app.groups.root);
  if (order.length < 2) return;
  const keep = focusedGroup();
  for (const gid of order) {
    if (gid === keep.id) continue;
    const g = app.groups.groups[gid];
    for (const id of g.tabs) {
      if (keep.tabs.includes(id)) continue;
      keep.tabs.push(id);
      if (g.modes[id]) keep.modes[id] = g.modes[id];
    }
  }
  for (const gid of order) if (gid !== keep.id) removeGroup(gid);
}

/** Moves the focus to the next (`1`) or previous group in reading order. */
export function cycleGroup(dir: 1 | -1) {
  const order = groupOrder(app.groups.root);
  if (order.length < 2) return;
  const i = order.indexOf(app.groups.focused);
  const gid = order[(i + dir + order.length) % order.length];
  focusGroup(gid);
  ed.focus();
}

/** "Open to the Side": opens `path` in the group to the right, splitting if there is none. */
export async function openToSide(path: string) {
  const order = groupOrder(app.groups.root);
  const right = order[order.indexOf(app.groups.focused) + 1];
  const gid = right ?? splitGroup("right", app.groups.focused, null)!;
  if (right) focusGroup(right);
  path = resolveDots(normPath(path));
  const open = app.tabs.find((t) => t.path === path || t.viewOf === path || t.headOf === path);
  if (open) return activateIn(gid, open.id);
  await openFile(path);
  // Not opened (error, declined): the new empty group goes again.
  if (!right && app.groups.groups[gid] && !app.groups.groups[gid].tabs.length) removeGroup(gid);
}

/** Replaces the groups (session restore). Groups whose panes exist show their tab at once, the others once mounted. */
export function setGroups(next: Groups) {
  const gone = Object.keys(app.groups.groups).filter((id) => !(id in next.groups));
  app.groups = next;
  for (const id of gone) ed.destroyPane(id);
  setFocused(next.focused);
  const g = focusedGroup();
  app.activeId = g.active;
  const tab = activeTab();
  const mode = tab && modeIn(g, tab);
  if (mode) enterMode(mode, false);
  refreshGroups();
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
onGlobalChange("recentFiles", (v) => void recent.splice(0, recent.length, ...(JSON.parse(v || "[]") as string[])));

/**
 * Shows tab `id`: in the focused group if it's there; else in the group that already shows it;
 * else it's added to the focused group.
 */
export function activate(id: string) {
  let gid = app.groups.focused;
  if (!focusedGroup()?.tabs.includes(id)) {
    const other = groupOrder(app.groups.root).find((g) => app.groups.groups[g].active === id);
    if (other) gid = other;
  }
  activateIn(gid, id);
}

/**
 * `quiet`: nobody asked for this file right now (session restore), so a too large one is only reported.
 * `atLine`: the caller goes on to a line or selection in it, so an SVG opens as text. Binary kinds stay viewers.
 */
export async function openFile(path: string, quiet = false, atLine = false) {
  path = resolveDots(normPath(path));
  if (atLine && isSvgPath(path)) return openSvgAsText(path, quiet);
  const existing = app.tabs.find((t) => t.path === path || t.headOf === path || t.viewOf === path);
  if (existing) return activate(existing.id);
  if (isRemotePath(path)) return collabHooks.openRemote(path);
  const kind = viewerKind(path);
  if (kind && !wantsText(path)) return openViewerTab(path, kind);
  let content: string;
  try {
    content = await fsApi.readFile(path);
  } catch (e) {
    // Marked as text, but only an SVG can be: anything else still gets its viewer.
    if (kind && !isSvgPath(path)) return openViewerTab(path, kind);
    const info = await fsApi.fileInfo(path).catch(() => null);
    if (kind && !info?.too_large) return openViewerTab(path, kind);
    if (info?.too_large) return info.preview ? openHead(path, info.size, quiet) : openLarge(path, info.size, quiet);
    ui.toast(t("app.cannotOpenFile", { error: String(e) }), "error");
    return;
  }
  const id = uid();
  ed.createDoc(id, content);
  // A file without a clear mode opens in the current one, and keeps it.
  const mode = suggestedMode(path) ?? app.mode;
  app.tabs.push({ id, path, name: basename(path), dirty: false, root: inRoot(path, app.root) ? app.root : null, eol: detectEol(content), mode });
  activate(id);
  collabHooks.tabOpened(id, path);
}

/** Viewable files the user asked to see as text ("Open as Text"), until that text tab closes. */
const textViews = new Set<string>();
/** The file should open as text: the user chose so, here or through a language override. */
export const wantsText = (path: string) => textViews.has(path) || !!overrideFor(path);

async function openViewerTab(path: string, viewer: ViewerKind) {
  const info = await fsApi.fileInfo(path).catch(() => null);
  if (!info && !(await fsApi.exists(path).catch(() => false))) {
    ui.toast(t("app.cannotOpenFile", { error: t("app.fsErr.not_found", { name: basename(path) }) }), "error");
    return;
  }
  const open = app.tabs.find((x) => x.viewOf === path);
  if (open) return activate(open.id);
  const id = addViewerTab(path, viewer);
  if (info) diskStamps.set(id, stampOf(info));
  activate(id);
}

function addViewerTab(path: string, viewer: ViewerKind) {
  const id = uid();
  ed.createDoc(id, "");
  app.tabs.push({ id, path: null, name: basename(path), dirty: false, root: inRoot(path, app.root) ? app.root : null, viewOf: path, viewer, viewRev: 0 });
  return id;
}

/** Code Together guest: a viewer tab for a shared file; its bytes come through the host's checks. */
export function openRemoteViewer(path: string, viewer: ViewerKind) {
  const open = app.tabs.find((x) => x.viewOf === path);
  activate(open ? open.id : addViewerTab(path, viewer));
}

/** The next open of this SVG gives text; a viewer tab of it closes. True if there was one. */
export async function preferText(path: string) {
  textViews.add(path);
  const viewer = app.tabs.find((x) => x.viewOf === path);
  if (viewer) await closeTab(viewer.id, true);
  return !!viewer;
}

async function openSvgAsText(path: string, quiet: boolean) {
  const hadViewer = await preferText(path);
  await openFile(path, quiet);
  // Not readable as text (a toast said why), or the large-file question was declined. A guest's tab arrives later.
  if (isRemotePath(path) || app.tabs.some((x) => x.path === path || x.headOf === path)) return;
  textViews.delete(path);
  if (hadViewer && !app.tabs.some((x) => x.viewOf === path)) await openFile(path, quiet);
}

/** "Open as Text" on an SVG viewer: replaces the tab by a normal editor tab. */
export async function openViewerAsText(id: string) {
  const path = app.tabs.find((x) => x.id === id)?.viewOf;
  if (path) await openSvgAsText(path, false);
}

/** 8 to 64 MiB: warns, then opens the whole file, editable, without the expensive features (#174). */
async function openLarge(path: string, size: number, quiet: boolean) {
  const name = basename(path);
  const sizeText = formatSize(size);
  if (quiet) return ui.toast(t("app.large.skipped", { name, size: sizeText }));
  const choice = await ui.choose(t("app.large.title", { name }), t("app.large.fullMessage", { size: sizeText }), [
    { label: t("common.cancel"), value: "cancel" },
    { label: t("app.large.openFull"), value: "full", primary: true },
  ]);
  if (choice !== "full") return;
  const before = await fsApi.fileInfo(path).catch(() => null);
  let content: string;
  try {
    content = await fsApi.readFileLarge(path);
  } catch (e) {
    // It grew past the limit since the question.
    const now = await fsApi.fileInfo(path).catch(() => null);
    if (now?.preview) return openHead(path, now.size, false);
    ui.toast(t("app.cannotOpenFile", { error: String(e) }), "error");
    return;
  }
  const open = app.tabs.find((x) => x.path === path);
  if (open) return activate(open.id);
  const id = uid();
  ed.createDoc(id, content);
  if (before) diskStamps.set(id, stampOf(before));
  app.tabs.push({ id, path, name, dirty: false, root: inRoot(path, app.root) ? app.root : null, eol: detectEol(content), large: true });
  activate(id);
}

/** A file too large to load: warns, then offers its start as a read-only tab (#174). */
async function openHead(path: string, size: number, quiet: boolean) {
  const name = basename(path);
  const sizeText = formatSize(size);
  if (quiet) return ui.toast(t("app.large.skipped", { name, size: sizeText }));
  const choice = await ui.choose(t("app.large.title", { name }), t("app.large.message", { size: sizeText }), [
    { label: t("common.cancel"), value: "cancel" },
    { label: t("app.large.openHead"), value: "head", primary: true },
  ]);
  if (choice !== "head") return;
  const open = app.tabs.find((x) => x.headOf === path);
  if (open) return activate(open.id);
  let head: { text: string; size: number };
  try {
    head = await fsApi.readFileHead(path);
  } catch (e) {
    ui.toast(t("app.cannotOpenFile", { error: String(e) }), "error");
    return;
  }
  const id = uid();
  ed.createDoc(id, head.text);
  const headNote = t("app.large.banner", { shown: formatSize(byteLength(head.text)), size: formatSize(head.size) });
  app.tabs.push({ id, path: null, name: t("app.large.tabName", { name }), dirty: false, headOf: path, headNote });
  activate(id);
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
  app.tabs.push({ id, path, name, dirty: false, mode: modeForPath(path) ?? app.mode });
  activate(id);
  return id;
}

export function newFile() {
  const id = uid();
  ed.createDoc(id, "");
  app.tabs.push({ id, path: null, name: t("app.untitled", { n: untitledCounter++ }), dirty: false });
  activate(id);
}

/** New File from the UI: a connected guest creates it in the host's project (#133). */
export async function newFileInSession() {
  if (guestGuard.status() === "connected") {
    const { share, remoteCreate } = await import("./collab/share.svelte");
    if (share.hostHasRoot) return remoteCreate("", false);
    ui.toast(t("ai.collab.localFileHint"));
  }
  newFile();
}

const closedPaths: string[] = [];

/** Ctrl+⇧+T: reopens the most recently closed file. */
export async function reopenClosedTab() {
  while (closedPaths.length) {
    const p = closedPaths.pop()!;
    if (!app.tabs.some((t) => t.path === p || t.viewOf === p) && (await fsApi.exists(p))) return openFile(p);
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
  const wasActive = app.activeId === id;
  collabHooks.tabClosed(tab.path, tab.id);
  const closedFile = tab.path ?? tab.viewOf;
  if (closedFile && !isRemotePath(closedFile)) {
    closedPaths.push(closedFile);
    if (closedPaths.length > 30) closedPaths.shift();
  }
  const textFile = tab.path ?? tab.headOf;
  if (textFile) textViews.delete(textFile);
  ed.disposeDoc(id);
  forgetViewer(id);
  settling.delete(id);
  diskStamps.delete(id);
  staleNoticed.delete(id);
  if (tab.path) closeLspDoc(tab.path);
  const holders = groupOrder(app.groups.root).filter((g) => app.groups.groups[g].tabs.includes(id));
  // The focused group last, so the focus ends up where it was.
  holders.sort((a, b) => Number(a === app.groups.focused) - Number(b === app.groups.focused));
  for (const gid of holders) dropFromGroup(gid, id);
  if (wasActive && !holders.length) {
    app.activeId = null;
    ed.activate(null, cfg());
  }
}

/** `overwrite`: write even if the file changed on disk since it was loaded (the user chose so). */
export async function save(id = app.activeId, forceDialog = false, overwrite = false): Promise<boolean> {
  const tab = app.tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (tab.viewOf) {
    ui.toast(t("app.viewer.noSave"), "error");
    return false;
  }
  if (tab.headOf) {
    // Only the start of the file is loaded: saving it anywhere would pass for the whole file.
    ui.toast(t("app.large.noSave"), "error");
    return false;
  }
  if (isRemotePath(tab.path)) {
    if (!forceDialog) return true; // saved by the host
    const { saveCopyToHost } = await import("./collab/guestFiles");
    return saveCopyToHost(tab);
  }
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
      disk = fromDisk(await (tab.large ? fsApi.readFileLarge(path) : fsApi.readFile(path)));
    } catch {
      // Missing: nothing to protect. Too large for this read: compare it whole up to 64 MiB; past
      // that, only a file of exactly the size we last wrote counts as unchanged (#174).
      const info = await fsApi.fileInfo(path).catch(() => null);
      if (info?.preview) {
        if (info.size !== byteLength(toDisk(ed.savedText(tab.id) ?? "", tab.eol))) return resolveConflict(tab);
      } else if (info?.too_large) {
        try {
          disk = fromDisk(await fsApi.readFileLarge(path));
        } catch {
          return resolveConflict(tab);
        }
      }
    }
    const saved = ed.savedText(tab.id);
    // write_file replaced lone surrogates with U+FFFD, so compare against that (#21).
    if (disk !== null && saved !== null && disk !== wellFormed(saved) && disk !== wellFormed(ed.getText(tab.id))) return resolveConflict(tab);
  }
  const snapshot = ed.getDoc(tab.id);
  // Never write without a live document (e.g. after an editor reset) – that would empty the file.
  if (!snapshot) return false;
  const undoToolPause = toolsBeforeSave(tab.id, tab.path, path);
  writing.add(tab.id);
  try {
    await fsApi.writeFile(path, toDisk(snapshot.toString(), tab.eol));
    if (tab.large) await rememberStamp(tab.id, path);
  } catch (e) {
    undoToolPause();
    ui.toast(t("app.saveFailed", { error: String(e) }), "error");
    return false;
  } finally {
    writing.delete(tab.id);
  }
  ed.markSaved(tab.id, snapshot);
  tab.deleted = false;
  window.dispatchEvent(new CustomEvent("omega:saved", { detail: path }));
  if (!tab.large) void saveLspDoc(path, ed.getText(tab.id));
  if (tab.path !== path) {
    if (tab.path) closeLspDoc(tab.path);
    tab.path = path;
    tab.name = basename(path);
    app.treeVersion++;
    refreshGroups();
  }
  tab.dirty = ed.isDirty(tab.id);
  if (tab.dirty) scheduleAutosave(tab.id);
  return true;
}

export async function openFolder() {
  if (blockedAsGuest()) return;
  const dir = await openDialog({ directory: true, defaultPath: app.root ?? undefined });
  if (typeof dir === "string") setRoot(dir);
}

/** Recently opened folders (most recent first). */
export const recentFolders = $state<string[]>(JSON.parse(localStorage.getItem("recentFolders") || "[]"));

onGlobalChange("recentFolders", (v) => void recentFolders.splice(0, recentFolders.length, ...(JSON.parse(v || "[]") as string[])));

export function setRoot(dir: string | null) {
  // Clearing stays allowed: joining puts the own folder aside that way.
  if (dir && blockedAsGuest()) return;
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
  moveLanguageOverrides(from, to);
  moveImagePermissions(from, to);
  for (const p of [...textViews]) {
    if (p !== from && !p.startsWith(from + "/")) continue;
    textViews.delete(p);
    if (to !== null) textViews.add(to + p.slice(from.length));
  }
  for (const t of app.tabs) {
    if (t.viewOf && (t.viewOf === from || t.viewOf.startsWith(from + "/"))) {
      settling.delete(t.id);
      if (to === null) t.deleted = true;
      else {
        t.viewOf = to + t.viewOf.slice(from.length);
        t.name = basename(t.viewOf);
        t.deleted = false;
        t.viewRev = (t.viewRev ?? 0) + 1;
      }
    }
    if (t.headOf && to !== null && (t.headOf === from || t.headOf.startsWith(from + "/"))) t.headOf = to + t.headOf.slice(from.length);
    if (!t.path) continue;
    if (t.path === from || t.path.startsWith(from + "/")) {
      closeLspDoc(t.path);
      if (to === null) {
        t.path = null;
        t.dirty = true;
      } else {
        t.path = to + t.path.slice(from.length);
        t.name = basename(t.path);
      }
      ed.refreshLanguage(t.id, t.path);
    }
  }
  collabHooks.pathMoved(from, to);
  app.treeVersion++;
}

/** Ctrl+Tab: the next tab of the focused group. */
export function cycleTab(dir: 1 | -1) {
  const tabs = focusedGroup().tabs;
  if (!tabs.length) return;
  const i = tabs.indexOf(app.activeId ?? "");
  activateIn(app.groups.focused, tabs[(i + dir + tabs.length) % tabs.length]);
}
