/**
 * Session-level sync on top of the shared documents (share.svelte.ts):
 *  - The host announces its workspace: folder name, mode, open tabs (incl. unsaved ones), active tab
 *    and project type. It re-sends whenever one of those changes.
 *  - A guest that joins puts its own workspace aside (folder, tabs, mode – remembered, also across a
 *    crash) and shows exactly what the host has open. Leaving restores it.
 *  - Run/Build/Test on a guest run on the host's machine; the host's Run terminal is mirrored to the
 *    guests. Typing reaches only the running program, see runInput.svelte.ts.
 */
import { untrack } from "svelte";
import { listen } from "@tauri-apps/api/event";
import { collab, broadcast, onCollabMessage, sessionEndHooks } from "./collab.svelte";
import { REMOTE, share, flushSharedDocs, guestDocClock, guestScope, hostDocHasClock, hostDocKeyFor, hostKeyChecked, sharedDocUnsaved, syncSharedTabs, openRemote, isRemote } from "./share.svelte";
import { blockedByCapability, guestCanStop } from "./guard";
import { noteGuestChange } from "./guestChanges";
import { termOut } from "./debugMirror";
import { call, hasCapability, isObj, publish, registerMethod, registerTopic, rpcErrorText, RpcFail, subscribe } from "./rpc.svelte";
import { app, activeTab, activate, closeTab, flushAutosave, newFile, openFile, setMode, setRoot } from "../state.svelte";
import { fileDependent, projectFor, runner, runAction, runGuestAction, refreshProject, runnerRemote, saveForGuestRun } from "../code/runner.svelte";
import type { Action, Project } from "../code/projects";
import { packageAction, PACKAGE_LIMITS, quotePackageArg, splitPackages, validPackages } from "../code/packageInput";
import { pythonRemoveFlags, type Suggestion } from "../code/packages";
import { remoteTerminal, writeTerminal, closeTerminal, terms, isTaskPty, setRunEcho, interruptTask, runningPackageTask, taskState, type TaskState } from "../terminal.svelte";
import { typeIntoHostRun } from "./runInput.svelte";
import { showView } from "../layout.svelte";
import * as ed from "../editor";
import { fsApi, basename } from "../api";
import { quotablePath } from "../platform";
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

/** What guests get to see: tabs outside the project are left out entirely. */
async function hostSession(): Promise<SessionInfo> {
  const p = runner.project;
  const listed = await Promise.all(app.tabs.filter((tab) => !isRemote(tab.path)).map(async (tab) => ({ key: await hostKeyChecked(tab), name: tab.name })));
  const tabs = listed.filter((tab): tab is { key: string; name: string } => tab.key !== null);
  const a = activeTab();
  const active = a && !isRemote(a.path) ? await hostKeyChecked(a) : null;
  return {
    root: app.root ? basename(app.root) : null,
    mode: app.mode,
    tabs,
    active,
    project: p
      ? {
          kind: p.kind,
          label: p.label,
          run: info(p.run),
          build: info(p.build),
          test: info(p.test),
          // Actions that ask for input only go out as package actions: the guest prompts for those.
          more: p.more.filter((m) => !m.ask || packageAction(p.kind, m.id)).map(info).filter((m): m is ActionInfo => !!m),
        }
      : null,
  };
}

let lastSent = "";
let sendTimer = 0;
let announceSeq = 0;
async function announce(force = false) {
  if (collab.role !== "host") return;
  const seq = ++announceSeq;
  const s = await hostSession();
  if (seq !== announceSeq || collab.role !== "host") return; // a newer announcement is on its way
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
    void syncSharedTabs();
    clearTimeout(sendTimer);
    sendTimer = window.setTimeout(() => announce(), 150);
  });
});

const guestName = (peer: string) => collab.participants.find((p) => p.peer === peer)?.name ?? t("ai.collab.guest");

const actionIn = (p: Project | null, id: string): Action | null => (p && [p.run, p.build, p.test, ...p.more].find((a) => a?.id === id && !a.ask && a.cmd)) || null;

function findAction(id: string): Action | null {
  const p = runner.project;
  if (!p) return null;
  return [p.run, p.build, p.test, ...p.more].find((a) => a?.id === id && !a.ask) ?? null;
}

/** How long the host waits for a guest's last edit, which can arrive just after its Run. */
const EDIT_WAIT_MS = 2000;

async function editArrived(rel: string, client: number, clock: number, signal: AbortSignal) {
  for (const end = Date.now() + EDIT_WAIT_MS; !hostDocHasClock(rel, client, clock); await new Promise((r) => setTimeout(r, 25))) {
    if (signal.aborted || Date.now() > end) return false;
  }
  return true;
}

interface GuestRun {
  file?: string;
  client?: number;
  clock?: number;
}

/**
 * Host: a guest's action for the file the guest has open. The path must be a shared file this guest
 * has open and survive quoting. Its shared text is on disk before the project is detected, because
 * detection reads the file. Refuses rather than fall back to the host's active file.
 */
async function resolveForGuestFile(id: string, { file, client, clock }: GuestRun & { file: string }, peer: string, signal: AbortSignal) {
  const scope = guestScope();
  const key = hostDocKeyFor(file, peer);
  if (!scope || !key || !quotablePath(key) || !(await scope.check(key))) throw new RpcFail("run_path_refused");
  if (client !== undefined && hasCapability(peer, "edit") && !(await editArrived(key, client, clock!, signal))) throw new RpcFail("run_not_saved");
  const abs = scope.abs(key);
  const saved = await saveForGuestRun(abs);
  await flushSharedDocs();
  if (signal.aborted) throw new RpcFail("cancelled");
  if (!scope.live() || hostDocKeyFor(key, peer) !== key) throw new RpcFail("run_path_refused");
  if (!saved || sharedDocUnsaved(key)) throw new RpcFail("run_not_saved");
  const project = await projectFor(abs, scope.root);
  // Last check before the path goes into a command: a folder may have become a symlink meanwhile.
  if (signal.aborted) throw new RpcFail("cancelled");
  if (!scope.live() || !(await scope.check(key))) throw new RpcFail("run_path_refused");
  const action = actionIn(project, id);
  if (!project || !action) throw new RpcFail("run_no_action");
  return { action, project, file: abs };
}

/** Host: a file-bound action for a guest without a file: what the project runs on its own, if anything. */
async function resolveWithoutFile(id: string, root: string, signal: AbortSignal) {
  await saveForGuestRun(null);
  await flushSharedDocs();
  if (signal.aborted) throw new RpcFail("cancelled");
  const project = await projectFor(null, root);
  if (signal.aborted) throw new RpcFail("cancelled");
  const action = actionIn(project, id);
  if (!project || !action || action.cmd!.includes("{file}")) throw new RpcFail("run_needs_file");
  return { action, project, file: null };
}

declare module "./rpc.svelte" {
  interface RpcMethods {
    "run.start": { params: { action: string; file?: string; client?: number; clock?: number }; result: null };
    "run.stop": { params: { taskId: number }; result: { stopped: boolean } };
    "packages.run": { params: { action: string; packages: string[] }; result: null };
    "packages.suggest": { params: { action: string; query: string }; result: Suggestion[] };
  }
  interface RpcTopics {
    "run.state": TaskState;
  }
}

const isShortString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

registerMethod({
  name: "run.start",
  capability: "run",
  validate: (raw) => {
    if (!isObj(raw) || typeof raw.action !== "string") return null;
    if (raw.file === undefined) return { action: raw.action };
    if (!isShortString(raw.file, 4096)) return null;
    if (raw.client === undefined && raw.clock === undefined) return { action: raw.action, file: raw.file };
    if (!Number.isSafeInteger(raw.client) || !Number.isSafeInteger(raw.clock)) return null;
    return { action: raw.action, file: raw.file, client: raw.client as number, clock: raw.clock as number };
  },
  handle: async ({ action, file, client, clock }, { peer, signal }) => {
    const known = file === undefined ? findAction(action) : null;
    if (file === undefined && !known) throw new RpcFail("unavailable");
    // Actions that don't follow a file run as they are; the others never use the host's active file.
    const target =
      file !== undefined
        ? await resolveForGuestFile(action, { file, client, clock }, peer, signal)
        : fileDependent(known!)
          ? await resolveWithoutFile(action, runner.project!.root, signal)
          : null;
    const a = target?.action ?? known!;
    const project = target?.project ?? runner.project!;
    if (packageAction(project.kind, a.id) && !hasCapability(peer, "packages")) throw new RpcFail("forbidden");
    // A package action changes project files. (`run` is required above, so this only counts if that
    // ever changes; packages.run is the path for guests without it.)
    if (packageAction(project.kind, a.id)) noteGuestChange(peer, app.root ?? project.root);
    ui.toast(t("ai.collab.guestRuns", { name: guestName(peer), action: a.label }));
    // Not awaited: it can wait for the host (missing tools), and the guest sees the run state anyway.
    void Promise.resolve(target ? runGuestAction(a, project, target.file) : runAction(a)).catch((e) => console.error("guest run", e));
    return null;
  },
});

registerMethod({
  name: "run.stop",
  capability: null, // `run` stops anything, `packages` only a package task: decided on the task itself
  validate: (raw) => (isObj(raw) && Number.isSafeInteger(raw.taskId) ? { taskId: raw.taskId as number } : null),
  handle: ({ taskId }, { peer }) => {
    if (!hasCapability(peer, "run") && (!hasCapability(peer, "packages") || runningPackageTask(taskId) === false)) throw new RpcFail("forbidden");
    return { stopped: interruptTask(taskId) };
  },
});

/** The current project's package action with this id. */
function findPackageAction(id: string) {
  const p = runner.project;
  const pkg = p && packageAction(p.kind, id);
  const action = pkg && p.more.find((m) => m.id === id && m.cmd);
  return p && pkg && action ? { project: p, pkg, action } : null;
}

registerMethod({
  name: "packages.run",
  capability: "packages",
  validate: (raw) => {
    if (!isObj(raw) || !isShortString(raw.action, 64) || !Array.isArray(raw.packages) || raw.packages.length > PACKAGE_LIMITS.count) return null;
    if (!raw.packages.every((x) => isShortString(x, PACKAGE_LIMITS.length))) return null;
    return { action: raw.action, packages: raw.packages as string[] };
  },
  handle: async ({ action, packages }, { peer, signal }) => {
    const found = findPackageAction(action);
    if (!found) throw new RpcFail("unavailable");
    const { project, pkg, action: a } = found;
    let arg: string | undefined;
    if (pkg.input) {
      if (!validPackages(project.kind, pkg.input, packages)) throw new RpcFail("invalid_package");
      const flags = project.kind === "uv" && pkg.input === "remove" ? await pythonRemoveFlags(project.root, packages) : [];
      if (!flags) throw new RpcFail("invalid_group");
      if (signal.aborted) throw new RpcFail("cancelled");
      if (runner.project?.root !== project.root || runner.project.kind !== project.kind) throw new RpcFail("unavailable");
      arg = [...flags, ...packages.map((x) => quotePackageArg(x))].join(" ");
    } else if (packages.length) throw new RpcFail("invalid_package");
    noteGuestChange(peer, app.root ?? project.root); // before the task can change project files
    const label = a.label.replace("…", "");
    ui.toast(packages.length ? t("ai.collab.guestPackages", { name: guestName(peer), action: label, packages: packages.join(", ") }) : t("ai.collab.guestRuns", { name: guestName(peer), action: label }));
    void Promise.resolve(runAction(a, arg)).catch((e) => console.error("guest packages", e));
    return null;
  },
});

registerMethod({
  name: "packages.suggest",
  capability: "packages",
  validate: (raw) => (isObj(raw) && isShortString(raw.action, 64) && isShortString(raw.query, 100) ? { action: raw.action, query: raw.query } : null),
  handle: async ({ action, query }) => {
    const a = findPackageAction(action)?.action;
    // The host looks this up in the public registries, so only text that could be a name goes out.
    if (!a?.suggest || !/^[\w@./-]*$/.test(query.trim())) return [];
    return (await a.suggest(query)).slice(0, 40).map(({ value, detail, tag }) => ({ value, detail, tag }));
  },
});

registerTopic({ name: "run.state", capability: null, snapshot: taskState });

// Everybody sees whether something runs, also guests who may not start or stop it.
$effect.root(() => {
  $effect(() => {
    if (collab.role !== "host") return;
    const state = taskState();
    untrack(() => publish("run.state", state));
  });
});

// Host's Run terminal → guests. Output is batched a little to keep message counts low.
let outBuf = "";
let outTimer = 0;
listen<{ id: string; data: string }>("pty-data", (e) => {
  if (collab.role !== "host" || collab.participants.length < 2 || !isTaskPty(e.payload.id)) return;
  queueOut(e.payload.data);
});
// Omega's own lines in the Build/Run tabs (command, result) go along too.
setRunEcho((text) => {
  if (collab.role !== "host" || collab.participants.length < 2) return;
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  queueOut(btoa(bin));
});
function queueOut(b64: string) {
  const out = termOut.filter ? termOut.filter(b64, queueRaw) : b64;
  if (out) queueRaw(out);
}
function queueRaw(b64: string) {
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
    // Files on disk are autosaved. Unsaved "Untitled" tabs and files whose autosave failed (e.g.
    // read-only) keep their text in the snapshot (#129).
    snap.tabs.push(tab.path && !tab.dirty ? { path: tab.path, name: tab.name } : { path: tab.path, name: tab.name, content: ed.getText(tab.id) });
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
    const onDisk = !!tab.path && (await fsApi.exists(tab.path));
    if (onDisk) await openFile(tab.path!);
    if (tab.content === undefined || (!tab.path && !tab.content)) continue;
    // Unsaved text: back into the reopened file's tab (still unsaved), or a new tab.
    let x = onDisk ? app.tabs.find((y) => y.path === tab.path) : undefined;
    if (!x) {
      newFile();
      x = app.tabs.find((y) => y.id === app.activeId);
      if (x) x.name = tab.name;
    }
    if (!x || ed.getText(x.id) === tab.content) continue;
    ed.replaceDocText(x.id, tab.content);
    x.dirty = true;
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
  remoteTermId = remoteTerminal(t("ai.collab.hostRun", { name: share.hostRoot || t("app.project") }), (data) => typeIntoHostRun(data, stopOnHost));
  showRemoteStatus();
  return remoteTermId;
}

/** Guest: the mirror tab shows the host's run state like a local Run tab. */
function showRemoteStatus() {
  const tab = terms.tabs.find((x) => x.id === remoteTermId);
  if (tab) tab.status = runner.remoteTask?.status ?? undefined;
}

const isTaskState = (s: unknown): s is TaskState =>
  isObj(s) &&
  typeof s.running === "boolean" &&
  (s.kind === null || s.kind === "build" || s.kind === "run") &&
  (s.taskId === null || Number.isSafeInteger(s.taskId)) &&
  (s.status === null || s.status === "running" || s.status === "ok" || s.status === "fail" || s.status === "stopped") &&
  (s.packages === undefined || s.packages === true);

subscribe("run.state", (state) => {
  runner.remoteTask = isTaskState(state) ? state : null;
  showRemoteStatus();
});

async function stopOnHost() {
  const task = runner.remoteTask;
  if (!guestCanStop(task) && blockedByCapability("run")) return;
  if (!task?.running || task.taskId === null) return;
  const r = await call("run.stop", { taskId: task.taskId });
  if (!r.ok) ui.toast(rpcErrorText(r.error.code), "error");
}

function showRemoteRun() {
  ensureRemoteTerminal();
  showView("terminal");
  terms.active = remoteTermId;
}

const isSuggestion = (s: unknown): s is Suggestion =>
  isObj(s) && typeof s.value === "string" && (s.detail === undefined || s.detail === null || typeof s.detail === "string") && (s.tag === undefined || s.tag === null || typeof s.tag === "string");

/** Suggestions come from the host: it knows the project's dependencies. */
const suggestOnHost = (action: string) => async (query: string) => {
  const r = await call("packages.suggest", { action, query });
  return r.ok && Array.isArray(r.value) ? r.value.filter(isSuggestion) : [];
};

/** A package action: the guest is asked here, the host checks the answer and runs it. */
async function packagesOnHost(a: Action, kind: string) {
  const pkg = packageAction(kind, a.id);
  if (!pkg || blockedByCapability("packages")) return;
  let packages: string[] = [];
  if (pkg.input) {
    const ask = kind === "cargo" ? t("code.act.askCrate") : pkg.example ? t("code.act.askPackage", { example: pkg.example }) : t("code.act.askPackagePlain");
    const v = await ui.prompt(a.label.replace("…", ""), "", ask, undefined, kind === "cargo" ? undefined : suggestOnHost(a.id));
    if (!v || !joined) return;
    packages = splitPackages(v);
    if (!validPackages(kind, pkg.input, packages)) return ui.toast(t("ai.collab.packageInvalid"), "error");
  }
  showRemoteRun();
  const r = await call("packages.run", { action: a.id, packages });
  if (r.ok) return;
  const code = r.error.code;
  ui.toast(code === "invalid_package" ? t("ai.collab.packageInvalid") : code === "invalid_group" ? t("code.act.badGroup") : rpcErrorText(code), "error");
}

async function runOnHost(a: Action) {
  const kind = hostProject?.kind;
  if (kind && packageAction(kind, a.id)) return packagesOnHost(a, kind);
  if (blockedByCapability("run")) return;
  showRemoteRun();
  const path = activeTab()?.path;
  const rel = path && isRemote(path) ? path.slice(REMOTE.length) : null;
  // An Untitled tab has no file on the host, so it counts as no file.
  const file = rel && !rel.startsWith("tab:") ? rel : null;
  const r = await call("run.start", file ? { action: a.id, file, ...guestDocClock(file) } : { action: a.id });
  if (!r.ok) ui.toast(runErrorText(r.error.code), "error");
}

function runErrorText(code: string) {
  if (code === "run_path_refused") return t("ai.collab.run.pathRefused");
  if (code === "run_needs_file") return t("ai.collab.run.needsFile");
  if (code === "run_not_saved") return t("ai.collab.run.notSaved");
  if (code === "run_no_action") return t("ai.collab.run.noAction");
  return rpcErrorText(code);
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
    runnerRemote.run = runOnHost;
    runnerRemote.stop = stopOnHost;
    setMode(s.mode);
    for (const tab of s.tabs) if (tab.key !== s.active) await openRemote(tab.key);
    if (s.active) await openRemote(s.active);
  } else {
    share.treeGen++;
  }
  refreshProject();
}

// ------------------------------------------------------------------ messages

onCollabMessage((_peer, msg) => {
  if (collab.role === "host") {
    if (msg.t === "hello-ready") {
      lastSent = "";
      // Send the full session to everybody (cheap) so the new guest gets it.
      announce(true);
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
  runnerRemote.stop = null;
  runner.remoteTask = null;
  if (remoteTermId) closeTerminal(remoteTermId);
  remoteTermId = null;
  await restoreOwnWorkspace();
});

// A session that ended by a crash/quit left the own workspace stashed: bring it back on start.
if (localStorage.getItem(SNAP_KEY)) setTimeout(() => !collab.role && restoreOwnWorkspace(), 800);

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
