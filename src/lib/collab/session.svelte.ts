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
import { listen } from "../windowEvents";
import { collab, broadcast, onCollabMessage, sessionEndHooks } from "./collab.svelte";
import { REMOTE, share, type GuestScope, flushSharedDocs, guestDocClock, guestScope, hostDocHasClock, hostDocKeyFor, hostKeyChecked, sharedDocUnsaved, syncSharedTabs, openRemote, isRemote } from "./share.svelte";
import { blockedByCapability, guestCanStop, type Capability } from "./guard";
import { noteGuestChange } from "./guestChanges";
import { termOut } from "./debugMirror";
import { MirrorQueue } from "./mirrorQueue";
import { call, hasCapability, isObj, publish, registerMethod, registerTopic, rpcErrorText, RpcFail, subscribe } from "./rpc.svelte";
import { app, activeTab, activate, closeTab, flushAutosave, newFile, openFile, setMode, setRoot } from "../state.svelte";
import { fileDependent, projectFor, runner, runGuestAction, refreshProject, runnerRemote, saveForGuestRun } from "../code/runner.svelte";
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

/** A project as guests see it: names and ids, never commands or paths. */
const projectInfo = (p: Project): ProjectInfo => ({
  kind: p.kind,
  label: p.label,
  run: info(p.run),
  build: info(p.build),
  test: info(p.test),
  // Actions that ask for input only go out as package actions: the guest prompts for those.
  more: p.more.filter((m) => !m.ask || packageAction(p.kind, m.id)).map(info).filter((m): m is ActionInfo => !!m),
});

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
    project: p ? projectInfo(p) : null,
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
  const { scope, key } = await checkedGuestFile(file, peer);
  if (client !== undefined && hasCapability(peer, "edit") && !(await editArrived(key, client, clock!, signal))) throw new RpcFail("run_not_saved");
  const abs = scope.abs(key);
  const saved = await saveForGuestRun(abs);
  await flushSharedDocs();
  if (signal.aborted) throw new RpcFail("cancelled");
  if (!scope.live() || hostDocKeyFor(key, peer) !== key) throw new RpcFail("run_path_refused");
  if (!saved || sharedDocUnsaved(key)) throw new RpcFail("run_not_saved");
  const project = await projectFor(abs, scope.root);
  // Last check before the path goes into a command: a folder may have become a symlink meanwhile.
  if (!scope.live() || !(await scope.check(key))) throw new RpcFail("run_path_refused");
  if (signal.aborted) throw new RpcFail("cancelled");
  const action = actionIn(project, id);
  if (!project || !action) throw new RpcFail("run_no_action");
  return { action, project, file: abs, key, scope };
}

/** Host: the one check for a file a guest names for an action. */
async function checkedGuestFile(file: string, peer: string) {
  const scope = guestScope();
  const key = hostDocKeyFor(file, peer);
  if (!scope || !key || !quotablePath(key) || !(await scope.check(key))) throw new RpcFail("run_path_refused");
  return { scope, key };
}

/** Host: the project of a guest's file, read-only: nothing is saved for this. */
async function projectOfGuestFile(file: string, peer: string, signal: AbortSignal) {
  const { scope, key } = await checkedGuestFile(file, peer);
  const project = await projectFor(scope.abs(key), scope.root);
  if (!scope.live() || hostDocKeyFor(key, peer) !== key || !(await scope.check(key))) throw new RpcFail("run_path_refused");
  if (signal.aborted) throw new RpcFail("cancelled");
  return { project, scope, key };
}

/**
 * Host: an action for a guest without a file. It's looked up once, from the project root and never
 * from the host's active tab, so a tab switch on the host can't change what starts.
 */
async function resolveWithoutFile(id: string, signal: AbortSignal) {
  const before = runner.project;
  const known = findAction(id);
  if (!before || !known) throw new RpcFail("unavailable");
  const root = app.root;
  await saveForGuestRun(null);
  await flushSharedDocs();
  if (signal.aborted) throw new RpcFail("cancelled");
  const project = await projectFor(null, before.root);
  if (signal.aborted) throw new RpcFail("cancelled");
  if (app.root !== root) throw new RpcFail("unavailable");
  const action = actionIn(project, id);
  if (project && action && !action.cmd!.includes("{file}")) return { action, project, file: null, key: null, scope: null };
  // E.g. a custom command in a folder without a project file: it's the same from anywhere.
  if (!fileDependent(known)) return { action: known, project: before, file: null, key: null, scope: null };
  throw new RpcFail("run_needs_file");
}

/**
 * Host: asked right before a guest's action starts, after anything that can wait for the host. The
 * RPC's signal is gone by then. Same guest (not a rejoin), same rights, same folder, same file.
 */
function guestStillAllowed(peer: string, caps: Capability[], label: string, target: { scope: GuestScope | null; key: string | null; needsText?: boolean }) {
  const who = collab.participants.find((p) => p.peer === peer);
  const root = app.root;
  const { scope, key, needsText } = target;
  const same = () => !!who && collab.participants.find((p) => p.peer === peer) === who && caps.every((c) => hasCapability(peer, c)) && app.root === root && (!key || hostDocKeyFor(key, peer) === key);
  return async () => {
    let ok = same();
    if (ok && key && scope) {
      if (needsText) await flushSharedDocs();
      ok = (!needsText || !sharedDocUnsaved(key)) && (await scope.check(key)) && same();
    }
    if (!ok) ui.toast(t("ai.collab.run.notStarted", { name: who?.name ?? t("ai.collab.guest"), action: label }));
    return ok;
  };
}

declare module "./rpc.svelte" {
  interface RpcMethods {
    "run.start": { params: { action: string; file?: string; client?: number; clock?: number }; result: null };
    "run.project": { params: { file: string }; result: ProjectInfo | null };
    "run.stop": { params: { taskId: number }; result: { stopped: boolean } };
    "packages.run": { params: { action: string; packages: string[]; file?: string }; result: null };
    "packages.suggest": { params: { action: string; query: string; file?: string }; result: Suggestion[] };
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
    const target = file !== undefined ? await resolveForGuestFile(action, { file, client, clock }, peer, signal) : await resolveWithoutFile(action, signal);
    const { action: a, project } = target;
    const isPackage = !!packageAction(project.kind, a.id);
    if (isPackage && !hasCapability(peer, "packages")) throw new RpcFail("forbidden");
    // A package action changes project files. (`run` is required above, so this only counts if that
    // ever changes; packages.run is the path for guests without it.)
    if (isPackage) noteGuestChange(peer, app.root ?? project.root);
    ui.toast(t("ai.collab.guestRuns", { name: guestName(peer), action: a.label }));
    const allowed = guestStillAllowed(peer, isPackage ? ["run", "packages"] : ["run"], a.label, { scope: target.scope, key: target.key, needsText: true });
    // Not awaited: it can wait for the host (missing tools), and the guest sees the run state anyway.
    void Promise.resolve(runGuestAction(a, project, target.file, { allowed })).catch((e) => console.error("guest run", e));
    return null;
  },
});

// What the guest's Run bar offers for the file it has open.
registerMethod({
  name: "run.project",
  capability: null,
  validate: (raw) => (isObj(raw) && isShortString(raw.file, 4096) ? { file: raw.file } : null),
  handle: async ({ file }, { peer, signal }) => {
    const { project } = await projectOfGuestFile(file, peer, signal);
    return project ? projectInfo(project) : null;
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

/** The package action with this id, in the project of the guest's file or else the current one. */
async function findPackageAction(id: string, file: string | undefined, peer: string, signal: AbortSignal) {
  const of = file === undefined ? null : await projectOfGuestFile(file, peer, signal);
  const p = of ? of.project : runner.project;
  const pkg = p && packageAction(p.kind, id);
  const action = pkg && p.more.find((m) => m.id === id && m.cmd);
  return p && pkg && action ? { project: p, pkg, action, scope: of?.scope ?? null, key: of?.key ?? null } : null;
}

const optionalFile = (raw: Record<string, unknown>) => raw.file === undefined || isShortString(raw.file, 4096);
const fileParam = (raw: Record<string, unknown>) => (raw.file === undefined ? {} : { file: raw.file as string });

registerMethod({
  name: "packages.run",
  capability: "packages",
  validate: (raw) => {
    if (!isObj(raw) || !isShortString(raw.action, 64) || !Array.isArray(raw.packages) || raw.packages.length > PACKAGE_LIMITS.count) return null;
    if (!raw.packages.every((x) => isShortString(x, PACKAGE_LIMITS.length)) || !optionalFile(raw)) return null;
    return { action: raw.action, packages: raw.packages as string[], ...fileParam(raw) };
  },
  handle: async ({ action, packages, file }, { peer, signal }) => {
    const root = app.root;
    const found = await findPackageAction(action, file, peer, signal);
    if (!found) throw new RpcFail(file === undefined ? "unavailable" : "run_no_action");
    const { project, pkg, action: a, scope, key } = found;
    let arg: string | undefined;
    if (pkg.input) {
      if (!validPackages(project.kind, pkg.input, packages)) throw new RpcFail("invalid_package");
      const flags = project.kind === "uv" && pkg.input === "remove" ? await pythonRemoveFlags(project.root, packages) : [];
      if (!flags) throw new RpcFail("invalid_group");
      if (signal.aborted) throw new RpcFail("cancelled");
      // For a guest's file the project is that file's, whatever the host has open now.
      if (app.root !== root || (!key && (runner.project?.root !== project.root || runner.project.kind !== project.kind))) throw new RpcFail("unavailable");
      arg = [...flags, ...packages.map((x) => quotePackageArg(x))].join(" ");
    } else if (packages.length) throw new RpcFail("invalid_package");
    noteGuestChange(peer, app.root ?? project.root); // before the task can change project files
    const label = a.label.replace("…", "");
    ui.toast(packages.length ? t("ai.collab.guestPackages", { name: guestName(peer), action: label, packages: packages.join(", ") }) : t("ai.collab.guestRuns", { name: guestName(peer), action: label }));
    const allowed = guestStillAllowed(peer, ["packages"], label, { scope, key });
    void Promise.resolve(runGuestAction(a, project, null, { arg, allowed })).catch((e) => console.error("guest packages", e));
    return null;
  },
});

registerMethod({
  name: "packages.suggest",
  capability: "packages",
  validate: (raw) => (isObj(raw) && isShortString(raw.action, 64) && isShortString(raw.query, 100) && optionalFile(raw) ? { action: raw.action, query: raw.query, ...fileParam(raw) } : null),
  handle: async ({ action, query, file }, { peer, signal }) => {
    const a = (await findPackageAction(action, file, peer, signal))?.action;
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
const outQueue = new MirrorQueue();
let outTimer = 0;
let outFlushing = false;
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
  const out = termOut.filter?.(b64, queueRaw);
  if (out) queueRaw(out);
}
function queueRaw(b64: string) {
  outQueue.push(b64);
  if (outQueue.pending && !outTimer) outTimer = window.setTimeout(() => void flushOut(), 30);
}
async function flushOut() {
  outTimer = 0;
  if (outFlushing) return;
  outFlushing = true;
  try {
    // Awaited, so a slow connection holds output in the queue, where it's bounded.
    while (collab.role === "host" && outQueue.pending) await broadcast(outQueue.take());
  } finally {
    outFlushing = false;
  }
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
  const snap: Snapshot = { root: app.root, mode: app.mode, active: activeTab()?.path ?? activeTab()?.viewOf ?? null, tabs: [] };
  for (const tab of [...app.tabs]) {
    if (isRemote(tab.path ?? tab.viewOf) || tab.headOf) continue; // a too large file's read-only view isn't kept
    if (tab.viewOf) {
      snap.tabs.push({ path: tab.viewOf, name: tab.name });
      continue;
    }
    if (tab.large && tab.dirty) {
      // Large files aren't autosaved and don't fit the snapshot: the tab stays open, unsaved (#174).
      ui.toast(t("app.large.keptOpen", { name: tab.name }));
      continue;
    }
    // Files on disk are autosaved. Unsaved "Untitled" tabs and files whose autosave failed (e.g.
    // read-only) keep their text in the snapshot (#129).
    snap.tabs.push(tab.path && !tab.dirty ? { path: tab.path, name: tab.name } : { path: tab.path, name: tab.name, content: ed.getText(tab.id) });
  }
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch {}
  for (const tab of [...app.tabs]) if (!isRemote(tab.path ?? tab.viewOf) && !(tab.large && tab.dirty)) await closeTab(tab.id, true);
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
    if (onDisk) await openFile(tab.path!, true); // quiet: a large file gets a notice, no dialog (#174)
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
  const active = snap.active && app.tabs.find((x) => (x.path ?? x.viewOf) === snap!.active);
  if (active) activate(active.id);
  refreshProject();
}

/** Guest: the active tab's shared file. An Untitled tab has no file on the host, so it counts as none. */
function guestRunFile() {
  const path = activeTab()?.path;
  const rel = path && isRemote(path) ? path.slice(REMOTE.length) : null;
  return rel && !rel.startsWith("tab:") ? rel : null;
}

/** Guest: what the host said each open file can run. Until it answers, the host's project shows. */
const fileProjects = new Map<string, ProjectInfo | null>();
const MAX_FILE_PROJECTS = 64;
const FILE_PROJECT_DELAY_MS = 80;
let fileProjectTimer = 0;
let fileProjectCall: AbortController | null = null;

function shownProject() {
  const file = guestRunFile();
  return file && fileProjects.has(file) ? fileProjects.get(file)! : hostProject;
}

const isActionInfo = (a: unknown): a is ActionInfo => isObj(a) && typeof a.id === "string" && typeof a.label === "string";
const isProjectInfo = (p: unknown): p is ProjectInfo =>
  isObj(p) &&
  typeof p.kind === "string" &&
  typeof p.label === "string" &&
  [p.run, p.build, p.test].every((a) => a === null || isActionInfo(a)) &&
  Array.isArray(p.more) &&
  p.more.every(isActionInfo);

function scheduleFileProject() {
  clearTimeout(fileProjectTimer);
  fileProjectTimer = window.setTimeout(() => void loadFileProject(), FILE_PROJECT_DELAY_MS);
}

async function loadFileProject() {
  fileProjectCall?.abort();
  fileProjectCall = null;
  const file = guestRunFile();
  if (!file || !joined) return;
  const ctrl = (fileProjectCall = new AbortController());
  const r = await call("run.project", { file }, { signal: ctrl.signal });
  if (fileProjectCall !== ctrl || !joined) return;
  fileProjectCall = null;
  // No answer (e.g. an older host): the Run bar keeps showing what it knows.
  if (!r.ok || (r.value !== null && !isProjectInfo(r.value))) return;
  if (fileProjects.size >= MAX_FILE_PROJECTS && !fileProjects.has(file)) fileProjects.clear();
  fileProjects.set(file, r.value);
  if (guestRunFile() === file) runner.project = guestProject();
}

function forgetFileProjects() {
  clearTimeout(fileProjectTimer);
  fileProjectCall?.abort();
  fileProjectCall = null;
  fileProjects.clear();
}

function guestProject(): Project | null {
  const p = shownProject();
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
const suggestOnHost = (action: string, file: string | null) => async (query: string) => {
  const r = await call("packages.suggest", { action, query, ...(file ? { file } : {}) });
  return r.ok && Array.isArray(r.value) ? r.value.filter(isSuggestion) : [];
};

/** A package action: the guest is asked here, the host checks the answer and runs it. */
async function packagesOnHost(a: Action, kind: string) {
  const pkg = packageAction(kind, a.id);
  if (!pkg || blockedByCapability("packages")) return;
  // The file at the time of the click: the prompt can stay open across a tab switch.
  const file = guestRunFile();
  let packages: string[] = [];
  if (pkg.input) {
    const ask = kind === "cargo" ? t("code.act.askCrate") : pkg.example ? t("code.act.askPackage", { example: pkg.example }) : t("code.act.askPackagePlain");
    const v = await ui.prompt(a.label.replace("…", ""), "", ask, undefined, kind === "cargo" ? undefined : suggestOnHost(a.id, file));
    if (!v || !joined) return;
    packages = splitPackages(v);
    if (!validPackages(kind, pkg.input, packages)) return ui.toast(t("ai.collab.packageInvalid"), "error");
  }
  showRemoteRun();
  const r = await call("packages.run", { action: a.id, packages, ...(file ? { file } : {}) });
  if (r.ok) return;
  const code = r.error.code;
  ui.toast(code === "invalid_package" ? t("ai.collab.packageInvalid") : code === "invalid_group" ? t("code.act.badGroup") : runErrorText(code), "error");
}

async function runOnHost(a: Action) {
  const kind = shownProject()?.kind;
  if (kind && packageAction(kind, a.id)) return packagesOnHost(a, kind);
  if (blockedByCapability("run")) return;
  showRemoteRun();
  const file = guestRunFile();
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
  if (share.hostRoot !== (s.root ?? t("ai.collab.noFolder"))) forgetFileProjects();
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
    runnerRemote.refresh = scheduleFileProject;
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
    // CAN ends a sequence the skipped output left open, so the marker shows as text.
    if (msg.skipped) writeTerminal(id, `\x18\x1b[0m\r\n\x1b[2m${t("ai.collab.shell.skipped")}\x1b[0m\r\n`);
    for (const c of msg.chunks as string[]) writeTerminal(id, decoder.decode(Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)), { stream: true }));
  }
});

sessionEndHooks.push(async (wasGuest) => {
  lastSent = "";
  clearTimeout(outTimer);
  outTimer = 0;
  outQueue.clear();
  if (!wasGuest) return;
  joined = false;
  hostProject = null;
  runnerRemote.project = null;
  runnerRemote.run = null;
  runnerRemote.stop = null;
  runnerRemote.refresh = null;
  forgetFileProjects();
  runner.remoteTask = null;
  if (remoteTermId) closeTerminal(remoteTermId);
  remoteTermId = null;
  await restoreOwnWorkspace();
});

// A session that ended by a crash/quit left the own workspace stashed: bring it back on start.
if (localStorage.getItem(SNAP_KEY)) setTimeout(() => !collab.role && restoreOwnWorkspace(), 800);

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
