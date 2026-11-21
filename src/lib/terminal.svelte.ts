/** Terminal sessions (PTY in Rust, xterm.js in the UI). Sessions survive mode switches. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "./native";
import "@xterm/xterm/css/xterm.css";
import { t, i18n } from "./i18n/index.svelte";
import { q, IS_MAC } from "./platform";
import { showView, hideView, toggleView } from "./layout.svelte";

/** Set by the command registry: true if the key is an app shortcut that should bypass the shell. */
let terminalKeyFilter: (e: KeyboardEvent) => boolean = () => false;
export function setTerminalKeyFilter(fn: typeof terminalKeyFilter) {
  terminalKeyFilter = fn;
}

/** "build"/"run": one command per start (see `runTask`); "remote": mirror of the collab host's Run terminal (no local shell). */
export type TermKind = "shell" | "build" | "run" | "remote";
/** State of a Build/Run tab's last command. */
export type TaskStatus = "running" | "ok" | "fail" | "stopped";

export interface TermTab {
  id: string;
  title: string;
  kind: TermKind;
  exited: boolean;
  /** build/run: state and exit code of the last command. */
  status?: TaskStatus;
  code?: number | null;
  /** build/run: identifies the current command, a higher number is a later start. */
  taskId?: number;
}

// Where and whether the terminal view is shown is managed by layout.svelte.ts.
export const terms = $state({
  tabs: [] as TermTab[],
  active: null as string | null,
  /** true: all terminals side by side (sharing the space); false: one terminal at a time (tabs). */
  split: localStorage.getItem("termSplit") === "true",
});

export function toggleSplit() {
  terms.split = !terms.split;
  localStorage.setItem("termSplit", String(terms.split));
}

export interface ShellInfo {
  id: string;
  label: string;
}

let shellList: Promise<ShellInfo[]> | null = null;
/** Available shells (first = system default). */
export const listShells = () => (shellList ??= invoke<ShellInfo[]>("list_shells").catch(() => []));

/** Shell for new terminals ("" = system default); persisted. */
export const shellPref = $state({ id: localStorage.getItem("terminalShell") ?? "" });
export function setDefaultShell(id: string) {
  shellPref.id = id;
  localStorage.setItem("terminalShell", id);
}

interface Instance {
  kind: TermKind;
  /** Id of the PTY currently behind this tab (a Build/Run tab gets a new one per command). */
  pty: string;
  /** build/run: command of the current start, when it started, and what happens when it ends. */
  task?: { cmd: string; started: number; stopRequested: boolean; onExit?: (code: number | null) => void };
  /** remote: where typed input goes (the host's Run terminal). */
  onInput?: (data: string) => void;
  shell: string | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  spawned: boolean;
  cwd: string | null;
  pending: string[];
}
const instances = new Map<string, Instance>();
/** PTY id → tab id. */
const ptyTab = new Map<string, string>();
const ptyOf = (id: string) => instances.get(id)?.pty ?? id;

/**
 * Called after a tool install changed the effective PATH. Build/Run commands get a fresh process
 * (and so the new PATH) every time; open shells keep theirs, like in any terminal.
 */
export function pathChanged() {}
let counter = 1;

const decoder = new Map<string, TextDecoder>();
listen<{ id: string; data: string }>("pty-data", (e) => {
  const tid = ptyTab.get(e.payload.id);
  const inst = tid ? instances.get(tid) : undefined;
  if (!inst) return;
  const bin = Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0));
  let d = decoder.get(e.payload.id);
  if (!d) decoder.set(e.payload.id, (d = new TextDecoder()));
  inst.term.write(d.decode(bin, { stream: true }));
});
listen<{ id: string; code: number | null }>("pty-exit", (e) => {
  const tid = ptyTab.get(e.payload.id);
  ptyTab.delete(e.payload.id);
  decoder.delete(e.payload.id);
  const inst = tid ? instances.get(tid) : undefined;
  const tab = terms.tabs.find((t) => t.id === tid);
  if (!inst || !tab || inst.pty !== e.payload.id) return;
  if (inst.task) return finishTask(tab, inst, e.payload.code);
  tab.exited = true;
  inst.term.write(`\r\n\x1b[90m${t("code.term.exited")}\x1b[0m\r\n`);
});

const theme = {
  background: "rgba(0,0,0,0)",
  foreground: "#e8e8ed",
  cursor: "#6b9be0",
  cursorAccent: "#000000",
  selectionBackground: "rgba(107, 155, 224,0.35)",
  black: "#1c1c1e", red: "#df7067", green: "#7bbf8e", yellow: "#d8c27a",
  blue: "#6b9be0", magenta: "#a993d6", cyan: "#86b9cc", white: "#e5e5ea",
  brightBlack: "#636366", brightRed: "#e08a83", brightGreen: "#94c9a2", brightYellow: "#ddd09a",
  brightBlue: "#8fb2e6", brightMagenta: "#c0aee0", brightCyan: "#a7cbd8", brightWhite: "#ffffff",
};

const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

/** Applies a 16-colour palette (from the syntax theme) and the appearance's base colours to all current and future terminals. */
export function setTerminalPalette(ansi: string[], appearance: "dark" | "light" = "dark") {
  const light = appearance === "light";
  const t: Record<string, string> = {
    ...theme,
    foreground: light ? "#1d1d1f" : "#e8e8ed",
    cursor: light ? "#3478f6" : "#6b9be0",
    cursorAccent: light ? "#ffffff" : "#000000",
    selectionBackground: light ? "rgba(52, 120, 246, 0.25)" : "rgba(107, 155, 224,0.35)",
  };
  ANSI_KEYS.forEach((k, i) => (t[k] = ansi[i]));
  Object.assign(theme, t);
  for (const inst of instances.values()) inst.term.options.theme = { ...theme };
}

let fontSize = 13;
export function setTerminalFontSize(px: number) {
  fontSize = px;
  for (const [id, inst] of instances) {
    inst.term.options.fontSize = px;
    fitTerm(id);
  }
}

/** Shells left over from a previous page load are ended before the first new one starts. */
const leftoversKilled = invoke("pty_kill_all").catch(() => {});

export function newTerminal(cwd: string | null, kind: TermKind = "shell", title?: string, shell?: ShellInfo): string {
  const id = `t${Date.now().toString(36)}${counter}`;
  const term = new Terminal({
    fontFamily: '"JetBrains Mono Variable", "JetBrainsMono Nerd Font", monospace',
    fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "bar",
    allowTransparency: true,
    scrollback: 10000,
    theme: { ...theme },
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, uri) => openUrl(uri)));
  // Ctrl+Shift+C / V copy & paste like other Linux terminals; Ctrl+C stays SIGINT.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    // macOS: Cmd+C / Cmd+V like Terminal.app.
    if (IS_MAC && e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (IS_MAC && e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "v") {
      navigator.clipboard.readText().then((t) => invoke("pty_write", { id: ptyOf(id), data: t }));
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
      navigator.clipboard.readText().then((t) => invoke("pty_write", { id: ptyOf(id), data: t }));
      return false;
    }
    // App shortcuts that are allowed in the terminal (mode switch, terminal toggle, debugger keys …).
    if (terminalKeyFilter(e)) return false;
    return true;
  });
  term.onData((data) => {
    const inst = instances.get(id);
    if (inst?.kind === "remote") inst.onInput?.(data);
    else invoke("pty_write", { id: ptyOf(id), data }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => instances.get(id)?.kind !== "remote" && invoke("pty_resize", { id: ptyOf(id), cols, rows }).catch(() => {}));

  const el = document.createElement("div");
  el.className = "term-host";
  el.dataset.tid = id;
  instances.set(id, { kind, pty: id, shell: shell?.id ?? (shellPref.id || null), term, fit, el, spawned: false, cwd, pending: [] });
  ptyTab.set(id, id);
  // Lowest free number, so a fresh panel starts again at "Terminal 1".
  let n = 1;
  while (terms.tabs.some((t) => t.title === `Terminal ${n}`)) n++;
  terms.tabs.push({ id, title: title ?? (kind === "run" ? t("common.run") : kind === "build" ? t("code.act.build") : shell ? shell.label : `Terminal ${n}`), kind, exited: false });
  counter++;
  terms.active = id;
  showView("terminal");
  return id;
}

/** Attaches the xterm DOM to its container and starts the shell once it has a real size. */
export async function attach(id: string, container: HTMLElement, cwdFallback: string | null = null) {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.el.parentElement !== container) container.appendChild(inst.el);
  if (!inst.term.element) {
    await document.fonts.load('13px "JetBrains Mono Variable"').catch(() => {});
    inst.term.open(inst.el);
  }
  fitTerm(id);
  if (inst.kind === "remote") inst.spawned = true;
  if (!inst.spawned) {
    inst.spawned = true;
    await leftoversKilled;
    await invoke("pty_spawn", { id, cwd: inst.cwd ?? cwdFallback, cols: inst.term.cols, rows: inst.term.rows, kind: inst.kind, shell: inst.shell });
    for (const p of inst.pending) await invoke("pty_write", { id, data: p });
    inst.pending = [];
  }
}

export function fitTerm(id: string | null) {
  if (!id) return;
  const inst = instances.get(id);
  if (!inst?.term.element || !inst.el.isConnected || inst.el.clientHeight < 10) return;
  try {
    inst.fit.fit();
  } catch {
    /* not visible */
  }
}

export function focusTerm(id = terms.active) {
  if (id) instances.get(id)?.term.focus();
}

/** Kills a session and removes its tab; returns the tab's former index. */
function discardTerminal(id: string): number {
  const pty = ptyOf(id);
  invoke("pty_kill", { id: pty });
  ptyTab.delete(pty);
  instances.get(id)?.term.dispose();
  instances.get(id)?.el.remove();
  instances.delete(id);
  decoder.delete(pty);
  const i = terms.tabs.findIndex((t) => t.id === id);
  terms.tabs.splice(i, 1);
  return i;
}

export function closeTerminal(id: string) {
  const i = discardTerminal(id);
  if (terms.active === id) terms.active = terms.tabs[Math.max(0, i - 1)]?.id ?? null;
  // Closing the last terminal hides the panel instead of spawning a new shell.
  if (!terms.tabs.length) hideView("terminal");
}

// ------------------------------------------------------------------ Build / Run tabs

/** Collab host: also gets the lines Omega writes itself (command header, result line). */
let runEcho: ((text: string) => void) | null = null;
export function setRunEcho(fn: typeof runEcho) {
  runEcho = fn;
}
function echo(inst: Instance, text: string) {
  inst.term.write(text);
  runEcho?.(text);
}

const DIM = "\x1b[2m", RESET = "\x1b[0m";

function duration(ms: number): string {
  const nf = (n: number, digits = 0) => new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: digits }).format(n);
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${nf(ms / 1000, ms < 10_000 ? 1 : 0)} s`;
  return `${nf(Math.floor(ms / 60_000))} min ${nf(Math.round((ms % 60_000) / 1000))} s`;
}

function finishTask(tab: TermTab, inst: Instance, code: number | null) {
  const task = inst.task!;
  const time = duration(Date.now() - task.started);
  const status: TaskStatus = task.stopRequested || code === null ? "stopped" : code === 0 ? "ok" : "fail";
  tab.status = status;
  tab.code = code;
  const line =
    status === "ok" ? `\x1b[32m✓${RESET}${DIM} ${t("code.term.ok", { time })}` :
    status === "fail" ? `\x1b[31m✗ ${t("code.term.failed", { code: String(code), time })}` :
    `${DIM}■ ${t("code.term.stopped", { time })}`;
  // Nothing to type into any more: hide the cursor (term.reset() on the next start brings it back).
  echo(inst, `\r\n${line}${RESET}\r\n\x1b[?25l`);
  const next = task.onExit;
  task.onExit = undefined;
  next?.(status === "stopped" ? null : code);
}

/** Ends the current command of a Build/Run tab without a result line (it's being replaced). */
function dropTask(inst: Instance) {
  if (!inst.task) return;
  inst.task.onExit = undefined;
  const tab = terms.tabs.find((x) => instances.get(x.id) === inst);
  if (tab?.status !== "running") return;
  invoke("pty_kill", { id: inst.pty }).catch(() => {});
  ptyTab.delete(inst.pty);
}

/**
 * Runs one command in the "build" or "run" tab (created on demand, reused and cleared on every
 * start). The tab shows the command as a dim first line, then its output, then the exit code and
 * duration; its status (running / ✓ / ✗ / stopped) is shown in the tab bar. `onExit` gets the exit
 * code (null = stopped). Programs stay interactive: it's a real PTY.
 */
export function runTask(kind: "build" | "run", cmd: string, cwd: string | null, title: string, opts: { focus?: boolean; onExit?: (code: number | null) => void } = {}) {
  let tab = terms.tabs.find((x) => x.kind === kind);
  if (!tab) {
    const id = newTerminal(cwd, kind, title);
    tab = terms.tabs.find((x) => x.id === id)!;
    // Build stays left of Run.
    const run = terms.tabs.findIndex((x) => x.kind === "run");
    if (kind === "build" && run >= 0 && run < terms.tabs.indexOf(tab)) terms.tabs.splice(run, 0, ...terms.tabs.splice(terms.tabs.indexOf(tab), 1));
  }
  const inst = instances.get(tab.id)!;
  dropTask(inst);
  tab.title = title;
  tab.status = "running";
  tab.code = undefined;
  tab.exited = false;
  inst.cwd = cwd;
  inst.task = { cmd, started: Date.now(), stopRequested: false, onExit: opts.onExit };
  inst.term.reset();
  echo(inst, `${DIM}$ ${cmd.replace(/\r?\n/g, " ")}${RESET}\r\n`);
  terms.active = tab.id;
  showView("terminal");
  inst.spawned = true;
  const taskId = counter++;
  tab.taskId = taskId;
  const pty = `${tab.id}.${taskId}`;
  inst.pty = pty;
  ptyTab.set(pty, tab.id);
  const id = tab.id;
  leftoversKilled
    .then(() => invoke("pty_spawn", { id: pty, cwd, cols: inst.term.cols, rows: inst.term.rows, kind, shell: null, command: cmd }))
    .catch((e) => {
      if (inst.pty !== pty) return;
      ptyTab.delete(pty);
      echo(inst, `\x1b[31m${String(e)}${RESET}\r\n`);
      const tb = terms.tabs.find((x) => x.id === id);
      if (tb) finishTask(tb, inst, 127);
    });
  if (opts.focus ?? true) setTimeout(() => focusTerm(id), 50);
}

/** Runs a single command in the Run tab (installs, debuggee, new projects, AI …). */
export function runCommand(cmd: string, cwd: string | null, title = t("common.run"), focus = true) {
  runTask("run", cmd, cwd, title, { focus });
}

/** True while the Build or Run tab is busy. */
export const taskRunning = (kind?: "build" | "run") => terms.tabs.some((x) => (kind ? x.kind === kind : x.kind === "build" || x.kind === "run") && x.status === "running");

/** Stops a still running command of a Build/Run tab silently (a new start replaces it). */
export function cancelTask(kind: "build" | "run") {
  const tab = terms.tabs.find((x) => x.kind === kind);
  const inst = tab && instances.get(tab.id);
  if (!tab || !inst || tab.status !== "running") return;
  inst.task!.stopRequested = true;
  invoke("pty_kill", { id: inst.pty }).catch(() => {});
}

/** Collab guest: a terminal tab that shows the host's Run output; typing goes to `onInput`. */
export function remoteTerminal(title: string, onInput: (data: string) => void): string {
  const id = newTerminal(null, "remote", title);
  instances.get(id)!.onInput = onInput;
  return id;
}

/** Writes output into a terminal (remote mirrors). */
export function writeTerminal(id: string, data: string) {
  instances.get(id)?.term.write(data);
}

/** Id of the Run terminal tab, if any. */
export const runTerminalId = () => terms.tabs.find((t) => t.kind === "run")?.id ?? null;

/** Collab host: whether PTY output belongs to the Build or Run tab (mirrored to guests). */
export const isTaskPty = (pty: string) => {
  const tab = terms.tabs.find((x) => x.id === ptyTab.get(pty));
  return tab?.kind === "build" || tab?.kind === "run";
};

/** Sends input to a terminal tab: its shell, or the program running in a Build/Run tab (own PTY per run). */
export function sendInput(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id: ptyOf(id), data });
}

/** Sends input to the program in the Run tab (collab guests type here). */
export function writeRun(data: string) {
  const id = runTerminalId();
  if (id) invoke("pty_write", { id: ptyOf(id), data }).catch(() => {});
}

/** The command Stop applies to: a running Build first, then Run. */
const runningTaskTab = () => terms.tabs.find((x) => x.kind === "build" && x.status === "running") ?? terms.tabs.find((x) => x.kind === "run" && x.status === "running");

/** Stop: Ctrl+C to the running Build or Run command (the result line then says "stopped"). */
export function interruptRun() {
  const tab = runningTaskTab();
  const inst = tab && instances.get(tab.id);
  if (!inst?.task) return;
  inst.task.stopRequested = true;
  invoke("pty_write", { id: inst.pty, data: "\x03" }).catch(() => {});
}

/** Stops the running command only if it still is `taskId`, so a late Stop can't hit a newer run. */
export function interruptTask(taskId: number): boolean {
  if (runningTaskTab()?.taskId !== taskId) return false;
  interruptRun();
  return true;
}

export interface TaskState {
  running: boolean;
  kind: "build" | "run" | null;
  taskId: number | null;
  status: TaskStatus | null;
}

/** The command Stop would hit, or else the latest one. Reactive. */
export function taskState(): TaskState {
  const latest = terms.tabs.filter((x) => (x.kind === "build" || x.kind === "run") && x.taskId !== undefined).sort((a, b) => b.taskId! - a.taskId!)[0];
  const tab = runningTaskTab() ?? latest;
  if (!tab) return { running: false, kind: null, taskId: null, status: null };
  return { running: tab.status === "running", kind: tab.kind as "build" | "run", taskId: tab.taskId ?? null, status: tab.status ?? null };
}

/** Quotes for the Run terminal's shell (POSIX sh, or cmd.exe on Windows). */
export const shellQuote = q;

export function toggleTerminal() {
  toggleView("terminal");
}

/** Last `lines` lines of a terminal's buffer (for the control MCP). */
export function readTerminal(id = terms.active, lines = 60): string {
  const inst = id ? instances.get(id) : null;
  if (!inst) return "";
  const buf = inst.term.buffer.active;
  const out: string[] = [];
  const end = buf.baseY + buf.cursorY;
  for (let i = Math.max(0, end - lines + 1); i <= end; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  return out.join("\n").replace(/\n+$/, "");
}

/** Opens a new shell tab and runs a command in it (e.g. `claude`). */
export function newTerminalWith(cmd: string, cwd: string | null, title: string): string {
  const id = newTerminal(cwd, "shell", title);
  instances.get(id)!.pending.push(`${cmd}\r`);
  setTimeout(() => focusTerm(id), 80);
  return id;
}
