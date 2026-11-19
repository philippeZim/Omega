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
import { app, openFile, activeTab, collabHooks } from "../state.svelte";
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
  cleanup: (() => void)[];
}

const docs = new Map<string, SharedDoc>();

export const share = $state({
  /** Host project name (guest side). */
  hostRoot: "",
  /** peer -> {file, line} presence of everyone (incl. "host"). */
  presence: {} as Record<string, { file: string | null; line: number; name: string; color: string }>,
  following: null as string | null,
});

const lighten = (hex: string) => hex + "33";

function makeDoc(rel: string, isHost: boolean): SharedDoc {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", { name: collab.me.name, color: collab.me.color, colorLight: lighten(collab.me.color) });
  const undo = new Y.UndoManager(ytext);
  const d: SharedDoc = { rel, ydoc, ytext, awareness, undo, tabId: null, subscribers: new Set(), cleanup: [] };

  // Local Yjs changes → network. Origin = peer id for remote updates, so they aren't echoed back.
  const onUpdate = (update: Uint8Array, origin: unknown) => {
    const msg = { t: "doc.update", path: rel, update: b64(update) };
    if (isHost) {
      for (const p of d.subscribers) if (p !== origin) send(p, msg);
      scheduleHostWrite(d);
    } else if (origin !== "remote") send(collab.hostPeer!, msg);
  };
  ydoc.on("update", onUpdate);

  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = added.concat(updated, removed);
    const msg = { t: "aw", path: rel, update: b64(encodeAwarenessUpdate(awareness, changed)) };
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

// ------------------------------------------------------------------ host

function scheduleHostWrite(d: SharedDoc) {
  // Open tabs are saved by the host's autosave; background docs are written here.
  if (d.tabId || !app.root) return;
  clearTimeout(d.writeTimer);
  d.writeTimer = window.setTimeout(() => fsApi.writeFile(joinPath(app.root!, d.rel), d.ytext.toString()).catch(() => {}), 700);
}

async function hostDoc(rel: string): Promise<SharedDoc | null> {
  const existing = docs.get(rel);
  if (existing) return existing;
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
  return d;
}

function bindHostTab(d: SharedDoc, tabId: string) {
  // The editor content must equal the Y.Text when binding.
  if (ed.getText(tabId) !== d.ytext.toString()) ed.replaceDocText(tabId, d.ytext.toString());
  d.tabId = tabId;
  ed.setCollab(tabId, binding(d));
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

async function guestReceiveState(rel: string, update: Uint8Array) {
  docs.get(rel)?.cleanup.forEach((f) => f());
  const d = makeDoc(rel, false);
  Y.applyUpdate(d.ydoc, update, "remote");
  const { openVirtual } = await import("../state.svelte");
  const tabId = openVirtual(REMOTE + rel, basename(rel), d.ytext.toString());
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
  const file = tab?.path ? (isRemote(tab.path) ? tab.path.slice(REMOTE.length) : relOf(tab.path)) : null;
  const line = v && tab ? v.state.doc.lineAt(v.state.selection.main.head).number : 1;
  const key = `${file}:${line}`;
  if (key === lastPresence) return;
  lastPresence = key;
  const msg = { t: "presence", peer: collab.role === "host" ? "host" : null, file, line, name: collab.me.name, color: collab.me.color };
  if (collab.role === "host") broadcast(msg);
  else send(collab.hostPeer!, msg);
}

export function follow(peer: string | null) {
  share.following = share.following === peer ? null : peer;
  if (share.following) applyFollow();
}

async function applyFollow() {
  const p = share.following ? share.presence[share.following] : null;
  if (!p?.file) return;
  if (collab.role === "guest") await openRemote(p.file, p.line);
  else if (app.root) {
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
      send(peer, { t: "doc.state", path: d.rel, update: b64(Y.encodeStateAsUpdate(d.ydoc)) });
      const states = [...d.awareness.getStates().keys()];
      if (states.length) send(peer, { t: "aw", path: d.rel, update: b64(encodeAwarenessUpdate(d.awareness, states)) });
    } else if (msg.t === "doc.update") {
      const d = docs.get(msg.path);
      if (d) Y.applyUpdate(d.ydoc, unb64(msg.update), peer);
    } else if (msg.t === "aw") {
      const d = docs.get(msg.path);
      if (d) applyAwarenessUpdate(d.awareness, unb64(msg.update), peer);
    } else if (msg.t === "doc.close") {
      docs.get(msg.path)?.subscribers.delete(peer);
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
      const info = { file: msg.file, line: msg.line, name: msg.name, color: msg.color };
      share.presence[peer] = info;
      broadcast({ ...msg, peer }, peer);
      if (share.following === peer) applyFollow();
    } else if (msg.t === "hello-ready") {
      send(peer, { t: "root", name: app.root ? basename(app.root) : t("ai.collab.project") });
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
    guestReceiveState(msg.path, unb64(msg.update));
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
    share.presence[id] = { file: msg.file, line: msg.line, name: msg.name, color: msg.color };
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
  share.presence = {};
  share.following = null;
  share.hostRoot = "";
  lastPresence = "";
}

// Presence: publish on tab switches / cursor moves (throttled).
setInterval(publishPresence, 600);

collabHooks.openRemote = (path) => openRemote(path.slice(REMOTE.length));
collabHooks.tabOpened = (id, path) => onHostTabOpened(id, path);
collabHooks.tabClosed = (path) => onTabClosed(path);

// Event listeners/intervals live at module level → full reload instead of duplicate HMR instances.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
