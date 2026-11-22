/** Debug controller: drives DAP sessions and keeps the shared store in sync. */
import { backendErrorText } from "../backendError";
import { DapSession } from "./dap";
import { planFor, type Plan } from "./adapters";
import { dbg, dbgHooks, dbgRemote, saveWatches, SHARED_BP, type Frame, type VarNode } from "./store.svelte";
import { debugRefresh } from "./editorExt";
import { mojoThreads, mojoValue } from "./mojoValues";
import { app, activeTab, openFile, save, setMode, inRoot } from "../state.svelte";
import { ui } from "../ui.svelte";
import * as ed from "../editor";
import { invoke } from "@tauri-apps/api/core";
import { runCommand, shellQuote } from "../terminal.svelte";
import { hasUnquotable, IS_WIN } from "../platform";
import { showView } from "../layout.svelte";
import { normPath } from "../api";
import { t, i18n, type Key } from "../i18n/index.svelte";

type Json = any;

let root: DapSession | null = null;
let active: DapSession | null = null;
/** The running session is Mojo: its values and threads need tidying up for display. */
let mojo = false;
let sessions: DapSession[] = [];
let tcpPort: number | null = null;
let serverProcId: string | null = null;
let lastPlan: { file: string; byGuest: boolean } | null = null;
let sourcePath: Plan["sourcePath"];
/** The debugged file when the adapter works on a private copy of it. */
let shadow: Plan["shadow"];
const toAdapter = (path: string) => (shadow && path === shadow.file ? shadow.copy : path);
const fromAdapter = (path: string) => (shadow && normPath(path) === shadow.copy ? shadow.file : path);
/** Bumped by every start and stop: a start that is no longer the newest ends itself. */
let startGen = 0;
/** A start is between its first step and a connected adapter. */
let starting = false;
/** The teardown in progress: everyone who needs the sessions gone waits for this same one. */
let closing: Promise<void> | null = null;
const initialized = new Map<DapSession, () => void>();
const configured = new Set<DapSession>();
/** Code Together: guests are driving, so the host's editor and layout stay where the host is. */
let quiet = false;
/** The guest-side implementation while connected to a host. */
const remote = () => (dbgRemote.impl?.active() ? dbgRemote.impl : null);

// ------------------------------------------------------------------ console

export function log(text: string, kind: (typeof dbg.console)[number]["kind"] = "info") {
  if (!text) return;
  dbg.console.push({ text, kind });
  if (dbg.console.length > 2000) dbg.console.splice(0, dbg.console.length - 2000);
  dbgHooks.logged({ text, kind });
}

// ------------------------------------------------------------------ editor refresh

function refreshEditor() {
  dbg.version++;
  const v = ed.getView();
  if (v) v.dispatch({ effects: debugRefresh.of(null) });
}

dbgHooks.hover = (expr) => hoverValue(expr);

dbgHooks.breakpointsChanged = (path) => {
  refreshEditor();
  if (path.startsWith(SHARED_BP)) return dbgRemote.impl?.breakpointsChanged(path);
  for (const s of sessions) if (configured.has(s)) sendBreakpoints(s, path);
};

// ------------------------------------------------------------------ sessions

function newSession(label: string) {
  const s = new DapSession(label, { event: onEvent, reverse: onReverse, exit: onExit, stderr: (_s, l) => log(l, "err") });
  sessions.push(s);
  return s;
}

function waitInitialized(s: DapSession) {
  return new Promise<void>((resolve) => initialized.set(s, resolve));
}

async function initialize(s: DapSession, adapterID: string) {
  s.capabilities = await s.request("initialize", {
    clientID: "omega",
    clientName: "Omega",
    adapterID,
    pathFormat: "path",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: true,
    supportsStartDebuggingRequest: true,
    supportsProgressReporting: false,
    locale: i18n.locale,
  });
}

async function sendBreakpoints(s: DapSession, path: string) {
  const list = dbg.breakpoints[path] ?? [];
  try {
    const r = await s.request("setBreakpoints", {
      source: { path: IS_WIN ? toAdapter(path).replace(/\//g, "\\") : toAdapter(path), name: toAdapter(path).split("/").pop() },
      breakpoints: list.map((b) => ({ line: b.line, condition: b.condition || undefined })),
      lines: list.map((b) => b.line),
    });
    (r.breakpoints ?? []).forEach((rb: Json, i: number) => {
      const b = dbg.breakpoints[path]?.[i];
      if (b) b.verified = rb.verified;
    });
    refreshEditor();
  } catch (e) {
    log(`Breakpoints (${path}): ${e}`, "error");
  }
}

/** Breakpoints are stored for all projects; only those of the open project (and the debugged
 *  file, which may lie outside it) are listed and sent to the adapter. */
export function inProject(path: string) {
  // A guest's own breakpoints stay out of the host's session (and untouched for after it).
  if (remote()) return path.startsWith(SHARED_BP);
  return !app.root || inRoot(path, app.root) || path === lastPlan?.file;
}

async function configure(s: DapSession, type?: string) {
  for (const path of Object.keys(dbg.breakpoints)) if (dbg.breakpoints[path].length && inProject(path)) await sendBreakpoints(s, path);
  const filters = (s.capabilities.exceptionBreakpointFilters ?? []).filter((f: Json) => f.default).map((f: Json) => f.filter);
  // Earlybird never answers this request, which would hold the program back until it times out.
  if (type !== "ocaml.earlybird") await s.request("setExceptionBreakpoints", { filters }).catch(() => {});
  configured.add(s);
  if (s.capabilities.supportsConfigurationDoneRequest) await s.request("configurationDone").catch(() => {});
}

/** Starts the adapter, sends launch, waits for `initialized`, configures. */
async function launchSession(s: DapSession, request: "launch" | "attach", args: Json) {
  await initialize(s, args.type ?? "omega");
  const init = waitInitialized(s);
  const launched = s.request(request, args, 0);
  await Promise.race([init, launched.then(() => init)]);
  await configure(s, args.type);
  await launched;
}

// ------------------------------------------------------------------ start / stop

export async function startDebugging() {
  const r = remote();
  if (r) return r.start();
  const tab = activeTab();
  if (!tab?.path) return ui.toast(t("code.dbg.saveFirst"), "error");
  quiet = false;
  await startFile(tab.path, "", false);
}

async function startFile(file: string, actor: string, byGuest: boolean) {
  if (app.tabs.some((x) => x.path === file && x.large)) return ui.toast(t("code.large.noDebug"), "error");
  const gen = ++startGen;
  starting = true;
  try {
    await runStart(gen, file, actor, byGuest);
  } catch (e) {
    if (gen === startGen) starting = false; // a failed save must not block later starts
    throw e;
  }
}

async function runStart(gen: number, file: string, actor: string, byGuest: boolean) {
  const stale = () => gen !== startGen;
  if (closing || (dbg.status !== "idle" && dbg.status !== "terminated")) await teardown();
  if (stale()) return;
  await dbgHooks.beforeStart();
  if (stale()) return;
  for (const x of app.tabs)
    if (x.dirty && x.path && !x.large) {
      await save(x.id);
      if (stale()) return;
    }
  if (!quiet) {
    setMode("code");
    showView("debug");
  }
  dbg.actor = actor;
  dbg.console = [];
  dbgHooks.logged(null);
  dbg.status = "starting";
  dbg.label = t("code.dbg.preparing");
  resetPause();
  lastPlan = { file, byGuest };

  let plan: Plan;
  try {
    plan = await planFor({
      file,
      workspace: app.root,
      log,
      askInstall: (name) => ui.confirm(t("code.dbg.installTitle"), t("code.dbg.installMsg", { name }), t("code.install")),
      cancelled: stale,
    });
  } catch (e) {
    if (stale()) return;
    starting = false;
    log(backendErrorText(e), "error");
    dbg.status = "terminated";
    dbg.actor = "";
    dbg.label = `${t("code.dbg.startFailed")}: ${backendErrorText(e).split("\n")[0]}`;
    return;
  }
  if (stale()) return;

  mojo = plan.launch?.type === "mojo-lldb";
  sourcePath = plan.sourcePath;
  shadow = plan.shadow;
  dbg.label = plan.label;
  log(t("code.dbg.starting", { label: plan.label }));
  const s = newSession(plan.label);
  root = active = s;
  let serverId: string | null = null;
  // Stopped or replaced while this was on its way: nothing it spawned may stay behind. `kill` isn't
  // enough on its own: the stop may have run before the process existed.
  const abandon = () => {
    s.alive = false;
    invoke("proc_kill", { id: s.id }).catch(() => {});
    if (serverId) invoke("proc_kill", { id: serverId }).catch(() => {});
  };
  try {
    if (plan.adapter.kind === "stdio") {
      await s.spawnStdio(plan.adapter.cmd, plan.adapter.args, plan.cwd, plan.adapter.env);
    } else if (plan.adapter.kind === "tcp") {
      serverId = serverProcId = `${s.id}-server`;
      const port = await invoke<number>("proc_spawn_tcp", { id: serverId, cmd: plan.adapter.cmd, args: plan.adapter.args, cwd: plan.cwd, env: plan.adapter.env ?? null });
      if (stale()) return abandon();
      tcpPort = port;
      await s.connect(port);
    } else {
      tcpPort = plan.adapter.port;
      await s.connect(plan.adapter.port);
    }
    if (stale()) return abandon();
    starting = false;
    dbg.status = "running";
    await launchSession(s, "launch", plan.launch);
  } catch (e) {
    if (stale()) return abandon();
    log(t("code.dbg.debugStartFailed", { err: backendErrorText(e) }), "error");
    await stopLocal();
  }
}

export async function stopDebugging() {
  const r = remote();
  if (r) return r.stop();
  return stopLocal();
}

/** Ends the session on this machine (also a start on its way), also while connected to a host. */
export async function stopLocal() {
  startGen++;
  starting = false;
  await teardown();
}

function teardown() {
  return (closing ??= closeSessions().finally(() => {
    closing = null;
  }));
}

async function closeSessions() {
  const all = [...sessions].reverse();
  for (const s of all) {
    if (!s.alive) continue;
    await s.request("disconnect", { terminateDebuggee: true, restart: false }, 3000).catch(() => {});
    s.kill();
  }
  if (serverProcId) invoke("proc_kill", { id: serverProcId });
  cleanup();
}

function cleanup() {
  runGen++;
  sessions = [];
  root = active = null;
  tcpPort = null;
  serverProcId = null;
  configured.clear();
  initialized.clear();
  dbg.status = dbg.status === "idle" ? "idle" : "terminated";
  dbg.actor = "";
  dbg.threads = [];
  dbg.frames = [];
  dbg.scopes = [];
  dbg.frameId = null;
  dbg.exec = null;
  for (const w of dbg.watches) {
    w.value = "";
    w.children = null;
  }
  refreshEditor();
}

/** Always a full stop + start, even when the adapter supports the DAP `restart` request:
 *  CodeLLDB ends the session on `restart` without the launch config, and only a fresh start
 *  runs the build step (cargo/cmake) again so the restarted program has the latest changes. */
export async function restartDebugging() {
  const r = remote();
  if (r) return r.restart();
  const file = lastPlan?.file;
  const { gen, stopped } = beginRestart();
  try {
    await stopped;
    if (gen !== startGen) return; // stopped or started again meanwhile
    if (file && activeTab()?.path !== file) await openFile(file, false, true);
    if (gen !== startGen) return;
    await startDebugging();
  } finally {
    if (gen === startGen) starting = false; // ended without a start taking over
  }
}

/** Stops the session for a restart, which counts as a start until the new one takes over: a Stop
 *  or a guest losing the right can still cancel it. */
function beginRestart() {
  const stopped = stopLocal();
  starting = true;
  return { gen: startGen, stopped };
}

// ------------------------------------------------------------------ stepping

const threadArgs = () => ({ threadId: dbg.threadId ?? dbg.threads[0]?.id ?? 1 });

/** Bumped whenever run state changes (step, restart, stopped/continued event, cleanup), so a late
 *  step rejection can tell whether newer state has arrived in the meantime. */
let runGen = 0;

async function step(cmd: "continue" | "next" | "stepIn" | "stepOut") {
  if (!active || dbg.status !== "stopped") return;
  const s = active;
  const prevExec = dbg.exec;
  const gen = ++runGen;
  dbg.status = "running";
  dbg.exec = null;
  refreshEditor();
  try {
    await s.request(cmd, threadArgs());
  } catch (e) {
    log(String(e), "error");
    // The adapter refused (or the request never reached it), so the program is still paused
    // where it was. A timeout says nothing about that: the program may be running, so keep
    // "running" and let Pause work. Don't overwrite newer state from a stopped/continued
    // event or the session's end either.
    const timedOut = (e as { timeout?: boolean })?.timeout === true;
    if (!timedOut && s.alive && gen === runGen && active === s && dbg.status === "running") {
      dbg.status = "stopped";
      if (dbg.exec === null) dbg.exec = prevExec;
      refreshEditor();
    }
  }
}

/** A step from this machine's own buttons: on a guest it goes to the host. */
function ownStep(cmd: "continue" | "next" | "stepIn" | "stepOut") {
  const r = remote();
  if (r) return r.step(cmd);
  quiet = false;
  dbg.actor = "";
  return step(cmd);
}

export const continueRun = () => ownStep("continue");
export const stepOver = () => ownStep("next");
export const stepInto = () => ownStep("stepIn");
export const stepOut = () => ownStep("stepOut");
export async function pause() {
  const r = remote();
  if (r) return r.pause();
  quiet = false;
  dbg.actor = "";
  return pauseLocal();
}

async function pauseLocal() {
  if (active && dbg.status === "running") await active.request("pause", threadArgs()).catch((e) => log(String(e), "error"));
}

// ------------------------------------------------------------------ events

function onEvent(s: DapSession, ev: Json) {
  // A session already closed may still have messages underway: they must not touch its successor.
  if (!sessions.includes(s)) return;
  const b = ev.body ?? {};
  switch (ev.event) {
    case "initialized":
      initialized.get(s)?.();
      break;
    case "output":
      if (b.category === "telemetry") break;
      log(String(b.output ?? "").replace(/\n$/, ""), b.category === "stderr" ? "err" : b.category === "important" ? "error" : b.category === "console" ? "info" : "out");
      break;
    case "stopped":
      runGen++;
      active = s;
      onStopped(s, b);
      break;
    case "continued":
      if (s === active) {
        runGen++;
        dbg.status = "running";
        dbg.exec = null;
        refreshEditor();
      }
      break;
    case "exited":
      log(t("code.dbg.processExited", { code: b.exitCode }), "info");
      break;
    case "terminated":
      if (s === root || !s.parent) {
        log(t("code.dbg.sessionEnded"));
        // During a teardown this is the adapter answering our disconnect, not a Stop.
        if (!closing) stopLocal();
      }
      break;
    case "breakpoint":
      if (b.breakpoint?.source?.path && b.breakpoint.line) {
        const list = dbg.breakpoints[normPath(fromAdapter(b.breakpoint.source.path))];
        const bp = list?.find((x) => x.line === b.breakpoint.line);
        if (bp) {
          bp.verified = b.breakpoint.verified;
          refreshEditor();
        }
      }
      break;
  }
}

/** Not closed and not being closed: only such a session may still cause new work. */
const isOpen = (s: DapSession) => !closing && s.alive && sessions.includes(s);

async function onReverse(s: DapSession, req: Json): Promise<Json> {
  if (!isOpen(s)) throw new Error(t("code.dap.sessionEnded"));
  const a = req.arguments ?? {};
  if (req.command === "runInTerminal") {
    const entries = Object.entries(a.env ?? {});
    const argv = (a.args as string[]).map(shellQuote).join(" ");
    if (hasUnquotable(argv)) throw new Error(t("code.rb.unsafeName"));
    let cmd: string;
    if (IS_WIN) {
      // cmd.exe: `set "K=V"` (an empty value unsets the variable).
      cmd = [...entries.map(([k, v]) => `set "${k}=${v === null ? "" : String(v)}"`), argv].join(" && ");
    } else {
      const env = entries.map(([k, v]) => (v === null ? `-u ${k}` : `${k}=${shellQuote(String(v))}`)).join(" ");
      cmd = `${env ? `env ${env} ` : ""}${argv}`;
    }
    runCommand(cmd, a.cwd || null, `Debug: ${dbg.label}`, false);
    return {};
  }
  if (req.command === "startDebugging") {
    // js-debug: child sessions connect to the same adapter port.
    if (!tcpPort) throw new Error("startDebugging without a TCP adapter");
    const child = newSession(a.configuration?.name ?? "child");
    child.parent = s;
    await child.connect(tcpPort);
    if (!isOpen(s) || !isOpen(child)) {
      child.kill();
      throw new Error(t("code.dap.sessionEnded"));
    }
    launchSession(child, a.request ?? "launch", a.configuration).catch((e) => log(String(e), "error"));
    return {};
  }
  throw new Error(`Unsupported: ${req.command}`);
}

function onExit(s: DapSession) {
  sessions = sessions.filter((x) => x !== s);
  if (s === root) {
    if (dbg.status !== "terminated") log(t("code.dbg.adapterExited"));
    if (serverProcId) invoke("proc_kill", { id: serverProcId });
    cleanup();
  }
}

// ------------------------------------------------------------------ stopped state

const REASONS: Record<string, Key> = {
  breakpoint: "code.dbg.reason.breakpoint",
  step: "code.dbg.reason.step",
  pause: "code.dbg.reason.pause",
  exception: "code.dbg.reason.exception",
  entry: "code.dbg.reason.entry",
  "function breakpoint": "code.dbg.reason.functionBreakpoint",
  "data breakpoint": "code.dbg.reason.dataBreakpoint",
  goto: "code.dbg.reason.goto",
};

/** Display text for `dbg.stopReason` (which keeps the raw DAP reason). */
export function stopReasonLabel(reason: string) {
  return REASONS[reason] ? t(REASONS[reason]) : reason;
}

async function onStopped(s: DapSession, b: Json) {
  dbg.status = "stopped";
  dbg.stopReason = b.reason ?? "";
  if (b.reason === "exception") {
    const text = await exceptionText(s, b);
    if (text) log(t("code.dbg.exception", { text }), "error");
  }
  try {
    const threads: Json[] = (await s.request("threads")).threads ?? [];
    dbg.threads = mojo ? mojoThreads(threads, b.threadId) : threads;
  } catch {
    dbg.threads = [];
  }
  dbg.threadId = b.threadId ?? dbg.threads[0]?.id ?? null;
  await loadStack();
}

/** "KeyError: 'zz'": the stopped event only carries the type, the message comes from exceptionInfo. */
async function exceptionText(s: DapSession, b: Json): Promise<string> {
  let id: string = b.text ?? "";
  let msg: string = b.description ?? "";
  if (s.capabilities.supportsExceptionInfoRequest && b.threadId != null) {
    try {
      const info = await s.request("exceptionInfo", { threadId: b.threadId });
      id = info.exceptionId || id;
      msg = info.description || msg;
    } catch {
      // Fall back to what the stopped event says.
    }
  }
  if (!msg || msg === id || msg.startsWith(`${id}:`)) return msg || id;
  return id ? `${id}: ${msg}` : msg;
}

export async function selectThread(id: number) {
  const r = remote();
  if (r) return r.selectThread(id);
  quiet = false;
  return applyThread(id);
}

async function applyThread(id: number) {
  dbg.threadId = id;
  await loadStack();
}

async function loadStack() {
  if (!active || dbg.threadId === null) return;
  let frames: Json[] = [];
  try {
    frames = (await active.request("stackTrace", { threadId: dbg.threadId, startFrame: 0, levels: 60 })).stackFrames ?? [];
  } catch (e) {
    log(String(e), "error");
  }
  if (sourcePath) {
    const map = sourcePath;
    await Promise.all(frames.map(async (f) => {
      if (f.source?.path) f.source.path = await map(f.source.path);
    }));
  }
  dbg.frames = frames.map(
    (f): Frame => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ? normPath(fromAdapter(f.source.path)) : null,
      line: f.line,
      column: f.column,
      subtle: f.presentationHint === "subtle" || f.source?.presentationHint === "deemphasize" || !f.source?.path,
    }),
  );
  const first = dbg.frames.find((f) => !f.subtle) ?? dbg.frames[0];
  if (first) await applyFrame(first);
}

export async function selectFrame(f: Frame) {
  const r = remote();
  if (r) return r.selectFrame(f);
  quiet = false;
  return applyFrame(f);
}

async function applyFrame(f: Frame) {
  if (!active) return;
  dbg.frameId = f.id;
  if (f.path) {
    dbg.exec = { path: f.path, line: f.line };
    if (!quiet) {
      if (activeTab()?.path !== f.path) await openFile(f.path, false, true);
      const view = ed.getView();
      if (view && f.line <= view.state.doc.lines) {
        const line = view.state.doc.line(f.line);
        view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      }
    }
  } else dbg.exec = null;
  refreshEditor();
  await loadScopes(f.id);
  await evaluateWatches();
}

/** (Re)loads the variables of a frame. With `keepOpen`, the nodes expanded so far are expanded
 *  again (used after a REPL command, which may have changed variables); otherwise only the first
 *  cheap scope is expanded. */
async function loadScopes(frameId: number, keepOpen = false) {
  if (!active) return;
  const prev = new Map(flatten(dbg.scopes).map((n) => [path(n), n.value]));
  const open = new Set(flatten(dbg.scopes).filter((n) => n.expanded).map(path));
  try {
    const scopes: Json[] = (await active.request("scopes", { frameId })).scopes ?? [];
    dbg.scopes = scopes.map((sc) => ({ name: sc.name, value: "", ref: sc.variablesReference, parentRef: 0, children: null, expanded: false }));
    if (keepOpen) {
      const reopen = async (nodes: VarNode[]) => {
        for (const n of nodes)
          if (n.ref && open.has(path(n))) {
            await toggleNode(n);
            if (n.children) await reopen(n.children);
          }
      };
      await reopen(dbg.scopes);
    } else {
      // Expand the first (cheap) scope like PyCharm does.
      const firstScope = dbg.scopes.find((_, i) => !scopes[i].expensive);
      if (firstScope) await toggleNode(firstScope);
    }
    markChanged(prev);
  } catch (e) {
    log(String(e), "error");
  }
}

const path = (n: VarNode & { _path?: string }) => n._path ?? n.name;
function flatten(nodes: VarNode[]): VarNode[] {
  return nodes.flatMap((n) => [n, ...(n.children ? flatten(n.children) : [])]);
}
function markChanged(prev: Map<string, string>) {
  for (const n of flatten(dbg.scopes)) {
    const old = prev.get(path(n));
    n.changed = old !== undefined && old !== n.value;
  }
}

const rawVars = async (s: DapSession, ref: number): Promise<Json[]> => (await s.request("variables", { variablesReference: ref })).variables ?? [];

async function readVars(s: DapSession, ref: number): Promise<Json[]> {
  const vars = await rawVars(s, ref);
  if (!mojo) return vars;
  return Promise.all(
    vars.map(async (v) => {
      const m = await mojoValue({ value: v.value, type: v.type, ref: v.variablesReference }, (r) => rawVars(s, r));
      return { ...v, value: m.value, type: m.type, variablesReference: m.ref };
    }),
  );
}

async function readEvaluate(s: DapSession, args: Json): Promise<Json> {
  const r = await s.request("evaluate", args);
  if (!mojo) return r;
  const m = await mojoValue({ value: r.result, type: r.type, ref: r.variablesReference ?? 0 }, (ref) => rawVars(s, ref));
  return { ...r, result: m.value, type: m.type, variablesReference: m.ref };
}

/** A new value from setVariable, in the same form the Variables panel shows. */
async function setVar(s: DapSession, args: Json): Promise<string> {
  const r = await s.request("setVariable", args);
  if (!mojo) return r.value;
  return (await mojoValue({ value: r.value, type: r.type, ref: r.variablesReference ?? 0 }, (ref) => rawVars(s, ref))).value;
}

async function fetchVars(ref: number, prefix: string): Promise<VarNode[]> {
  if (!active || !ref) return [];
  const vars = await readVars(active, ref);
  return vars.map((v) => {
    const node: VarNode & { _path?: string } = {
      name: v.name,
      value: v.value,
      type: v.type,
      ref: v.variablesReference,
      evaluateName: v.evaluateName,
      parentRef: ref,
      children: null,
      expanded: false,
    };
    node._path = `${prefix}/${v.name}`;
    return node;
  });
}

export async function toggleNode(n: VarNode) {
  const r = remote();
  if (r) return r.toggleNode(n);
  if (!n.ref) return;
  if (!n.expanded && !n.children) {
    try {
      n.children = await fetchVars(n.ref, path(n));
    } catch (e) {
      log(String(e), "error");
      n.children = [];
    }
  }
  n.expanded = !n.expanded;
}

export async function setVariable(n: VarNode, value: string) {
  const remoteImpl = remote();
  if (remoteImpl) return remoteImpl.setVariable(n, value);
  if (!active?.capabilities.supportsSetVariable) return ui.toast(t("code.dbg.noSetVariable"), "error");
  try {
    n.value = await setVar(active, { variablesReference: n.parentRef, name: n.name, value });
    n.changed = true;
    await evaluateWatches();
  } catch (e) {
    ui.toast(String(e instanceof Error ? e.message : e), "error");
  }
}

// ------------------------------------------------------------------ watches & console

export async function evaluate(expression: string, context: "watch" | "repl" | "hover") {
  if (!active) throw new Error(t("code.dbg.noSession"));
  return readEvaluate(active, { expression, frameId: dbg.frameId ?? undefined, context });
}

export async function evaluateWatches() {
  const r = remote();
  if (r) return r.evaluateWatches();
  for (const w of dbg.watches) {
    if (dbg.status !== "stopped") {
      w.value = "";
      continue;
    }
    try {
      const r = await evaluate(w.expr, "watch");
      w.value = r.result;
      w.ref = r.variablesReference ?? 0;
      w.error = false;
      w.children = null;
      w.expanded = false;
    } catch (e) {
      w.value = String(e instanceof Error ? e.message : e);
      w.error = true;
      w.ref = 0;
    }
  }
}

export async function toggleWatch(i: number) {
  const r = remote();
  if (r) return r.toggleWatch(i);
  const w = dbg.watches[i];
  if (!w?.ref) return;
  if (!w.expanded && !w.children) w.children = await fetchVars(w.ref, `watch:${w.expr}`).catch(() => []);
  w.expanded = !w.expanded;
}

export function addWatch(expr: string) {
  if (!expr.trim()) return;
  dbg.watches.push({ expr: expr.trim(), value: "", ref: 0, children: null, expanded: false });
  saveWatches();
  evaluateWatches();
}

export function removeWatch(i: number) {
  dbg.watches.splice(i, 1);
  saveWatches();
}

export async function replEval(expr: string) {
  const rem = remote();
  if (rem) return rem.replEval(expr);
  log(`› ${expr}`, "input");
  try {
    const r = await evaluate(expr, "repl");
    log(r.result, "result");
    await refreshAfterChange();
  } catch (e) {
    log(String(e instanceof Error ? e.message : e), "error");
  }
}

/** Hover in the editor while stopped: evaluates the expression under the mouse. */
export async function hoverValue(expr: string): Promise<string | null> {
  const rem = remote();
  if (rem) return rem.hover(expr);
  if (dbg.status !== "stopped" || !active) return null;
  try {
    const r = await evaluate(expr, "hover");
    return r.result;
  } catch {
    return null;
  }
}

/** The expression may have assigned a variable: refresh Variables, not just the watches. */
async function refreshAfterChange() {
  if (dbg.status === "stopped" && dbg.frameId !== null) await loadScopes(dbg.frameId, true);
  await evaluateWatches();
}

// ------------------------------------------------------------------ Code Together host

/**
 * What the host's RPC handlers (collab/debugRemote.svelte.ts) may do with the running session: a
 * closed list of typed actions. There is deliberately no way to send a DAP request by name.
 * `actor` is the guest's name; while guests drive, the host's editor and layout don't jump.
 */
export const hostDebug = {
  /** Bumped whenever run state changes: references from an older value are stale. */
  gen: () => runGen,
  live: () => !!active,
  localLive: () => !!root,
  canRestart: () => !!lastPlan?.file,
  /** A start is on its way (not yet connected to its adapter). */
  starting: () => starting,
  /** The sessions are being closed: a start now would undo the Stop that is under way. */
  closing: () => !!closing,
  /** The file a restart would launch. */
  planFile: () => lastPlan?.file ?? null,
  /** The session or folder a guest's start belonged to is gone: restart can't launch it any more. */
  forgetGuestPlan() {
    if (lastPlan?.byGuest) lastPlan = null;
  },
  /** Ends a start still on its way; a session already connected stays. */
  async cancelStart() {
    if (starting) await stopLocal();
  },
  async start(file: string, actor: string) {
    quiet = true;
    await startFile(file, actor, true);
  },
  stop: () => stopLocal(),
  /** `file` is what the caller checked against the guest's scope. */
  async restart(file: string, actor: string) {
    quiet = true;
    const { gen, stopped } = beginRestart();
    try {
      await stopped;
      if (gen !== startGen) return; // stopped or started again meanwhile
      // The teardown can take seconds: the plan or folder the caller checked may be gone.
      if (lastPlan?.file !== file || !app.root || !inRoot(file, app.root)) return;
      await startFile(file, actor, true);
    } finally {
      if (gen === startGen) starting = false; // ended without a start taking over
    }
  },
  step(cmd: "continue" | "next" | "stepIn" | "stepOut", actor: string) {
    quiet = true;
    dbg.actor = actor;
    return step(cmd);
  },
  pause(actor: string) {
    quiet = true;
    dbg.actor = actor;
    return pauseLocal();
  },
  selectThread(id: number) {
    quiet = true;
    return applyThread(id);
  },
  selectFrame(f: Frame) {
    quiet = true;
    return applyFrame(f);
  },
  async variables(ref: number): Promise<Json[]> {
    if (!active) throw new Error("no session");
    return readVars(active, ref);
  },
  async evaluate(expression: string, context: "watch" | "repl" | "hover", frameId: number) {
    if (!active) throw new Error("no session");
    return readEvaluate(active, { expression, frameId, context });
  },
  async setVariable(ref: number, name: string, value: string) {
    if (!active?.capabilities.supportsSetVariable) return null;
    const shown = await setVar(active, { variablesReference: ref, name, value });
    await refreshAfterChange();
    return shown;
  },
  refresh: refreshAfterChange,
  log,
  /** Back to normal: the host's own session follows its editor again. */
  release() {
    quiet = false;
    dbg.actor = "";
  },
  refreshEditor,
};

function resetPause() {
  dbg.stopReason = "";
  dbg.threads = [];
  dbg.frames = [];
  dbg.scopes = [];
  dbg.exec = null;
}
