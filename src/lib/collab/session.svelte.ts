/**
 * Session-level sync on top of the shared documents (share.svelte.ts):
 *  - The host announces its workspace: folder name, mode, open tabs (incl. unsaved ones), active tab
 *    and project type. It re-sends whenever one of those changes.
 *  - A guest that joins puts its own workspace aside (folder, tabs, mode – remembered, also across a
 *    crash) and shows exactly what the host has open. Leaving restores it.
 *  - Run/Build/Test on a guest run on the host's machine; the host's Run terminal is mirrored to the
 *    guests read-only. (Forwarding guest keystrokes would land in the host's shell whenever no
 *    program runs – that would hand out a remote shell, so it isn't done.)
 */
import { listen } from "@tauri-apps/api/event";
import { collab, send, broadcast, onCollabMessage, sessionEndHooks } from "./collab.svelte";
import { share, hostKey, openRemote, isRemote } from "./share.svelte";
import { app, activeTab, activate, closeTab, flushAutosave, newFile, openFile, setMode, setRoot } from "../state.svelte";
import { runner, runAction, refreshProject, runnerRemote } from "../code/runner.svelte";
import type { Action, Project } from "../code/projects";
import { remoteTerminal, writeTerminal, runTerminalId, closeTerminal, terms } from "../terminal.svelte";
import { showView } from "../layout.svelte";
import * as ed from "../editor";
import { fsApi, basename } from "../api";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";
import type { Mode } from "../modes";

interface ActionInfo {
  id: string;
  label: string;
}
interface ProjectInfo {
  kind: string;
  label: string;
  run: ActionInfo | null;
  build: ActionInfo | null;
  test: ActionInfo | null;
  more: ActionInfo[];
}
interface SessionInfo {
  root: string | null;
  mode: Mode;
  tabs: { key: string; name: string }[];
  active: string | null;
  project: ProjectInfo | null;
}

const info = (a: Action | null | undefined): ActionInfo | null => (a?.cmd ? { id: a.id, label: a.label } : null);

// ------------------------------------------------------------------ host

function hostSession(): SessionInfo {
  const p = runner.project;
  const tabs = app.tabs.filter((tab) => !isRemote(tab.path)).map((tab) => ({ key: hostKey(tab), name: tab.name }));
  const a = activeTab();
  return {
    root: app.root ? basename(app.root) : null,
    mode: app.mode,
    tabs,
    active: a && !isRemote(a.path) ? hostKey(a) : null,
    project: p
      ? {
          kind: p.kind,
          label: p.label,
          run: info(p.run),
          build: info(p.build),
          test: info(p.test),
          // Actions that ask for input (e.g. "add package") would prompt on the host's screen.
          more: p.more.filter((m) => !m.ask).map(info).filter((m): m is ActionInfo => !!m),
        }
      : null,
  };
}

let lastSent = "";
let sendTimer = 0;
function announce(force = false) {
  if (collab.role !== "host") return;
  const s = hostSession();
  const json = JSON.stringify(s);
  if (!force && json === lastSent) return;
  lastSent = json;
  broadcast({ t: "session", ...s });
}

// Re-announce when the workspace changes (tabs, folder, mode, project).
$effect.root(() => {
  $effect(() => {
    if (collab.role !== "host") return;
    // Reactive reads: tab list/names, active tab, folder, mode, project.
    void app.tabs.map((tab) => tab.id + tab.name + tab.path).join();
    void app.activeId;
    void app.root;
    void app.mode;
    void runner.project;
    clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => announce(), 150);
  });
});

function findAction(id: string): Action | null {
  const p = runner.project;
  if (!p) return null;
  return [p.run, p.build, p.test, ...p.more].find((a) => a?.id === id && !a.ask) ?? null;
}

// Host's Run terminal → guests. Output is batched a little to keep message counts low.
let outBuf = "";
let outTimer = 0;
listen<{ id: string; data: string }>("pty-data", (e) => {
  if (collab.role !== "host" || collab.participants.length < 2 || e.payload.id !== runTerminalId()) return;
  queueOut(e.payload.data);
});
function queueOut(b64: string) {
  outBuf += b64 + "|";
  if (!outTimer)
    outTimer = window.setTimeout(() => {
      broadcast({ t: "term.data", chunks: outBuf.slice(0, -1).split("|") });
      outBuf = "";
      outTimer = 0;
    }, 30);
}

// ------------------------------------------------------------------ guest

interface Snapshot {
  root: string | null;
  mode: Mode;
  active: string | null;
  tabs: { path: string | null; name: string; content?: string }[];
}
const SNAP_KEY = "collab.guestSnapshot";
let joined = false;
let hostProject: ProjectInfo | null = null;
let remoteTermId: string | null = null;

/** Puts the guest's own workspace aside before showing the host's. */
async function stashOwnWorkspace() {
  await flushAutosave();
  const snap: Snapshot = { root: app.root, mode: app.mode, active: activeTab()?.path ?? null, tabs: [] };
  for (const tab of [...app.tabs]) {
    if (isRemote(tab.path)) continue;
    // Files on disk are autosaved; unsaved "Untitled" tabs keep their text in the snapshot.
    snap.tabs.push(tab.path ? { path: tab.path, name: tab.name } : { path: null, name: tab.name, content: ed.getText(tab.id) });
  }
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch {}
  for (const tab of [...app.tabs]) if (!isRemote(tab.path)) await closeTab(tab.id, true);
  setRoot(null);
}

/** Brings back the workspace from before joining (also after a crash during a session). */
async function restoreOwnWorkspace() {
  let snap: Snapshot | null = null;
  try {
    snap = JSON.parse(localStorage.getItem(SNAP_KEY) || "null");
  } catch {}
  localStorage.removeItem(SNAP_KEY);
  if (!snap) return;
  setRoot(snap.root);
  setMode(snap.mode);
  for (const tab of snap.tabs) {
    if (tab.path) {
      if (await fsApi.exists(tab.path)) await openFile(tab.path);
    } else if (tab.content) {
      newFile();
      const id = app.activeId!;
      ed.replaceDocText(id, tab.content);
      const t = app.tabs.find((x) => x.id === id);
      if (t) Object.assign(t, { name: tab.name, dirty: true });
    }
  }
  const active = snap.active && app.tabs.find((x) => x.path === snap!.active);
  if (active) activate(active.id);
  refreshProject();
}

function guestProject(): Project | null {
  const p = hostProject;
  if (!p) return null;
  // Commands are placeholders: actions run on the host (runnerRemote.run).
  const act = (a: ActionInfo | null) => (a ? { id: a.id, label: a.label, cmd: t("ai.collab.onHost") } : null);
  return {
    kind: p.kind as Project["kind"],
    root: "collab:",
    label: p.label,
    run: act(p.run),
    build: act(p.build),
    test: act(p.test),
    more: p.more.map((m) => act(m)!),
    needs: [],
  };
}

function ensureRemoteTerminal() {
  if (remoteTermId && terms.tabs.some((x) => x.id === remoteTermId)) return remoteTermId;
  let hinted = false;
  remoteTermId = remoteTerminal(t("ai.collab.hostRun", { name: share.hostRoot || t("app.project") }), () => {
    if (!hinted) ui.toast(t("ai.collab.termReadOnly"));
    hinted = true;
  });
  return remoteTermId;
}

const decoder = new TextDecoder();

async function applySession(s: SessionInfo) {
  share.hostRoot = s.root ?? t("ai.collab.noFolder");
  share.hostHasRoot = !!s.root;
  share.hostTabs = s.tabs;
  hostProject = s.project;
  if (!joined) {
    // First announcement after joining: replace the own workspace with the host's.
    joined = true;
    await stashOwnWorkspace();
    runnerRemote.project = guestProject;
    runnerRemote.run = (a) => {
      ensureRemoteTerminal();
      showView("terminal");
      terms.active = remoteTermId;
      send(collab.hostPeer!, { t: "run", action: a.id });
    };
    setMode(s.mode);
    for (const tab of s.tabs) if (tab.key !== s.active) await openRemote(tab.key);
    if (s.active) await openRemote(s.active);
  } else {
    share.treeGen++;
  }
  refreshProject();
}

// ------------------------------------------------------------------ messages

onCollabMessage((peer, msg) => {
  if (collab.role === "host") {
    if (msg.t === "hello-ready") {
      lastSent = "";
      // Send the full session to everybody (cheap) so the new guest gets it.
      announce(true);
    } else if (msg.t === "run") {
      const a = findAction(String(msg.action));
      const who = collab.participants.find((p) => p.peer === peer)?.name ?? t("ai.collab.guest");
      if (!a) return;
      ui.toast(t("ai.collab.guestRuns", { name: who, action: a.label }));
      runAction(a);
    }
    return;
  }
  if (collab.role !== "guest") return;
  if (msg.t === "session") applySession(msg as unknown as SessionInfo);
  else if (msg.t === "term.data") {
    const id = ensureRemoteTerminal();
    for (const c of msg.chunks as string[]) writeTerminal(id, decoder.decode(Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)), { stream: true }));
  }
});

sessionEndHooks.push(async (wasGuest) => {
  lastSent = "";
  if (!wasGuest) return;
  joined = false;
  hostProject = null;
  runnerRemote.project = null;
  runnerRemote.run = null;
  if (remoteTermId) closeTerminal(remoteTermId);
  remoteTermId = null;
  await restoreOwnWorkspace();
});

// A session that ended by a crash/quit left the own workspace stashed: bring it back on start.
if (localStorage.getItem(SNAP_KEY)) setTimeout(() => !collab.role && restoreOwnWorkspace(), 800);

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
