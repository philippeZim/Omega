/** Debug controller: drives DAP sessions and keeps the shared store in sync. */
import { DapSession } from "./dap";
import { planFor, type Plan } from "./adapters";
import { dbg, dbgHooks, saveWatches, type Frame, type VarNode } from "./store.svelte";
import { debugRefresh } from "./editorExt";
import { app, activeTab, openFile, save, setMode } from "../state.svelte";
import { ui } from "../ui.svelte";
import * as ed from "../editor";
import { invoke } from "@tauri-apps/api/core";
import { runCommand, shellQuote } from "../terminal.svelte";

type Json = any;

let root: DapSession | null = null;
let active: DapSession | null = null;
let sessions: DapSession[] = [];
let tcpPort: number | null = null;
let serverProcId: string | null = null;
let lastPlan: { file: string } | null = null;
const initialized = new Map<DapSession, () => void>();
const configured = new Set<DapSession>();

// ------------------------------------------------------------------ console

export function log(text: string, kind: (typeof dbg.console)[number]["kind"] = "info") {
  if (!text) return;
  dbg.console.push({ text, kind });
  if (dbg.console.length > 2000) dbg.console.splice(0, dbg.console.length - 2000);
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
    clientID: "studio",
    clientName: "Studio",
    adapterID,
    pathFormat: "path",
    linesStartAt1: true,
    columnsStartAt1: true,
    supportsVariableType: true,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: true,
    supportsStartDebuggingRequest: true,
    supportsProgressReporting: false,
    locale: "de",
  });
}

async function sendBreakpoints(s: DapSession, path: string) {
  const list = dbg.breakpoints[path] ?? [];
  try {
    const r = await s.request("setBreakpoints", {
      source: { path, name: path.split("/").pop() },
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

async function configure(s: DapSession) {
  for (const path of Object.keys(dbg.breakpoints)) if (dbg.breakpoints[path].length) await sendBreakpoints(s, path);
  const filters = (s.capabilities.exceptionBreakpointFilters ?? []).filter((f: Json) => f.default).map((f: Json) => f.filter);
  await s.request("setExceptionBreakpoints", { filters }).catch(() => {});
  configured.add(s);
  if (s.capabilities.supportsConfigurationDoneRequest) await s.request("configurationDone").catch(() => {});
}

/** Starts the adapter, sends launch, waits for `initialized`, configures. */
async function launchSession(s: DapSession, request: "launch" | "attach", args: Json) {
  await initialize(s, args.type ?? "studio");
  const init = waitInitialized(s);
  const launched = s.request(request, args, 0);
  await Promise.race([init, launched.then(() => init)]);
  await configure(s);
  await launched;
}

// ------------------------------------------------------------------ start / stop

export async function startDebugging() {
  const tab = activeTab();
  if (!tab?.path) return ui.toast("Datei zuerst speichern, um sie zu debuggen", "error");
  if (dbg.status !== "idle" && dbg.status !== "terminated") await stopDebugging();
  for (const t of app.tabs) if (t.dirty && t.path) await save(t.id);
  setMode("code");
  dbg.panel = true;
  dbg.console = [];
  dbg.status = "starting";
  dbg.label = "Vorbereiten …";
  resetPause();
  lastPlan = { file: tab.path };

  let plan: Plan;
  try {
    plan = await planFor({
      file: tab.path,
      workspace: app.root,
      log,
      askInstall: (name) => ui.confirm("Debugger installieren?", `${name} fehlt. Jetzt in den App-Ordner installieren?`, "Installieren"),
    });
  } catch (e) {
    log(String(e instanceof Error ? e.message : e), "error");
    dbg.status = "terminated";
    dbg.label = "Start fehlgeschlagen";
    return;
  }

  dbg.label = plan.label;
  log(`Starte ${plan.label}`);
  const s = newSession(plan.label);
  root = active = s;
  try {
    if (plan.adapter.kind === "stdio") {
      await s.spawnStdio(plan.adapter.cmd, plan.adapter.args, plan.cwd, plan.adapter.env);
    } else if (plan.adapter.kind === "tcp") {
      serverProcId = `${s.id}-server`;
      tcpPort = await invoke<number>("proc_spawn_tcp", { id: serverProcId, cmd: plan.adapter.cmd, args: plan.adapter.args, cwd: plan.cwd, env: plan.adapter.env ?? null });
      await s.connect(tcpPort);
    } else {
      tcpPort = plan.adapter.port;
      await s.connect(tcpPort);
    }
    dbg.status = "running";
    await launchSession(s, "launch", plan.launch);
  } catch (e) {
    log(`Debug-Start fehlgeschlagen: ${e instanceof Error ? e.message : e}`, "error");
    await stopDebugging();
  }
}

export async function stopDebugging() {
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
  sessions = [];
  root = active = null;
  tcpPort = null;
  serverProcId = null;
  configured.clear();
  initialized.clear();
  dbg.status = dbg.status === "idle" ? "idle" : "terminated";
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

export async function restartDebugging() {
  if (root?.capabilities.supportsRestartRequest && active === root) {
    await root.request("restart", {}).catch(() => {});
    return;
  }
  const file = lastPlan?.file;
  await stopDebugging();
  if (file && activeTab()?.path !== file) await openFile(file);
  await startDebugging();
}

// ------------------------------------------------------------------ stepping

const threadArgs = () => ({ threadId: dbg.threadId ?? dbg.threads[0]?.id ?? 1 });

async function step(cmd: "continue" | "next" | "stepIn" | "stepOut") {
  if (!active || dbg.status !== "stopped") return;
  dbg.status = "running";
  dbg.exec = null;
  refreshEditor();
  await active.request(cmd, threadArgs()).catch((e) => log(String(e), "error"));
}

export const continueRun = () => step("continue");
export const stepOver = () => step("next");
export const stepInto = () => step("stepIn");
export const stepOut = () => step("stepOut");
export async function pause() {
  if (active && dbg.status === "running") await active.request("pause", threadArgs()).catch((e) => log(String(e), "error"));
}

// ------------------------------------------------------------------ events

function onEvent(s: DapSession, ev: Json) {
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
      active = s;
      onStopped(s, b);
      break;
    case "continued":
      if (s === active) {
        dbg.status = "running";
        dbg.exec = null;
        refreshEditor();
      }
      break;
    case "exited":
      log(`Prozess beendet (Exit-Code ${b.exitCode})`, "info");
      break;
    case "terminated":
      if (s === root || !s.parent) {
        log("Debug-Sitzung beendet.");
        stopDebugging();
      }
      break;
    case "breakpoint":
      if (b.breakpoint?.source?.path && b.breakpoint.line) {
        const list = dbg.breakpoints[b.breakpoint.source.path];
        const bp = list?.find((x) => x.line === b.breakpoint.line);
        if (bp) {
          bp.verified = b.breakpoint.verified;
          refreshEditor();
        }
      }
      break;
  }
}

async function onReverse(s: DapSession, req: Json): Promise<Json> {
  const a = req.arguments ?? {};
  if (req.command === "runInTerminal") {
    const env = Object.entries(a.env ?? {})
      .map(([k, v]) => (v === null ? `-u ${k}` : `${k}=${shellQuote(String(v))}`))
      .join(" ");
    const cmd = `${env ? `env ${env} ` : ""}${(a.args as string[]).map(shellQuote).join(" ")}`;
    runCommand(cmd, a.cwd || null, `Debug: ${dbg.label}`, false);
    return {};
  }
  if (req.command === "startDebugging") {
    // js-debug: child sessions connect to the same adapter port.
    if (!tcpPort) throw new Error("startDebugging ohne TCP-Adapter");
    const child = newSession(a.configuration?.name ?? "Kind");
    child.parent = s;
    await child.connect(tcpPort);
    launchSession(child, a.request ?? "launch", a.configuration).catch((e) => log(String(e), "error"));
    return {};
  }
  throw new Error(`Nicht unterstützt: ${req.command}`);
}

function onExit(s: DapSession) {
  sessions = sessions.filter((x) => x !== s);
  if (s === root) {
    if (dbg.status !== "terminated") log("Debug-Adapter beendet.");
    if (serverProcId) invoke("proc_kill", { id: serverProcId });
    cleanup();
  }
}

// ------------------------------------------------------------------ stopped state

const REASONS: Record<string, string> = {
  breakpoint: "Breakpoint",
  step: "Schritt",
  pause: "Pausiert",
  exception: "Ausnahme",
  entry: "Programmstart",
  "function breakpoint": "Funktions-Breakpoint",
  "data breakpoint": "Daten-Breakpoint",
  goto: "Sprung",
};

async function onStopped(s: DapSession, b: Json) {
  dbg.status = "stopped";
  dbg.stopReason = REASONS[b.reason] ?? b.reason ?? "";
  if (b.reason === "exception" && b.text) log(`Ausnahme: ${b.text}`, "error");
  try {
    dbg.threads = (await s.request("threads")).threads ?? [];
  } catch {
    dbg.threads = [];
  }
  dbg.threadId = b.threadId ?? dbg.threads[0]?.id ?? null;
  await loadStack();
}

export async function selectThread(id: number) {
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
  dbg.frames = frames.map(
    (f): Frame => ({
      id: f.id,
      name: f.name,
      path: f.source?.path ?? null,
      line: f.line,
      column: f.column,
      subtle: f.presentationHint === "subtle" || f.source?.presentationHint === "deemphasize" || !f.source?.path,
    }),
  );
  const first = dbg.frames.find((f) => !f.subtle) ?? dbg.frames[0];
  if (first) await selectFrame(first);
}

export async function selectFrame(f: Frame) {
  if (!active) return;
  dbg.frameId = f.id;
  if (f.path) {
    dbg.exec = { path: f.path, line: f.line };
    if (activeTab()?.path !== f.path) await openFile(f.path);
    const view = ed.getView();
    if (view && f.line <= view.state.doc.lines) {
      const line = view.state.doc.line(f.line);
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    }
  } else dbg.exec = null;
  refreshEditor();
  const prev = new Map(flatten(dbg.scopes).map((n) => [path(n), n.value]));
  try {
    const scopes: Json[] = (await active.request("scopes", { frameId: f.id })).scopes ?? [];
    dbg.scopes = scopes.map((sc) => ({ name: sc.name, value: "", ref: sc.variablesReference, parentRef: 0, children: null, expanded: false }));
    // Expand the first (cheap) scope like PyCharm does.
    const firstScope = dbg.scopes.find((_, i) => !scopes[i].expensive);
    if (firstScope) await toggleNode(firstScope);
    markChanged(prev);
  } catch (e) {
    log(String(e), "error");
  }
  await evaluateWatches();
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

async function fetchVars(ref: number, prefix: string): Promise<VarNode[]> {
  if (!active || !ref) return [];
  const vars: Json[] = (await active.request("variables", { variablesReference: ref })).variables ?? [];
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
  if (!active?.capabilities.supportsSetVariable) return ui.toast("Der Debugger unterstützt kein Ändern von Variablen", "error");
  try {
    const r = await active.request("setVariable", { variablesReference: n.parentRef, name: n.name, value });
    n.value = r.value;
    n.changed = true;
    await evaluateWatches();
  } catch (e) {
    ui.toast(String(e instanceof Error ? e.message : e), "error");
  }
}

// ------------------------------------------------------------------ watches & console

export async function evaluate(expression: string, context: "watch" | "repl" | "hover") {
  if (!active) throw new Error("Keine Debug-Sitzung");
  return active.request("evaluate", { expression, frameId: dbg.frameId ?? undefined, context });
}

export async function evaluateWatches() {
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
  log(`› ${expr}`, "input");
  try {
    const r = await evaluate(expr, "repl");
    log(r.result, "result");
    await evaluateWatches();
  } catch (e) {
    log(String(e instanceof Error ? e.message : e), "error");
  }
}

/** Hover in the editor while stopped: evaluates the expression under the mouse. */
export async function hoverValue(expr: string): Promise<string | null> {
  if (dbg.status !== "stopped" || !active) return null;
  try {
    const r = await evaluate(expr, "hover");
    return r.result;
  } catch {
    return null;
  }
}

function resetPause() {
  dbg.stopReason = "";
  dbg.threads = [];
  dbg.frames = [];
  dbg.scopes = [];
  dbg.exec = null;
}
