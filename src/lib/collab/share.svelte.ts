/**
 * Shared editing on top of the session (collab.svelte.ts):
 *  - Host owns the files. Each shared file is a Y.Doc; edits from everybody merge there and the
 *    host saves to disk (via its normal autosave for open tabs, or directly for background docs).
 *  - Guests open files as virtual tabs "collab:<relative path>" bound to their copy of the Y.Doc.
 *  - Remote cursors via Yjs awareness (y-codemirror.next), presence messages drive "follow mode".
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import { invoke } from "@tauri-apps/api/core";
import { ChangeSet, EditorState, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collab, send, broadcast, onCollabMessage } from "./collab.svelte";
import { blockedByCapability, guestCan } from "./guard";
import { guestMayWrite, hookLocked, refreshHookLocks, resetHookLocks } from "./hooksGuard";
import { call, fits, forgetRpcPeer, hasCapability, isApproved, isObj, onCapabilitiesChanged, registerMethod, rpcErrorText, RpcFail } from "./rpc.svelte";
import { app, openFile, activeTab, activate, collabHooks, setMode, pathMoved, type Tab } from "../state.svelte";
import type { Mode } from "../modes";
import { MODES } from "../modeList";
import { onFilesChanged } from "../fsWatch.svelte";
import * as ed from "../editor";
import { fsApi, joinPath, basename } from "../api";
import { viewActions } from "../editorActions";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

export const REMOTE = "collab:";
export const isRemote = (p: string | null | undefined) => !!p && p.startsWith(REMOTE);

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface SharedDoc {
  rel: string;
  /** Host: the project folder `rel` belongs to. The host can open another one during a session. */
  root: string | null;
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  undo: Y.UndoManager;
  tabId: string | null;
  /** Host: guests that opened this doc. */
  subscribers: Set<string>;
  writeTimer?: number;
  /** Host, background docs: the write in progress, so writes land in order. */
  writing?: Promise<void>;
  /** Host, background docs: the file content as last read or written, to notice outside changes. */
  disk?: string;
  /** Guest: the host refuses edits here (a git hook, and this guest has no `run`). */
  locked?: boolean;
  cleanup: (() => void)[];
}

const docs = new Map<string, SharedDoc>();
/** Host: old key → new key of renamed docs, for guest messages still sent under the old name. */
const renamed = new Map<string, string>();
const hostDocAt = (path: string) => docs.get(path) ?? docs.get(renamed.get(path) ?? "");

/** A shared document as other host-side features see it. */
export type SharedDocView = Pick<SharedDoc, "rel" | "root" | "ytext"> & { readonly subscribers: ReadonlySet<string> };
/** Runs when a doc appeared, went, moved, or its set of guests changed. */
export const sharedDocListeners = new Set<() => void>();
const docsChanged = () => {
  for (const l of sharedDocListeners) l();
};
export const sharedDocs = (): SharedDocView[] => [...docs.values()];
/** The live text of a shared doc on this side of the session. */
export const sharedText = (rel: string): Y.Text | null => docs.get(rel)?.ytext ?? null;

export const share = $state({
  /** Host project name (guest side). */
  hostRoot: "",
  /** Guest: whether the host has a folder open (otherwise only its open tabs are shared). */
  hostHasRoot: true,
  /** Guest: the host's open tabs (doc key + name), see session.svelte.ts. */
  hostTabs: [] as { key: string; name: string }[],
  /** Guest: bumped when the host's files changed, so the remote tree reloads. */
  treeGen: 0,
  /** peer -> {file, line} presence of everyone (incl. "host"). */
  presence: {} as Record<string, { file: string | null; line: number; name: string; color: string; mode?: Mode }>,
  following: null as string | null,
});

const lighten = (hex: string) => hex + "33";

/** Origin of a guest's own Replace: its undo stack tracks it, and background tabs mirror it. */
const GUEST_REPLACE = "guest-replace";

function makeDoc(rel: string, isHost: boolean): SharedDoc {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", { name: collab.me.name, color: collab.me.color, colorLight: lighten(collab.me.color) });
  // Undo only covers edits made in this editor (yCollab adds its origin when bound): not the
  // initial load of the text (origin null), which would otherwise be the first undo step (#126).
  const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([GUEST_REPLACE]) });
  const d: SharedDoc = { rel, root: app.root, ydoc, ytext, awareness, undo, tabId: null, subscribers: new Set(), cleanup: [] };

  // Local Yjs changes → network. Origin = peer id for remote updates, so they aren't echoed back.
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    const msg = { t: "doc.update", path: d.rel, update: b64(update) };
    if (isHost) {
      for (const p of d.subscribers) if (p !== origin) send(p, msg);
      scheduleHostWrite(d);
    } else if (origin !== "remote") send(collab.hostPeer!, msg);
  };
  ydoc.on("update", onUpdate);

  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = added.concat(updated, removed);
    const msg = { t: "aw", path: d.rel, update: b64(encodeAwarenessUpdate(awareness, changed)) };
    if (isHost) {
      for (const p of d.subscribers) if (p !== origin) send(p, msg);
    } else if (origin !== "remote") send(collab.hostPeer!, msg);
  };
  awareness.on("update", onAwareness);

  // Remote edits for a tab that isn't the visible one: mirror them into its stored state
  // (the yCollab plugin only lives in the visible editor).
  const onText = (e: Y.YTextEvent, tr: Y.Transaction) => {
    // Only network changes (origin = peer id / "remote"); local edits come from the visible editor.
    // A Find preview is a second editor on the doc, so its edits and undo steps count here too.
    if (typeof tr.origin !== "string" && !previewSubs.has(d.rel)) return;
    if (!d.tabId || ed.isActive(d.tabId) || !ed.hasDoc(d.tabId)) return;
    const changes: ChangeSpec[] = [];
    let pos = 0;
    for (const op of e.delta) {
      if (op.retain) pos += op.retain;
      else if (op.insert) {
        changes.push({ from: pos, insert: op.insert as string });
      } else if (op.delete) {
        changes.push({ from: pos, to: pos + op.delete });
        pos += op.delete;
      }
    }
    // Marked as sync, so it also reaches the tab of a guest without `edit` (see `binding`).
    if (changes.length) ed.applyChanges(d.tabId, { changes: ChangeSet.of(changes, ed.getText(d.tabId).length), annotations: ySyncAnnotation.of(null as never) });
  };
  ytext.observe(onText);

  d.cleanup.push(() => {
    ydoc.off("update", onUpdate);
    awareness.off("update", onAwareness);
    ytext.unobserve(onText);
    removeAwarenessStates(awareness, [ydoc.clientID], "local");
    awareness.destroy();
    undo.destroy();
    ydoc.destroy();
  });
  docs.set(rel, d);
  return d;
}

/**
 * Frees a doc's handlers and Yjs objects. Safe to call twice (closing a guest tab during teardown
 * already disposes it; a second run made yjs log "Tried to remove event handler…", #135).
 */
function dispose(d: SharedDoc) {
  if (!d.cleanup.length) return;
  for (const f of d.cleanup.splice(0)) f();
  queueMicrotask(docsChanged); // callers remove it from the list right after
}

/** yCollab + undo actions for one tab. */
function binding(d: SharedDoc) {
  return [
    yCollab(d.ytext, d.awareness, { undoManager: d.undo }),
    viewActions.of({
      // Without `edit` the host would drop the step and this copy would drift.
      "collab.undo": () => (guestCan("edit") && !d.locked && d.undo.undo(), true),
      "collab.redo": () => (guestCan("edit") && !d.locked && d.undo.redo(), true),
    }),
    // The host drops edits without the capability. Read-only stops typing; the filter also stops
    // commands that change the text directly, so the guest's copy can't drift. Host changes pass.
    ...(collab.role === "guest" && (!guestCan("edit") || d.locked) ? [EditorState.readOnly.of(true), EditorState.changeFilter.of((tr) => tr.annotation(ySyncAnnotation) !== undefined)] : []),
  ];
}

const relOf = (abs: string) => (app.root && abs.startsWith(app.root + "/") ? abs.slice(app.root.length + 1) : null);

/** A file name that means the git folder, also as Windows/macOS spell it (see is_git_name in collab.rs). */
const isGitName = (name: string) => {
  const base = name.replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, "").split(":")[0].replace(/[. ]+$/, "").toLowerCase();
  return base === ".git" || base === "git~1";
};

/** The checks on a guest path that need no file system: relative, no "..", no git folder. */
const relAllowed = (rel: unknown): rel is string =>
  typeof rel === "string" && !rel.includes("\0") && !/^([\\/]|[a-zA-Z]:)/.test(rel) && !rel.split(/[\\/]/).some((seg) => seg === ".." || isGitName(seg));

/** A project file's relative path, if guests may see it. */
const shareableRel = (abs: string) => {
  const rel = relOf(abs);
  return rel && relAllowed(rel) ? rel : null;
};

/**
 * Host: the key a tab is shared under, or null if guests must not see it. Project files use their
 * relative path (so the guest's file tree finds them), unsaved "Untitled" tabs their id
 * ("tab:<id>"). Files on disk outside the project and in a git folder aren't shared.
 */
export const hostKey = (tab: Tab): string | null => (tab.path ? shareableRel(tab.path) : `tab:${tab.id}`);

/** Like `hostKey`, but also resolves symlinks. Use it before telling guests about a tab. */
export async function hostKeyChecked(tab: Tab): Promise<string | null> {
  const key = hostKey(tab);
  return key && !key.startsWith("tab:") && !(await guestPathOk(key)) ? null : key;
}

// ------------------------------------------------------------------ host

/**
 * Host: the one check for every path a guest names. True if it stays inside the shared folder and
 * out of any git folder, also after resolving symlinks (#138: `ext -> /` in the project must not
 * open the whole disk; git config can run commands on the host). "" is the project root.
 */
export async function guestPathOk(rel: string, root: string | null = app.root): Promise<boolean> {
  if (!root || !relAllowed(rel)) return false;
  return invoke<boolean>("collab_path_inside", { root, path: rel ? joinPath(root, rel) : root }).catch(() => false);
}

/** What a host-side handler uses for guest paths: one project folder, captured when it starts. */
export interface GuestScope {
  readonly root: string;
  /** False once the host opened another folder: stop before changing anything. */
  live(): boolean;
  /** `guestPathOk` against the captured folder. */
  check(rel: string): Promise<boolean>;
  /** Absolute path for the host's own calls. Never send it to a guest. */
  abs(rel: string): string;
  /** Relative path for a result, or null if guests may not see it. */
  rel(abs: string): string | null;
}

/** The scope for one request, or null if the host has no folder open. */
export function guestScope(): GuestScope | null {
  const root = app.root;
  if (!root) return null;
  return {
    root,
    live: () => app.root === root,
    check: (rel) => guestPathOk(rel, root),
    abs: (rel) => (rel ? joinPath(root, rel) : root),
    rel: (abs) => {
      if (abs === root) return "";
      const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : null;
      return rel && relAllowed(rel) ? rel : null;
    },
  };
}

/** Host: the live text of one project file, if it's open in the session. */
export function hostLiveText(scope: GuestScope, rel: string): string | undefined {
  const d = docs.get(rel);
  if (d && d.root === scope.root) return d.ytext.toString();
  const tab = app.tabs.find((x) => x.path === scope.abs(rel));
  return tab ? ed.getText(tab.id) : undefined;
}

/**
 * Host: the text of the project files open in the session, which can be ahead of the disk, up to
 * the given sizes. `omitted` are open files that didn't fit: their disk copy may be out of date.
 */
export function hostLiveTexts(scope: GuestScope, maxFile = Infinity, maxTotal = Infinity) {
  const live = new Map<string, string>();
  for (const tab of app.tabs) {
    const rel = tab.path ? scope.rel(tab.path) : null;
    if (rel) live.set(rel, ed.getText(tab.id));
  }
  // A shared doc is the newest copy, also of a file with a tab.
  for (const d of docs.values()) if (d.root === scope.root && !d.rel.startsWith("tab:")) live.set(d.rel, d.ytext.toString());
  const texts: Record<string, string> = {};
  const omitted: string[] = [];
  let total = 0;
  for (const [rel, text] of live) {
    if (text.length > maxFile || total + text.length > maxTotal) omitted.push(rel);
    else {
      texts[rel] = text;
      total += text.length;
    }
  }
  return { texts, omitted };
}

/** Host: whether a guest's update up to `clock` has arrived in the shared doc. */
export function hostDocHasClock(rel: string, client: number, clock: number) {
  const d = hostDocAt(rel);
  return !!d && Y.getState(d.ydoc.store, client) >= clock;
}

export interface ReplacePlan {
  /** (from, to, text) in UTF-16 offsets, ascending. */
  edits: [number, number, string][];
  count: number;
  /** Version of the text the plan is for. */
  version: string;
}

/** Host: disk writes of a guest's Replace in progress. Opening that file waits for them. */
const diskReplaces = new Map<string, Promise<unknown>>();

/** Applied by the host for a guest: a string origin, so it reaches every guest and background tab. */
const REPLACE_ORIGIN = "search-replace";

/**
 * Host: replaces in one file for a guest. A file open in the session changes in its shared doc, so
 * everybody sees it live and unsaved text is kept; only a file nobody has open is written to disk.
 * Throws an `RpcFail` if nothing was changed.
 */
export async function hostReplaceIn(scope: GuestScope, rel: string, plan: (text: string) => Promise<ReplacePlan>, signal: AbortSignal): Promise<number> {
  const stop = () => {
    if (signal.aborted) throw new RpcFail("cancelled");
    if (!scope.live()) throw new RpcFail("unavailable");
  };
  if (!safeRel(rel) || !(await scope.check(rel))) throw new RpcFail("unavailable");
  await invoke("guest_write_check", { root: scope.root, rel });
  const abs = scope.abs(rel);
  const isOpen = () => docs.has(rel) || app.tabs.some((x) => x.path === abs);
  // The text can change while the plan is computed: then plan again on the new text.
  for (let attempt = 0; attempt < 3; attempt++) {
    stop();
    if (isOpen()) {
      const d = await hostDoc(rel);
      stop();
      if (!d || d.root !== scope.root) throw new RpcFail("unavailable");
      const text = d.ytext.toString();
      const { edits, count } = await plan(text);
      stop();
      if (!count) return 0;
      if (docs.get(rel) !== d || !d.cleanup.length || d.ytext.toString() !== text) continue;
      d.ydoc.transact(() => {
        for (let i = edits.length - 1; i >= 0; i--) {
          const [from, to, insert] = edits[i];
          d.ytext.delete(from, to - from);
          if (insert) d.ytext.insert(from, insert);
        }
      }, REPLACE_ORIGIN);
      return count;
    }
    const text = await invoke<string | null>("guest_read_text", { root: scope.root, rel });
    if (text === null) throw new RpcFail("unreadable");
    const { edits, count, version } = await plan(text);
    stop();
    if (!count) return 0;
    // No await from here to the write: a doc opened by now takes this change as a live edit.
    if (isOpen()) continue;
    let out = "";
    let pos = 0;
    for (const [from, to, insert] of edits) {
      out += text.slice(pos, from) + insert;
      pos = to;
    }
    const writing = invoke("guest_write_text", { root: scope.root, rel, expected: version, content: out + text.slice(pos) });
    const settled = writing.catch(() => {});
    diskReplaces.set(rel, settled);
    try {
      await writing;
    } finally {
      if (diskReplaces.get(rel) === settled) diskReplaces.delete(rel);
    }
    return count;
  }
  throw new RpcFail("busy");
}

function scheduleHostWrite(d: SharedDoc) {
  // Open tabs are saved by the host's autosave; background docs are written here.
  if (d.tabId || !d.root) return;
  clearTimeout(d.writeTimer);
  d.writeTimer = window.setTimeout(() => void hostWrite(d), 700);
}

/** Writes a background doc to its own folder; one write at a time, so the newest text lands last. */
function hostWrite(d: SharedDoc) {
  d.writing = (d.writing ?? Promise.resolve()).then(() => writeBackgroundDoc(d)).catch(() => {});
  return d.writing;
}

/** Host: writes the shared text of files without a tab now, e.g. before a debug run reads them. */
export async function flushBackgroundDocs() {
  const pending = [...docs.values()].filter((d) => !d.tabId && d.root === app.root);
  for (const d of pending) clearTimeout(d.writeTimer);
  await Promise.all(pending.map(hostWrite));
}

async function writeBackgroundDoc(d: SharedDoc) {
  if (d.tabId || !d.root || !d.cleanup.length) return;
  const abs = joinPath(d.root, d.rel);
  const text = d.ytext.toString();
  if (text === d.disk) return;
  if (!(await guestPathOk(d.rel, d.root))) return; // e.g. a folder was swapped for a symlink meanwhile
  // The file changed outside Omega and the watcher hasn't told us yet: take that change instead of
  // overwriting it (#128).
  const now = await fsApi.readFile(abs).catch(() => undefined);
  if (!d.cleanup.length) return;
  if (now !== undefined && d.disk !== undefined && now !== d.disk) return d.ytext.toString() !== text ? keepTyped(d, now) : applyDisk(d, now);
  // Deleted meanwhile: don't bring the file back (#134).
  if (now === undefined && d.disk !== undefined && !(await fsApi.exists(abs).catch(() => true))) return hostFileGone(d);
  const before = d.disk;
  d.disk = text;
  await fsApi.writeFile(abs, text).catch(() => (d.disk = before));
}

/** Host: a background doc's file changed on disk → everybody gets the new content. */
async function hostReload(d: SharedDoc): Promise<boolean> {
  if (d.tabId || !d.root) return false;
  const before = d.ytext.toString();
  if (!(await guestPathOk(d.rel, d.root))) {
    if (docs.get(d.rel) === d) hostUnshare(d); // e.g. now a symlink
    return false;
  }
  const abs = joinPath(d.root, d.rel);
  const text = await fsApi.readFile(abs).catch(() => undefined);
  if (d.tabId || docs.get(d.rel) !== d) return false;
  if (text === undefined) {
    if (!(await fsApi.exists(abs).catch(() => true))) hostFileGone(d); // deleted outside Omega
    return false;
  }
  // Typed while the file was being read: that text must not be replaced by what's on disk.
  if (text !== d.disk && d.ytext.toString() !== before) {
    keepTyped(d, text);
    return true;
  }
  applyDisk(d, text);
  return false;
}

/** The file changed under text nobody has saved yet: the text stays and goes over the new file. */
function keepTyped(d: SharedDoc, disk: string | undefined) {
  if (disk !== undefined) d.disk = disk;
  scheduleHostWrite(d);
  ui.toast(t("git.guestKeptTyped", { file: d.rel }));
}

function applyDisk(d: SharedDoc, text: string) {
  if (text === d.disk) return;
  d.disk = text;
  clearTimeout(d.writeTimer);
  const cur = d.ytext.toString();
  if (cur === text) return;
  // Replace only the changed middle part, so remote cursors elsewhere stay where they are.
  let a = 0;
  while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
  d.ydoc.transact(() => {
    d.ytext.delete(a, cur.length - a - b);
    d.ytext.insert(a, text.slice(a, text.length - b));
  }, "disk");
}

/** Host, before git replaces files: writes pending background text. False if some of it couldn't be. */
export async function flushSharedDocs(): Promise<boolean> {
  const open = [...docs.values()].filter((d) => !d.tabId && d.root === app.root && !d.rel.startsWith("tab:"));
  await Promise.all(open.map(hostWrite));
  return open.every((d) => !d.cleanup.length || d.ytext.toString() === d.disk);
}

/** Host: whether a background doc holds text that isn't in its file yet. */
export const sharedDocUnsaved = (rel: string) => {
  const d = docs.get(rel);
  return !!d && !d.tabId && d.ytext.toString() !== d.disk;
};

/**
 * Host, after git replaced files: background docs take the new content, for everybody. Text typed
 * while git ran is kept and written over the new file, so it shows up as a change instead of
 * vanishing. Returns the files where that happened.
 */
export async function reloadSharedDocs(): Promise<string[]> {
  const kept: string[] = [];
  for (const d of [...docs.values()]) {
    if (d.tabId || d.root !== app.root || d.rel.startsWith("tab:")) continue;
    if (d.ytext.toString() === d.disk) {
      if (await hostReload(d)) kept.push(d.rel);
      continue;
    }
    const now = await fsApi.readFile(joinPath(d.root!, d.rel)).catch(() => undefined);
    if (docs.get(d.rel) !== d || d.tabId) continue;
    // Git left this file alone: the pending write simply goes ahead.
    if (now === d.disk) scheduleHostWrite(d);
    else {
      kept.push(d.rel);
      keepTyped(d, now);
    }
  }
  return kept;
}

async function hostDoc(rel: string): Promise<SharedDoc | null> {
  if (rel.startsWith("tab:")) {
    // Only unsaved tabs are shared by id: a path here would be a file outside the project.
    const tab = app.tabs.find((t) => t.id === rel.slice(4));
    if (!tab || tab.path) return null;
    const shared = docs.get(rel);
    if (shared) return shared;
    const d = makeDoc(rel, true);
    d.ytext.insert(0, ed.getText(tab.id));
    bindHostTab(d, tab.id);
    return d;
  }
  const root = app.root;
  if (!root || !(await guestPathOk(rel, root)) || app.root !== root) return null;
  const existing = docs.get(rel);
  if (existing) return existing;
  // A guest's Replace is being written: read the file after it, not halfway.
  const replacing = diskReplaces.get(rel);
  if (replacing) {
    await replacing;
    if (app.root !== root) return null;
    const opened = docs.get(rel);
    if (opened) return opened;
  }
  const abs = joinPath(root, rel);
  const tab = app.tabs.find((t) => t.path === abs);
  let text: string;
  try {
    text = tab ? ed.getText(tab.id) : await fsApi.readFile(abs);
  } catch {
    return null;
  }
  if (app.root !== root) return null; // the host opened another folder meanwhile
  const d = makeDoc(rel, true);
  d.ytext.insert(0, text);
  if (tab) bindHostTab(d, tab.id);
  else d.disk = text;
  return d;
}

function bindHostTab(d: SharedDoc, tabId: string) {
  // The editor content must equal the Y.Text when binding.
  if (ed.getText(tabId) !== d.ytext.toString()) ed.replaceDocText(tabId, d.ytext.toString());
  d.tabId = tabId;
  ed.setCollab(tabId, binding(d));
}

/**
 * Host closed a tab: docs shared by tab id disappear for the guests too; project files keep being
 * shared from disk (and written back in the background again).
 */
function onHostTabClosed(tabId: string) {
  for (const d of docs.values()) {
    if (d.tabId !== tabId) continue;
    d.tabId = null;
    if (d.rel.startsWith("tab:")) {
      for (const p of d.subscribers) send(p, { t: "doc.gone", path: d.rel });
      dispose(d);
      docs.delete(d.rel);
    } else {
      // From now on the file on disk is the reference (the tab was saved or discarded).
      d.disk = d.ytext.toString();
      void hostReload(d);
    }
  }
}

/**
 * Host: a shared file was deleted. Guests keep their text as an unsaved tab; a host tab keeps it
 * too (state.svelte.ts turned it into an unsaved one), it's just no longer shared (#134).
 */
function hostFileGone(d: SharedDoc) {
  for (const p of d.subscribers) send(p, { t: "doc.gone", path: d.rel, reason: "deleted" });
  clearTimeout(d.writeTimer);
  if (d.tabId) ed.setCollab(d.tabId, null);
  dispose(d);
  if (docs.get(d.rel) === d) docs.delete(d.rel);
}

/**
 * Host: guests lose a doc they may no longer see. Normally their tab closes; with reason "folder"
 * (the host opened another folder) they keep their text as an unsaved tab.
 */
function hostUnshare(d: SharedDoc, reason?: "folder") {
  for (const p of d.subscribers) send(p, { t: "doc.gone", path: d.rel, ...(reason ? { reason } : {}) });
  clearTimeout(d.writeTimer);
  if (d.tabId) ed.setCollab(d.tabId, null);
  dispose(d);
  if (docs.get(d.rel) === d) docs.delete(d.rel);
}

/**
 * Host: a background doc of the previous folder. It leaves the doc list at once, so its name is
 * free for the new folder, and pending edits are written to the old location before it goes.
 */
async function retireBackgroundDoc(d: SharedDoc) {
  for (const p of d.subscribers) send(p, { t: "doc.gone", path: d.rel, reason: "folder" });
  d.subscribers.clear();
  docs.delete(d.rel);
  docsChanged();
  clearTimeout(d.writeTimer);
  await hostWrite(d);
  clearTimeout(d.writeTimer);
  if (d.cleanup.length && d.ytext.toString() !== d.disk) ui.toast(t("ai.collab.flushFailed", { file: d.rel }), "error");
  dispose(d);
}

/**
 * Host: docs follow their tab's path and the open folder. An Untitled tab saved into the project
 * moves to its relative path; one saved outside it (or a tab left behind by a folder change) stops
 * being shared. Background docs of a previous folder are written there and retired.
 */
export async function syncSharedTabs() {
  if (collab.role !== "host") return;
  const all = [...docs.values()];
  if (all.some((d) => d.root !== app.root)) renamed.clear(); // old names mean nothing in a new folder
  // Background docs first: a tab moving to the same name must not count as replacing them.
  const flushes = all.filter((d) => !d.tabId && d.root !== app.root).map(retireBackgroundDoc);
  for (const d of all) {
    const tab = d.tabId ? app.tabs.find((t) => t.id === d.tabId) : null;
    if (!tab) continue;
    const key = hostKey(tab);
    if (key === null) hostUnshare(d, d.root !== app.root ? "folder" : undefined);
    else {
      if (key !== d.rel) hostRename(d, key);
      if (d.root !== app.root) {
        d.root = app.root;
        docsChanged();
      }
    }
  }
  await Promise.all(flushes);
}

/** Host: a file or folder was deleted (`to` null) or renamed in the explorer. */
function onHostPathMoved(from: string, to: string | null) {
  if (collab.role !== "host") return;
  void syncSharedTabs();
  const rel = relOf(from);
  if (!rel) return;
  for (const d of [...docs.values()]) {
    if (d.rel !== rel && !d.rel.startsWith(rel + "/")) continue;
    const dest = to === null ? null : shareableRel(to + d.rel.slice(rel.length));
    if (dest === null) hostFileGone(d);
    else hostRename(d, dest);
  }
}

/** Host: a shared file was renamed → the doc (and the guests' tabs) follow it (#127). */
function hostRename(d: SharedDoc, dest: string) {
  const old = d.rel;
  const replaced = docs.get(dest);
  if (replaced && replaced !== d) hostFileGone(replaced);
  docs.delete(old);
  d.rel = dest;
  docs.set(dest, d);
  renamed.set(old, dest);
  for (const p of d.subscribers) send(p, { t: "doc.moved", path: old, to: dest, name: basename(dest) });
  docsChanged();
}

/** Host opened a file that is already shared → bind it. */
export function onHostTabOpened(tabId: string, abs: string) {
  if (collab.role !== "host") return;
  const rel = relOf(abs);
  const d = rel ? docs.get(rel) : null;
  if (d && !d.tabId && d.root === app.root) bindHostTab(d, tabId);
}

// ------------------------------------------------------------------ guest

const pendingOpens = new Map<string, { line?: number; range?: [number, number] }>();

/**
 * Guest: open a host file (relative path) as a shared tab, optionally at a line. `range` selects
 * those columns of the line (a search hit).
 */
export async function openRemote(rel: string, line?: number, range?: [number, number]) {
  const existing = docs.get(rel);
  if (existing?.tabId && app.tabs.some((t) => t.id === existing.tabId)) {
    const { activate } = await import("../state.svelte");
    activate(existing.tabId);
    if (line) scrollToLine(line, range);
    return;
  }
  pendingOpens.set(rel, { line, range });
  send(collab.hostPeer!, { t: "doc.open", path: rel });
}

function scrollToLine(line: number, range?: [number, number]) {
  const v = ed.getView();
  if (!v || line < 1) return;
  const l = v.state.doc.line(Math.min(line, v.state.doc.lines));
  const selection = range ? { anchor: Math.min(l.to, l.from + range[0]), head: Math.min(l.to, l.from + range[1]) } : undefined;
  v.dispatch({ selection, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
}

async function guestReceiveState(rel: string, update: Uint8Array, name?: string, locked = false) {
  const old = docs.get(rel);
  if (locked && !old?.locked) ui.toast(t("git.guestErr.hooks"), "error");
  // A fresh copy for a tab that's already open (capability change): same tab, host's text.
  const kept = old?.tabId ? app.tabs.find((x) => x.id === old.tabId) : undefined;
  const sub = previewSubs.get(rel);
  const forPreview = previewRequests.delete(rel);
  const tabless = !kept && !pendingOpens.has(rel) && (!!sub || forPreview);
  // The preview moved on before the host answered.
  if (tabless && !sub) return void send(collab.hostPeer!, { t: "doc.close", path: rel });
  if (old) {
    if (kept) ed.setCollab(kept.id, null);
    dispose(old);
  }
  const d = makeDoc(rel, false);
  d.locked = locked;
  Y.applyUpdate(d.ydoc, update, "remote");
  if (!tabless) {
    let tabId: string;
    if (kept) {
      const dirty = kept.dirty;
      ed.replaceDocText(kept.id, d.ytext.toString());
      kept.dirty = dirty;
      tabId = kept.id;
    } else {
      const { openVirtual } = await import("../state.svelte");
      tabId = openVirtual(REMOTE + rel, name || basename(rel), d.ytext.toString());
    }
    d.tabId = tabId;
    ed.setCollab(tabId, binding(d));
    const p = pendingOpens.get(rel);
    pendingOpens.delete(rel);
    if (p?.line) setTimeout(() => scrollToLine(p.line!, p.range), 50);
  }
  previewSubs.get(d.rel)?.onDoc(binding(d), d.ytext.toString());
}

// ------------------------------------------------------------------ Find preview (guest)

interface PreviewSub {
  rel: string;
  /** The editor binding and text of the doc; null when the doc is gone. */
  onDoc: (ext: Extension | null, text: string) => void;
}
const previewSubs = new Map<string, PreviewSub>();
/** Previews whose `doc.open` the host hasn't answered yet. */
const previewRequests = new Set<string>();

/**
 * Guest: edits a file in the Find preview through its shared doc, with no tab needed. `onDoc` gets a
 * new binding whenever the doc is replaced (e.g. the host changed `edit`). Returns the way to stop.
 */
export function guestPreviewDoc(rel: string, onDoc: PreviewSub["onDoc"]): () => void {
  const sub: PreviewSub = { rel, onDoc };
  previewSubs.set(rel, sub);
  const d = docs.get(rel);
  if (d) onDoc(binding(d), d.ytext.toString());
  else {
    previewRequests.add(rel);
    send(collab.hostPeer!, { t: "doc.open", path: rel });
  }
  return () => {
    if (previewSubs.get(sub.rel) !== sub) return;
    previewSubs.delete(sub.rel);
    const cur = docs.get(sub.rel);
    if (!cur || cur.tabId) return;
    if (collab.role === "guest" && collab.hostPeer) send(collab.hostPeer, { t: "doc.close", path: sub.rel });
    dispose(cur);
    docs.delete(sub.rel);
  };
}

/** The doc under a preview went away. */
function dropPreview(rel: string) {
  const sub = previewSubs.get(rel);
  if (!sub) return;
  previewSubs.delete(rel);
  sub.onDoc(null, "");
}

/** Guest: whether this file is open here as a shared doc. */
export const guestHasDoc = (rel: string) => docs.has(rel);

/**
 * Guest: a Replace in its own copy of a shared doc, so it lands on this guest's undo stack and
 * reaches the host like typing. `client` and `clock` identify the update for a delivery check.
 */
export async function guestReplaceInDoc(rel: string, plan: (text: string) => Promise<ReplacePlan>) {
  const d = docs.get(rel);
  if (!d) return null;
  const text = d.ytext.toString();
  const { edits, count } = await plan(text);
  if (docs.get(rel) !== d || !d.cleanup.length || d.ytext.toString() !== text) throw new RpcFail("changed");
  if (!guestCan("edit")) throw new RpcFail("forbidden");
  if (count) {
    d.undo.stopCapturing();
    d.ydoc.transact(() => {
      for (let i = edits.length - 1; i >= 0; i--) {
        const [from, to, insert] = edits[i];
        d.ytext.delete(from, to - from);
        if (insert) d.ytext.insert(from, insert);
      }
    }, GUEST_REPLACE);
    d.undo.stopCapturing();
  }
  return { count, client: d.ydoc.clientID, clock: Y.getState(d.ydoc.store, d.ydoc.clientID) };
}

/**
 * Guest: applies an edit made outside the editor (a reverted chunk in the diff) to a shared file.
 * False if the file isn't open here or changed since `base`, whose offsets `changes` refers to.
 */
export function editSharedDoc(rel: string, base: string, changes: ChangeSet): boolean {
  const d = docs.get(rel);
  if (!d || d.ytext.toString() !== base) return false;
  d.ydoc.transact(() => {
    const parts: { from: number; to: number; text: string }[] = [];
    changes.iterChanges((from, to, _fromB, _toB, inserted) => parts.push({ from, to, text: inserted.toString() }));
    for (const p of parts.reverse()) {
      if (p.to > p.from) d.ytext.delete(p.from, p.to - p.from);
      if (p.text) d.ytext.insert(p.from, p.text);
    }
  }, "git-diff");
  return true;
}

/** Guest: whether a shared file is open here and can be edited. */
export const sharedDocOpen = (rel: string) => docs.has(rel) && !docs.get(rel)!.locked;

/** Guest closed a shared tab. */
export function onTabClosed(path: string | null) {
  if (!isRemote(path) || collab.role !== "guest") return;
  const rel = path!.slice(REMOTE.length);
  const d = docs.get(rel);
  if (!d) return;
  // A Find preview is still on this doc: it stays, without the tab.
  if (previewSubs.has(rel)) {
    d.tabId = null;
    return;
  }
  send(collab.hostPeer!, { t: "doc.close", path: rel });
  dispose(d);
  docs.delete(rel);
}

// ------------------------------------------------------------------ remote file tree (guest)

interface FsEntry {
  name: string;
  rel: string;
  is_dir: boolean;
}

export async function listRemote(rel: string): Promise<FsEntry[]> {
  const r = await call("fs.list", { path: rel }, { timeoutMs: 8000 });
  return r.ok && Array.isArray(r.value) ? r.value.filter(isFsEntry) : [];
}

const isFsEntry = (e: unknown): e is FsEntry => isObj(e) && typeof e.name === "string" && typeof e.rel === "string" && typeof e.is_dir === "boolean";

// ------------------------------------------------------------------ file operations (guest → host)

declare module "./rpc.svelte" {
  interface RpcMethods {
    "fs.list": { params: { path: string }; result: FsEntry[] };
    "fs.op": { params: FsOpParams; result: null };
  }
}

type FsOp = "create" | "mkdir" | "rename" | "delete";
interface FsOpParams {
  op: FsOp;
  path: string;
  to?: string;
}
const FS_OPS: readonly unknown[] = ["create", "mkdir", "rename", "delete"] satisfies FsOp[];
const isFsOp = (op: unknown): op is FsOp => FS_OPS.includes(op);

/** A relative path inside the project: no empty parts, ".", ".." or backslashes. */
const safeRel = (rel: unknown): rel is string =>
  typeof rel === "string" && rel !== "" && !rel.includes("\\") && !rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..");

/**
 * Host: creates, renames or deletes a file for a guest (#133). Returns null, or a code the guest
 * translates: "invalid", "exists", "unavailable" or "failed" (the file system's message can hold
 * absolute paths, so it stays on the host).
 */
async function hostFsOp(peer: string, { op, path: rel, to: toRel }: FsOpParams, signal: AbortSignal): Promise<string | null> {
  // Checked and used against one folder: the host can open another during any await below.
  const scope = guestScope();
  if (!scope) return "unavailable";
  const live = () => scope.live() && !signal.aborted;
  if (!safeRel(rel) || (op === "rename" && !safeRel(toRel))) return "invalid";
  // Also through symlinks, nothing outside the shared folder (#138).
  if (!(await scope.check(rel)) || (op === "rename" && !(await scope.check(toRel as string)))) return "invalid";
  const abs = scope.abs(rel);
  const to = op === "rename" ? scope.abs(toRel as string) : null;
  // Moving or deleting a folder would take a nested repository's git folder with it.
  if ((op === "rename" || op === "delete") && (await invoke<boolean>("collab_tree_has_git", { path: abs }).catch(() => true))) return "invalid";
  // Git hooks are code on the host: without `run` a guest can't write them, or move a folder holding them.
  if (!(await guestMayWrite(peer, scope.root, op === "rename" ? [rel, toRel as string] : [rel], op === "rename" || op === "delete"))) return "hooks";
  if (!live()) return "unavailable";
  const who = collab.participants.find((p) => p.peer === peer)?.name ?? t("ai.collab.guest");
  try {
    if ((op === "create" || op === "mkdir" || op === "rename") && (await fsApi.exists(to ?? abs))) return live() ? "exists" : "unavailable";
    if (!live()) return "unavailable";
    if (op === "create") await fsApi.createFile(abs);
    else if (op === "mkdir") await fsApi.createDir(abs);
    else if (op === "rename") {
      await fsApi.rename(abs, to!);
      pathMoved(abs, to); // host tabs and shared docs follow
      ui.toast(t("ai.collab.guestRenamed", { name: who, file: rel, to: toRel as string }));
    } else if (op === "delete") {
      await fsApi.remove(abs);
      pathMoved(abs, null);
      ui.toast(t("ai.collab.guestDeleted", { name: who, file: rel }));
    }
  } catch (e) {
    console.error("guest file operation", e);
    return "failed";
  }
  return null;
}

registerMethod({
  name: "fs.op",
  capability: "edit",
  // Only the known operations: anything else must not fall through to one of them.
  validate: (raw) =>
    isObj(raw) && isFsOp(raw.op) && typeof raw.path === "string" && (raw.to === undefined || typeof raw.to === "string")
      ? { op: raw.op, path: raw.path, ...(raw.to === undefined ? {} : { to: raw.to }) }
      : null,
  handle: async (params, { peer, signal }) => {
    const error = await hostFsOp(peer, params, signal);
    if (error) throw new RpcFail(error);
    return null;
  },
});

registerMethod({
  name: "fs.list",
  capability: null, // every guest can browse, also without `edit`
  validate: (raw) => (isObj(raw) && typeof raw.path === "string" ? { path: raw.path } : null),
  handle: async ({ path: rel }) => {
    const scope = guestScope();
    if (!scope || !(await scope.check(rel)) || !scope.live()) return [];
    try {
      const listed = await fsApi.listDir(scope.abs(rel));
      if (!scope.live()) return [];
      return listed.filter((e) => !isGitName(e.name)).map((e) => ({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, is_dir: e.is_dir }));
    } catch {
      return [];
    }
  },
});

/** Guest: asks the host to change its project files; resolves to null or an error code. */
export async function remoteFsOp(op: FsOp, rel: string, to?: string): Promise<string | null> {
  const r = await call("fs.op", { op, path: rel, ...(to === undefined ? {} : { to }) }, { timeoutMs: 10000 });
  return r.ok ? null : r.error.code;
}

/** Text for an error code of `remoteFsOp`. */
export const opErrorText = (e: string, name: string) =>
  e === "invalid" || e === "invalid_params" ? t("app.invalidEntryName", { name }) : e === "exists" ? t("code.existsAlready", { name }) : e === "unavailable" ? t("ai.collab.fileUnavailable") : e === "hooks" ? t("git.guestErr.hooks") : rpcErrorText(e);

/** Guest: new file or folder in the host's project (`dir`: relative folder, "" = project root). */
export async function remoteCreate(dir: string, isDir: boolean) {
  if (blockedByCapability("edit")) return;
  const name = await ui.prompt(isDir ? t("app.newFolder") : t("app.newFile"), "", isDir ? t("app.folderNamePlaceholder") : t("app.fileNamePlaceholder"));
  if (!name) return;
  const rel = dir ? `${dir}/${name}` : name;
  const err = await remoteFsOp(isDir ? "mkdir" : "create", rel);
  if (err) return ui.toast(opErrorText(err, name), "error");
  share.treeGen++;
  if (!isDir) await openRemote(rel);
}

/** Guest: renames a file or folder of the host's project. */
export async function remoteRename(rel: string) {
  if (blockedByCapability("edit")) return;
  const name = basename(rel);
  const dot = name.lastIndexOf(".");
  const next = await ui.prompt(t("common.rename"), name, "", dot > 0 ? dot : undefined);
  if (!next || next === name) return;
  if (/[\\/]/.test(next)) return ui.toast(t("app.invalidRenameName", { name: next }), "error");
  const to = rel.includes("/") ? `${rel.slice(0, rel.lastIndexOf("/"))}/${next}` : next;
  const err = await remoteFsOp("rename", rel, to);
  if (err) return ui.toast(opErrorText(err, next), "error");
  share.treeGen++;
}

/** Guest: deletes a file or folder of the host's project (after asking). */
export async function remoteDelete(rel: string) {
  if (blockedByCapability("edit")) return;
  if (!(await ui.confirm(t("app.deleteConfirm", { name: basename(rel) }), t("app.cannotUndo"), t("common.delete"), true))) return;
  const err = await remoteFsOp("delete", rel);
  if (err) return ui.toast(opErrorText(err, basename(rel)), "error");
  share.treeGen++;
}

// ------------------------------------------------------------------ presence & follow

let lastPresence = "";
let presenceSeq = 0;
export async function publishPresence() {
  if (!collab.role || (collab.role === "guest" && collab.status !== "connected")) return;
  const tab = activeTab();
  const v = ed.getView();
  let file = tab ? (isRemote(tab.path) ? tab.path!.slice(REMOTE.length) : collab.role === "host" ? hostKey(tab) : null) : null;
  const line = v && tab ? v.state.doc.lineAt(v.state.selection.main.head).number : 1;
  const key = `${file}:${line}:${app.mode}`;
  if (key === lastPresence) return;
  lastPresence = key;
  const seq = ++presenceSeq;
  if (collab.role === "host" && tab && file && !isRemote(tab.path)) file = await hostKeyChecked(tab);
  if (seq !== presenceSeq || !collab.role) return;
  const msg = { t: "presence", peer: collab.role === "host" ? "host" : null, file, line, name: collab.me.name, color: collab.me.color, mode: app.mode };
  if (collab.role === "host") broadcast(msg);
  else send(collab.hostPeer!, msg);
}

export function follow(peer: string | null) {
  share.following = share.following === peer ? null : peer;
  if (share.following) applyFollow();
}

async function applyFollow() {
  const p = share.following ? share.presence[share.following] : null;
  if (!p) return;
  // Following someone also follows their mode (Text/Markdown/LaTeX/Code).
  if (p.mode && p.mode !== app.mode) setMode(p.mode);
  if (!p.file) return;
  if (collab.role === "guest") await openRemote(p.file, p.line);
  else if (p.file.startsWith("tab:")) {
    const id = p.file.slice(4);
    if (app.tabs.some((t) => t.id === id && !t.path)) activate(id);
    scrollToLine(p.line);
  } else if (app.root && (await guestPathOk(p.file))) {
    await openFile(joinPath(app.root, p.file));
    scrollToLine(p.line);
  }
}

const presenceOrder = new Map<string, number>();

/** The full state of a doc for one guest. `locked`: this guest's edits to it are refused. */
function docStateFor(peer: string, d: SharedDoc) {
  const tab = d.tabId ? app.tabs.find((x) => x.id === d.tabId) : null;
  return { t: "doc.state", path: d.rel, name: tab?.name ?? basename(d.rel), update: b64(Y.encodeStateAsUpdate(d.ydoc)), ...(hookLocked(peer, d.root, d.rel) ? { locked: true } : {}) };
}

const hookRefusals = new Map<string, number>();

/** Host: an edit to a git hook was dropped. The guest's copy goes back to the host's, read-only. */
async function refuseHookEdit(peer: string, d: SharedDoc) {
  const key = `${peer}\0${d.rel}`;
  const now = performance.now();
  if (now - (hookRefusals.get(key) ?? -Infinity) < 1000) return;
  hookRefusals.set(key, now);
  if (d.root) await refreshHookLocks(d.root, [d.rel]);
  if (!isApproved(peer) || !d.subscribers.has(peer) || docs.get(d.rel) !== d) return;
  const state = docStateFor(peer, d);
  if (fits(JSON.stringify(state))) send(peer, state);
}

const guestWithoutRun = () => collab.participants.some((p) => p.role === "guest" && !p.removing && !p.caps?.includes("run"));

/** Host: follows changes of the hooks folder for open docs while a guest without `run` is here. */
async function syncHookLocks() {
  const root = app.root;
  if (collab.role !== "host" || !root || !guestWithoutRun()) return;
  const rels = [...docs.values()].filter((d) => d.root === root).map((d) => d.rel);
  const changed = await refreshHookLocks(root, rels);
  for (const rel of changed) {
    const d = docs.get(rel);
    if (!d) continue;
    for (const peer of d.subscribers) {
      if (hasCapability(peer, "run")) continue;
      const state = docStateFor(peer, d);
      if (fits(JSON.stringify(state))) send(peer, state);
    }
  }
}
setInterval(() => void syncHookLocks(), 3000);

/** Host: a guest left. A presence message of theirs still being checked is dropped too. */
export function forgetPeer(peer: string) {
  presenceOrder.delete(peer);
  delete share.presence[peer];
  if (share.following === peer) share.following = null;
  for (const d of docs.values()) d.subscribers.delete(peer);
  docsChanged();
  forgetRpcPeer(peer);
}

/**
 * Host: a guest's presence with only values that are safe to store, pass on and follow, or null if
 * a newer message overtook it during the path check. Name and color are the ones the host assigned.
 */
async function cleanPresence(peer: string, msg: Record<string, unknown>) {
  const seq = (presenceOrder.get(peer) ?? 0) + 1;
  presenceOrder.set(peer, seq);
  const raw = msg.file;
  let file: string | null = null;
  if (typeof raw === "string" && raw) {
    if (raw.startsWith("tab:")) file = app.tabs.some((x) => x.id === raw.slice(4) && !x.path) ? raw : null;
    else file = (await guestPathOk(raw)) ? raw : null;
  }
  if (presenceOrder.get(peer) !== seq) return null;
  const who = collab.participants.find((x) => x.peer === peer);
  return {
    file,
    line: Number.isSafeInteger(msg.line) && (msg.line as number) >= 1 ? (msg.line as number) : 1,
    name: who?.name ?? t("ai.collab.guest"),
    color: who?.color ?? "#888888",
    mode: MODES.some((m) => m.id === msg.mode) ? (msg.mode as Mode) : undefined,
  };
}

// ------------------------------------------------------------------ messages

onCollabMessage(async (peer, msg) => {
  // --- host side
  if (collab.role === "host") {
    void syncSharedTabs(); // before any guest message can reach a tab that just left the project
    if (msg.t === "doc.open") {
      const d = await hostDoc(String(msg.path));
      // Removed while the file was being checked or read: nothing of it goes out.
      if (!isApproved(peer)) return;
      if (!d) return send(peer, { t: "doc.error", path: msg.path, error: "unavailable" });
      if (!hasCapability(peer, "run") && d.root) {
        await refreshHookLocks(d.root, [d.rel]);
        if (!isApproved(peer) || docs.get(d.rel) !== d) return;
      }
      const state = docStateFor(peer, d);
      // Over the transport's limit the whole connection would drop.
      if (!fits(JSON.stringify(state))) return send(peer, { t: "doc.error", path: msg.path, error: "too_large" });
      d.subscribers.add(peer);
      docsChanged();
      send(peer, state);
      const states = [...d.awareness.getStates().keys()];
      if (states.length) send(peer, { t: "aw", path: d.rel, update: b64(encodeAwarenessUpdate(d.awareness, states)) });
    } else if (msg.t === "doc.update") {
      // Only from guests that have this doc open: a late edit to a same-named file of the previous
      // folder must not land in this one.
      const d = hostDocAt(msg.path);
      if (d?.subscribers.has(peer) && hasCapability(peer, "edit")) {
        if (hookLocked(peer, d.root, d.rel)) return refuseHookEdit(peer, d);
        Y.applyUpdate(d.ydoc, unb64(msg.update), peer);
      }
    } else if (msg.t === "aw") {
      const d = hostDocAt(msg.path);
      if (d?.subscribers.has(peer)) applyAwarenessUpdate(d.awareness, unb64(msg.update), peer);
    } else if (msg.t === "doc.close") {
      hostDocAt(msg.path)?.subscribers.delete(peer);
      docsChanged();
    } else if (msg.t === "presence") {
      const info = await cleanPresence(peer, msg);
      if (!info) return;
      share.presence[peer] = info;
      broadcast({ t: "presence", peer, ...info }, peer);
      if (share.following === peer) applyFollow();
    } else if (msg.t === "hello-ready") {
      lastPresence = "";
      publishPresence();
    }
    return;
  }

  // --- guest side
  if (msg.t === "welcome") {
    send(collab.hostPeer!, { t: "hello-ready" });
  } else if (msg.t === "root") {
    share.hostRoot = msg.name;
  } else if (msg.t === "doc.state") {
    guestReceiveState(msg.path, unb64(msg.update), msg.name, msg.locked === true);
  } else if (msg.t === "doc.moved") {
    // The host renamed the file: the tab follows it (#127).
    const d = docs.get(msg.path);
    if (!d) return;
    docs.delete(msg.path);
    d.rel = msg.to;
    docs.set(msg.to, d);
    const sub = previewSubs.get(msg.path);
    if (sub) {
      previewSubs.delete(msg.path);
      sub.rel = msg.to;
      previewSubs.set(msg.to, sub);
    }
    const tab = d.tabId ? app.tabs.find((x) => x.id === d.tabId) : null;
    if (tab) Object.assign(tab, { path: REMOTE + msg.to, name: msg.name || basename(msg.to) });
  } else if (msg.t === "doc.gone" && (msg.reason === "deleted" || msg.reason === "folder")) {
    // The host deleted the file or left its folder: keep the text as an unsaved local tab instead
    // of editing into nothing (#134).
    dropPreview(msg.path);
    const d = docs.get(msg.path);
    if (!d) return;
    const tab = d.tabId ? app.tabs.find((x) => x.id === d.tabId) : null;
    if (tab) {
      ed.setCollab(tab.id, null);
      tab.path = null;
      tab.dirty = true;
      ui.toast(t(msg.reason === "folder" ? "ai.collab.folderChanged" : "ai.collab.fileDeleted", { name: tab.name }), "error");
    }
    dispose(d);
    docs.delete(msg.path);
  } else if (msg.t === "doc.gone") {
    dropPreview(msg.path);
    const d = docs.get(msg.path);
    if (d?.tabId) {
      const { closeTab } = await import("../state.svelte");
      ed.setCollab(d.tabId, null);
      await closeTab(d.tabId, true);
    } else if (d) {
      dispose(d);
      docs.delete(msg.path);
    }
  } else if (msg.t === "fs.changed") {
    share.treeGen++;
  } else if (msg.t === "doc.update") {
    const d = docs.get(msg.path);
    if (d) Y.applyUpdate(d.ydoc, unb64(msg.update), "remote");
  } else if (msg.t === "aw") {
    const d = docs.get(msg.path);
    if (d) applyAwarenessUpdate(d.awareness, unb64(msg.update), "remote");
  } else if (msg.t === "doc.error") {
    pendingOpens.delete(msg.path);
    previewRequests.delete(msg.path);
    dropPreview(msg.path);
    ui.toast(`${msg.path}: ${msg.error === "unavailable" ? t("ai.collab.fileUnavailable") : msg.error === "too_large" ? rpcErrorText("too_large") : msg.error}`, "error");
  } else if (msg.t === "participants") {
    // Someone left: their cursor label and follow target go too.
    const here = new Set((msg.participants as { peer: string }[]).map((p) => p.peer));
    for (const id of Object.keys(share.presence)) if (id !== "host" && !here.has(id)) delete share.presence[id];
    if (share.following && share.following !== "host" && !here.has(share.following)) share.following = null;
  } else if (msg.t === "presence") {
    const id = msg.peer ?? peer;
    share.presence[id] = { file: msg.file, line: msg.line, name: msg.name, color: msg.color, mode: msg.mode };
    if (share.following === id) applyFollow();
  }
});

// Guest: the host changed `edit`. Fresh copies drop edits it refused and switch the tabs read-only
// (or back), so nothing diverges.
onCapabilitiesChanged((before, now) => {
  if (before.includes("edit") === now.includes("edit") && before.includes("run") === now.includes("run")) return;
  for (const rel of docs.keys()) send(collab.hostPeer!, { t: "doc.open", path: rel });
});

/** Session ended: unbind host tabs, close guest tabs, drop all shared docs. */
export async function teardownShare() {
  const { closeTab } = await import("../state.svelte");
  previewRequests.clear();
  for (const rel of [...previewSubs.keys()]) dropPreview(rel);
  for (const d of docs.values()) {
    if (d.tabId) {
      ed.setCollab(d.tabId, null);
      const tab = app.tabs.find((t) => t.id === d.tabId);
      if (tab && isRemote(tab.path)) await closeTab(tab.id, true);
    }
    dispose(d);
  }
  docs.clear();
  renamed.clear();
  presenceOrder.clear();
  hookRefusals.clear();
  resetHookLocks();
  share.presence = {};
  share.following = null;
  share.hostRoot = "";
  share.hostHasRoot = true;
  share.hostTabs = [];
  lastPresence = "";
}

// Presence: publish on tab switches / cursor moves (throttled).
setInterval(publishPresence, 600);

collabHooks.openRemote = (path) => openRemote(path.slice(REMOTE.length));
collabHooks.tabOpened = (id, path) => onHostTabOpened(id, path);
collabHooks.tabClosed = (path, id) => (collab.role === "host" ? onHostTabClosed(id) : onTabClosed(path));
collabHooks.pathMoved = (from, to) => onHostPathMoved(from, to);

// Host: files changed on disk (new/deleted/renamed, git checkout …) → guests reload their tree,
// shared files without a host tab are reloaded (open tabs follow the disk via state.svelte.ts).
let fsTimer = 0;
onFilesChanged((files) => {
  if (files.some((f) => f.endsWith("/.git/config") || f.endsWith("/.gitconfig"))) void syncHookLocks();
  if (collab.role === "host" && app.root) {
    const changed = new Set(files);
    for (const d of docs.values()) if (!d.tabId && d.root && changed.has(joinPath(d.root, d.rel))) void hostReload(d);
  }
  if (collab.role !== "host" || collab.participants.length < 2) return;
  clearTimeout(fsTimer);
  fsTimer = window.setTimeout(() => broadcast({ t: "fs.changed" }), 300);
});

// Event listeners/intervals live at module level → full reload instead of duplicate HMR instances.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
