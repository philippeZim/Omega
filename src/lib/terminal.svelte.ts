/** Terminal sessions (PTY in Rust, xterm.js in the UI). Sessions survive mode switches. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { t } from "./i18n/index.svelte";
import { q, cd, CLEAR_LINE, IS_MAC } from "./platform";

/** Set by the command registry: true if the key is an app shortcut that should bypass the shell. */
let terminalKeyFilter: (e: KeyboardEvent) => boolean = () => false;
export function setTerminalKeyFilter(fn: typeof terminalKeyFilter) {
  terminalKeyFilter = fn;
}

export interface TermTab {
  id: string;
  title: string;
  kind: "shell" | "run";
  exited: boolean;
}

export const terms = $state({
  tabs: [] as TermTab[],
  active: null as string | null,
  height: Number(localStorage.getItem("termHeight")) || 260,
  visible: localStorage.getItem("termVisible") !== "false",
});

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
  kind: "shell" | "run";
  shell: string | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  spawned: boolean;
  cwd: string | null;
  pending: string[];
  /** Directory the last run command cd'ed into (avoids repeating long cd prefixes). */
  runDir?: string | null;
}
const instances = new Map<string, Instance>();
let counter = 1;

const decoder = new Map<string, TextDecoder>();
listen<{ id: string; data: string }>("pty-data", (e) => {
  const inst = instances.get(e.payload.id);
  if (!inst) return;
  const bin = Uint8Array.from(atob(e.payload.data), (c) => c.charCodeAt(0));
  let d = decoder.get(e.payload.id);
  if (!d) decoder.set(e.payload.id, (d = new TextDecoder()));
  inst.term.write(d.decode(bin, { stream: true }));
});
listen<string>("pty-exit", (e) => {
  const tab = terms.tabs.find((t) => t.id === e.payload);
  if (tab) tab.exited = true;
  instances.get(e.payload)?.term.write(`\r\n\x1b[90m${t("code.term.exited")}\x1b[0m\r\n`);
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

export function newTerminal(cwd: string | null, kind: "shell" | "run" = "shell", title?: string, shell?: ShellInfo): string {
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
      navigator.clipboard.readText().then((t) => invoke("pty_write", { id, data: t }));
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
      navigator.clipboard.readText().then((t) => invoke("pty_write", { id, data: t }));
      return false;
    }
    // App shortcuts that are allowed in the terminal (mode switch, terminal toggle, debugger keys …).
    if (terminalKeyFilter(e)) return false;
    return true;
  });
  term.onData((data) => invoke("pty_write", { id, data }).catch(() => {}));
  term.onResize(({ cols, rows }) => invoke("pty_resize", { id, cols, rows }).catch(() => {}));

  const el = document.createElement("div");
  el.className = "term-host";
  el.dataset.tid = id;
  instances.set(id, { kind, shell: shell?.id ?? (shellPref.id || null), term, fit, el, spawned: false, cwd, pending: [] });
  // Lowest free number, so a fresh panel starts again at "Terminal 1".
  let n = 1;
  while (terms.tabs.some((t) => t.title === `Terminal ${n}`)) n++;
  terms.tabs.push({ id, title: title ?? (kind === "run" ? t("common.run") : shell ? shell.label : `Terminal ${n}`), kind, exited: false });
  counter++;
  terms.active = id;
  terms.visible = true;
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

export function closeTerminal(id: string) {
  invoke("pty_kill", { id });
  instances.get(id)?.term.dispose();
  instances.get(id)?.el.remove();
  instances.delete(id);
  decoder.delete(id);
  const i = terms.tabs.findIndex((t) => t.id === id);
  terms.tabs.splice(i, 1);
  if (terms.active === id) terms.active = terms.tabs[Math.max(0, i - 1)]?.id ?? null;
  // Closing the last terminal hides the panel instead of spawning a new shell.
  if (!terms.tabs.length && terms.visible) toggleTerminal();
}

/** Runs a command in the shared "Run" terminal (created on demand) so programs stay interactive. */
export function runCommand(cmd: string, cwd: string | null, title = t("common.run"), focus = true) {
  let tab = terms.tabs.find((t) => t.kind === "run" && !t.exited);
  if (!tab) {
    const id = newTerminal(cwd, "run", title);
    tab = terms.tabs.find((t) => t.id === id)!;
  }
  tab.title = title;
  terms.active = tab.id;
  terms.visible = true;
  const inst = instances.get(tab.id)!;
  inst.runDir ??= inst.cwd;
  // Ctrl+U (Esc in cmd.exe) clears whatever is typed at the prompt; cd only when the project dir changed.
  const needCd = cwd && cwd !== inst.runDir;
  if (cwd) inst.runDir = cwd;
  const line = `${CLEAR_LINE}${needCd ? `${cd(cwd!)} && ` : ""}${cmd}\r`;
  if (inst.spawned) invoke("pty_write", { id: tab.id, data: line });
  else inst.pending.push(line);
  if (focus) setTimeout(() => focusTerm(tab!.id), 50);
}

/** Sends raw input (e.g. Ctrl+C) to the run terminal. */
export function interruptRun() {
  const tab = terms.tabs.find((t) => t.kind === "run" && !t.exited);
  if (tab) invoke("pty_write", { id: tab.id, data: "\x03" });
}

/** Quotes for the Run terminal's shell (POSIX sh, or cmd.exe on Windows). */
export const shellQuote = q;

export function setHeight(h: number) {
  terms.height = h;
  localStorage.setItem("termHeight", String(h));
}

export function toggleTerminal() {
  terms.visible = !terms.visible;
  localStorage.setItem("termVisible", String(terms.visible));
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
