/**
 * Shared editing on top of the session (collab.svelte.ts):
 *  - Host owns the files. Each shared file is a Y.Doc; edits from everybody merge there and the
 *    host saves to disk (via its normal autosave for open tabs, or directly for background docs).
 *  - Guests open files as virtual tabs "collab:<relative path>" bound to their copy of the Y.Doc.
 *  - Remote cursors via Yjs awareness (y-codemirror.next), presence messages drive "follow mode".
 */
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { collab, send, broadcast, onCollabMessage } from "./collab.svelte";
import { app, openFile, activeTab, activate, collabHooks, setMode, type Tab } from "../state.svelte";
import type { Mode } from "../modes";
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
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  undo: Y.UndoManager;
  tabId: string | null;
  /** Host: guests that opened this doc. */
  subscribers: Set<string>;
  writeTimer?: number;
  /** Host, background docs: the file content as last read or written, to notice outside changes. */
  disk?: string;
  cleanup: (() => void)[];
}

const docs = new Map<string, SharedDoc>();
/** Host: old key → new key of renamed docs, for guest messages still sent under the old name. */
const renamed = new Map<string, string>();
const hostDocAt = (path: string) => docs.get(path) ?? docs.get(renamed.get(path) ?? "");

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

function makeDoc(rel: string, isHost: boolean): SharedDoc {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", { name: collab.me.name, color: collab.me.color, colorLight: lighten(collab.me.color) });
  // Undo only covers edits made in this editor (yCollab adds its origin when bound): not the
  // initial load of the text (origin null), which would otherwise be the first undo step (#126).
  const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set() });
  const d: SharedDoc = { rel, ydoc, ytext, awareness, undo, tabId: null, subscribers: new Set(), cleanup: [] };

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
    if (typeof tr.origin !== "string") return;
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
    if (changes.length) ed.applyChanges(d.tabId, { changes: ChangeSet.of(changes, ed.getText(d.tabId).length) });
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

/** yCollab + undo actions for one tab. */
function binding(d: SharedDoc) {
  return [
    yCollab(d.ytext, d.awareness, { undoManager: d.undo }),
    viewActions.of({
      "collab.undo": () => (d.undo.undo(), true),
      "collab.redo": () => (d.undo.redo(), true),
    }),
  ];
}

const relOf = (abs: string) => (app.root && abs.startsWith(app.root + "/") ? abs.slice(app.root.length + 1) : null);

/**
 * Host: the key a tab is shared under. Files in the project folder use their relative path (so the
 * guest's file tree finds them); everything else – unsaved "Untitled" tabs, files outside the
 * folder, or no folder open at all – is shared by tab id ("tab:<id>").
 */
export const hostKey = (tab: Tab) => (tab.path && relOf(tab.path)) || `tab:${tab.id}`;

// ------------------------------------------------------------------ host

function scheduleHostWrite(d: SharedDoc) {
  // Open tabs are saved by the host's autosave; background docs are written here.
  if (d.tabId || !app.root) return;
  clearTimeout(d.writeTimer);
  d.writeTimer = window.setTimeout(() => void hostWrite(d), 700);
}

async function hostWrite(d: SharedDoc) {
  if (d.tabId || !app.root) return;
  const abs = joinPath(app.root, d.rel);
  const text = d.ytext.toString();
  if (text === d.disk) return;
  // The file changed outside Omega and the watcher hasn't told us yet: take that change instead of
  // overwriting it (#128).
  const now = await fsApi.readFile(abs).catch(() => undefined);
  if (now !== undefined && d.disk !== undefined && now !== d.disk) return applyDisk(d, now);
  // Deleted meanwhile: don't bring the file back (#134).
  if (now === undefined && d.disk !== undefined && !(await fsApi.exists(abs).catch(() => true))) return hostFileGone(d);
  const before = d.disk;
  d.disk = text;
  await fsApi.writeFile(abs, text).catch(() => (d.disk = before));
}

/** Host: a background doc's file changed on disk → everybody gets the new content. */
async function hostReload(d: SharedDoc) {
  if (d.tabId || !app.root) return;
  const abs = joinPath(app.root, d.rel);
  const text = await fsApi.readFile(abs).catch(() => undefined);
  if (d.tabId || docs.get(d.rel) !== d) return;
  if (text !== undefined) applyDisk(d, text);
  else if (!(await fsApi.exists(abs).catch(() => true))) hostFileGone(d); // deleted outside Omega
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

async function hostDoc(rel: string): Promise<SharedDoc | null> {
  const existing = docs.get(rel);
  if (existing) return existing;
  if (rel.startsWith("tab:")) {
    const tab = app.tabs.find((t) => t.id === rel.slice(4));
    if (!tab || isRemote(tab.path)) return null;
    const d = makeDoc(rel, true);
    d.ytext.insert(0, ed.getText(tab.id));
    bindHostTab(d, tab.id);
    return d;
  }
  if (!app.root || rel.includes("..")) return null;
  const abs = joinPath(app.root, rel);
  const tab = app.tabs.find((t) => t.path === abs);
  let text: string;
  try {
    text = tab ? ed.getText(tab.id) : await fsApi.readFile(abs);
  } catch {
    return null;
  }
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
      d.cleanup.forEach((f) => f());
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
  d.cleanup.forEach((f) => f());
  docs.delete(d.rel);
}

/** Host: a file or folder was deleted (`to` null) or renamed in the explorer. */
function onHostPathMoved(from: string, to: string | null) {
  if (collab.role !== "host") return;
  const rel = relOf(from);
  if (!rel) return;
  for (const d of [...docs.values()]) {
    if (d.rel !== rel && !d.rel.startsWith(rel + "/")) continue;
    const dest = to === null ? null : relOf(to + d.rel.slice(rel.length));
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
}

/** Host opened a file that is already shared → bind it. */
export function onHostTabOpened(tabId: string, abs: string) {
  if (collab.role !== "host") return;
  const rel = relOf(abs);
  const d = rel ? docs.get(rel) : null;
  if (d && !d.tabId) bindHostTab(d, tabId);
}

// ------------------------------------------------------------------ guest

const pendingOpens = new Map<string, { line?: number }>();

/** Guest: open a host file (relative path) as a shared tab. */
export async function openRemote(rel: string, line?: number) {
  const existing = docs.get(rel);
  if (existing?.tabId && app.tabs.some((t) => t.id === existing.tabId)) {
    const { activate } = await import("../state.svelte");
    activate(existing.tabId);
    if (line) scrollToLine(line);
    return;
  }
  pendingOpens.set(rel, { line });
  send(collab.hostPeer!, { t: "doc.open", path: rel });
}

function scrollToLine(line: number) {
  const v = ed.getView();
  if (!v || line < 1) return;
  const l = v.state.doc.line(Math.min(line, v.state.doc.lines));
  v.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
}

async function guestReceiveState(rel: string, update: Uint8Array, name?: string) {
  docs.get(rel)?.cleanup.forEach((f) => f());
  const d = makeDoc(rel, false);
  Y.applyUpdate(d.ydoc, update, "remote");
  const { openVirtual } = await import("../state.svelte");
  const tabId = openVirtual(REMOTE + rel, name || basename(rel), d.ytext.toString());
  d.tabId = tabId;
  ed.setCollab(tabId, binding(d));
  const p = pendingOpens.get(rel);
  pendingOpens.delete(rel);
  if (p?.line) setTimeout(() => scrollToLine(p.line!), 50);
}

/** Guest closed a shared tab. */
export function onTabClosed(path: string | null) {
  if (!isRemote(path) || collab.role !== "guest") return;
  const rel = path!.slice(REMOTE.length);
  const d = docs.get(rel);
  if (!d) return;
  send(collab.hostPeer!, { t: "doc.close", path: rel });
  d.cleanup.forEach((f) => f());
  docs.delete(rel);
}

// ------------------------------------------------------------------ remote file tree (guest)

let reqSeq = 0;
const listWaiters = new Map<number, (e: { name: string; rel: string; is_dir: boolean }[]) => void>();

export function listRemote(rel: string): Promise<{ name: string; rel: string; is_dir: boolean }[]> {
  const req = ++reqSeq;
  return new Promise((resolve) => {
    listWaiters.set(req, resolve);
    send(collab.hostPeer!, { t: "fs.list", path: rel, req });
    setTimeout(() => listWaiters.delete(req) && resolve([]), 8000);
  });
}

// ------------------------------------------------------------------ presence & follow

let lastPresence = "";
export function publishPresence() {
  if (!collab.role || (collab.role === "guest" && collab.status !== "connected")) return;
  const tab = activeTab();
  const v = ed.getView();
  const file = tab ? (isRemote(tab.path) ? tab.path!.slice(REMOTE.length) : collab.role === "host" ? hostKey(tab) : null) : null;
  const line = v && tab ? v.state.doc.lineAt(v.state.selection.main.head).number : 1;
  const key = `${file}:${line}:${app.mode}`;
  if (key === lastPresence) return;
  lastPresence = key;
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
    if (app.tabs.some((t) => t.id === id)) activate(id);
    scrollToLine(p.line);
  } else if (app.root) {
    await openFile(joinPath(app.root, p.file));
    scrollToLine(p.line);
  }
}

// ------------------------------------------------------------------ messages

onCollabMessage(async (peer, msg) => {
  // --- host side
  if (collab.role === "host") {
    if (msg.t === "doc.open") {
      const d = await hostDoc(String(msg.path));
      if (!d) return send(peer, { t: "doc.error", path: msg.path, error: "unavailable" });
      d.subscribers.add(peer);
      const tab = d.tabId ? app.tabs.find((t) => t.id === d.tabId) : null;
      send(peer, { t: "doc.state", path: d.rel, name: tab?.name ?? basename(d.rel), update: b64(Y.encodeStateAsUpdate(d.ydoc)) });
      const states = [...d.awareness.getStates().keys()];
      if (states.length) send(peer, { t: "aw", path: d.rel, update: b64(encodeAwarenessUpdate(d.awareness, states)) });
    } else if (msg.t === "doc.update") {
      const d = hostDocAt(msg.path);
      if (d) Y.applyUpdate(d.ydoc, unb64(msg.update), peer);
    } else if (msg.t === "aw") {
      const d = hostDocAt(msg.path);
      if (d) applyAwarenessUpdate(d.awareness, unb64(msg.update), peer);
    } else if (msg.t === "doc.close") {
      hostDocAt(msg.path)?.subscribers.delete(peer);
    } else if (msg.t === "fs.list") {
      const rel = String(msg.path || "");
      let entries: { name: string; rel: string; is_dir: boolean }[] = [];
      if (app.root && !rel.includes("..")) {
        try {
          entries = (await fsApi.listDir(rel ? joinPath(app.root, rel) : app.root)).map((e) => ({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, is_dir: e.is_dir }));
        } catch {
          /* ignore */
        }
      }
      send(peer, { t: "fs.list.res", req: msg.req, entries });
    } else if (msg.t === "presence") {
      const info = { file: msg.file, line: msg.line, name: msg.name, color: msg.color, mode: msg.mode };
      share.presence[peer] = info;
      broadcast({ ...msg, peer }, peer);
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
    guestReceiveState(msg.path, unb64(msg.update), msg.name);
  } else if (msg.t === "doc.moved") {
    // The host renamed the file: the tab follows it (#127).
    const d = docs.get(msg.path);
    if (!d) return;
    docs.delete(msg.path);
    d.rel = msg.to;
    docs.set(msg.to, d);
    const tab = d.tabId ? app.tabs.find((x) => x.id === d.tabId) : null;
    if (tab) Object.assign(tab, { path: REMOTE + msg.to, name: msg.name || basename(msg.to) });
  } else if (msg.t === "doc.gone" && msg.reason === "deleted") {
    // The host deleted the file: keep the text as an unsaved local tab instead of editing into
    // nothing (#134).
    const d = docs.get(msg.path);
    if (!d) return;
    const tab = d.tabId ? app.tabs.find((x) => x.id === d.tabId) : null;
    if (tab) {
      ed.setCollab(tab.id, null);
      tab.path = null;
      tab.dirty = true;
      ui.toast(t("ai.collab.fileDeleted", { name: tab.name }), "error");
    }
    d.cleanup.forEach((f) => f());
    docs.delete(msg.path);
  } else if (msg.t === "doc.gone") {
    const d = docs.get(msg.path);
    if (d?.tabId) {
      const { closeTab } = await import("../state.svelte");
      ed.setCollab(d.tabId, null);
      await closeTab(d.tabId, true);
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
    ui.toast(`${msg.path}: ${msg.error === "unavailable" ? t("ai.collab.fileUnavailable") : msg.error}`, "error");
  } else if (msg.t === "fs.list.res") {
    listWaiters.get(msg.req)?.(msg.entries);
    listWaiters.delete(msg.req);
  } else if (msg.t === "presence") {
    const id = msg.peer ?? peer;
    share.presence[id] = { file: msg.file, line: msg.line, name: msg.name, color: msg.color, mode: msg.mode };
    if (share.following === id) applyFollow();
  }
});

/** Session ended: unbind host tabs, close guest tabs, drop all shared docs. */
export async function teardownShare() {
  const { closeTab } = await import("../state.svelte");
  for (const d of docs.values()) {
    if (d.tabId) {
      ed.setCollab(d.tabId, null);
      const tab = app.tabs.find((t) => t.id === d.tabId);
      if (tab && isRemote(tab.path)) await closeTab(tab.id, true);
    }
    d.cleanup.forEach((f) => f());
  }
  docs.clear();
  renamed.clear();
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
  if (collab.role === "host" && app.root) {
    const changed = new Set(files);
    for (const d of docs.values()) if (!d.tabId && changed.has(joinPath(app.root, d.rel))) void hostReload(d);
  }
  if (collab.role !== "host" || collab.participants.length < 2) return;
  clearTimeout(fsTimer);
  fsTimer = window.setTimeout(() => broadcast({ t: "fs.changed" }), 300);
});

// Event listeners/intervals live at module level → full reload instead of duplicate HMR instances.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
