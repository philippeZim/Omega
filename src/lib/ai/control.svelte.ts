/**
 * Control MCP tools: let AI agents operate the running app (state, commands, files, editor,
 * clicking, typing, screenshots, console, terminal). Executed here, transported by mcp_control.rs.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toPng } from "html-to-image";
import { app, activeTab, openFile, save, setMode } from "../state.svelte";
import { ui } from "../ui.svelte";
import * as ed from "../editor";
import { fsApi } from "../api";
import { COMMANDS, keysFor, runCommand, availableCommands, palette } from "../commands.svelte";
import { formatKey } from "../keys";
import { git } from "../git/git.svelte";
import { dbg } from "../debug/store.svelte";
import { collab } from "../collab/collab.svelte";
import { terms, readTerminal, runCommand as runInTerminal } from "../terminal.svelte";
import { runner } from "../code/runner.svelte";
import { find } from "../search/search.svelte";
import { settings } from "../settings.svelte";
import type { Mode } from "../modes";

// ------------------------------------------------------------------ console capture

const consoleLog: { level: string; text: string; time: string }[] = [];
function capture(level: string, args: unknown[]) {
  const text = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : safeJson(a))).join(" ");
  consoleLog.push({ level, text: text.slice(0, 4000), time: new Date().toISOString().slice(11, 19) });
  if (consoleLog.length > 300) consoleLog.shift();
}
const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
for (const level of ["error", "warn", "log", "info"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    capture(level, args);
    orig(...args);
  };
}
window.addEventListener("error", (e) => capture("error", [e.message, e.error?.stack ?? ""]));
window.addEventListener("unhandledrejection", (e) => capture("error", ["Unhandled rejection:", e.reason]));

// Recent toasts (what the user saw).
const toastLog: { text: string; kind: string; time: string }[] = [];
const origToast = ui.toast.bind(ui);
ui.toast = (text: string, kind: "info" | "error" = "info") => {
  toastLog.push({ text, kind, time: new Date().toISOString().slice(11, 19) });
  if (toastLog.length > 50) toastLog.shift();
  origToast(text, kind);
};

// ------------------------------------------------------------------ UI helpers

const INTERACTIVE = "button, a, input, textarea, select, [role=button], [role=tab], [role=menuitem], [role=treeitem], [role=switch], [role=checkbox], [contenteditable=true], .row, .item, .hit, .chip, .tab";

function visible(el: Element) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
}

function labelOf(el: Element): string {
  const h = el as HTMLElement;
  return (
    h.getAttribute("aria-label") ||
    h.dataset.tip ||
    h.getAttribute("title") ||
    (h as HTMLInputElement).placeholder ||
    h.innerText ||
    h.textContent ||
    ""
  ).replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Finds elements by visible text / aria-label / tooltip (case-insensitive) or CSS selector. */
function findElements(opts: { text?: string; selector?: string; exact?: boolean }): HTMLElement[] {
  let els: HTMLElement[];
  if (opts.selector) els = [...document.querySelectorAll<HTMLElement>(opts.selector)];
  else els = [...document.querySelectorAll<HTMLElement>(INTERACTIVE)];
  els = els.filter(visible);
  if (opts.text) {
    const q = opts.text.toLowerCase().trim();
    const match = (el: HTMLElement) => {
      const l = labelOf(el).toLowerCase();
      return opts.exact ? l === q : l.includes(q);
    };
    els = els.filter(match);
    // Prefer the innermost matching element (a button inside a matching row, not the row).
    els = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
    // Exact matches first.
    els.sort((a, b) => Number(labelOf(b).toLowerCase() === q) - Number(labelOf(a).toLowerCase() === q));
  }
  return els;
}

function describe(el: HTMLElement, i: number) {
  const r = el.getBoundingClientRect();
  return {
    index: i,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role") ?? undefined,
    label: labelOf(el),
    disabled: (el as HTMLButtonElement).disabled || undefined,
    checked: el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected") ?? undefined,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
}

function clickElement(el: HTMLElement, double = false) {
  el.scrollIntoView({ block: "nearest" });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  if (el.matches("input, textarea, [contenteditable=true]")) el.focus();
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  if (double) el.dispatchEvent(new MouseEvent("dblclick", opts));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function editorInfo() {
  const v = ed.getView();
  const t = activeTab();
  if (!v || !t) return null;
  const s = v.state.selection.main;
  const line = v.state.doc.lineAt(s.head);
  return { path: t.path, name: t.name, lines: v.state.doc.lines, cursor: { line: line.number, column: s.head - line.from + 1 }, selection: s.empty ? "" : v.state.sliceDoc(s.from, s.to) };
}

function posOf(line?: number, column?: number) {
  const v = ed.getView()!;
  const l = v.state.doc.line(Math.max(1, Math.min(line ?? v.state.doc.lines, v.state.doc.lines)));
  return Math.min(l.to, l.from + Math.max(0, (column ?? l.length + 1) - 1));
}

// ------------------------------------------------------------------ tools

type Args = Record<string, any>;
interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run: (a: Args) => Promise<unknown> | unknown;
}

const obj = (props: Record<string, object>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

const TOOLS: Tool[] = [
  {
    name: "get_state",
    description: "Aktueller Zustand der IDE: Modus, Projektordner, offene Tabs, aktiver Editor (Cursor, Auswahl), offene Panels/Dialoge, Git, Debugger, Terminal, Collab-Session, letzte Meldungen (Toasts).",
    inputSchema: obj({}),
    run: () => ({
      mode: app.mode,
      projectRoot: app.root,
      tabs: app.tabs.map((t) => ({ path: t.path, name: t.name, dirty: t.dirty, active: t.id === app.activeId })),
      editor: editorInfo(),
      sidebar: { visible: app.sidebar, view: app.sidebarView },
      overlays: {
        help: ui.help, settings: settings.open, palette: palette.open ? palette.tab : false, findInFiles: find.open, newProject: runner.newProject,
        dialog: ui.dialog ? { title: ui.dialog.title, message: ui.dialog.message, buttons: ui.dialog.options.map((o) => o.label), input: ui.dialog.input?.value } : null,
        contextMenu: ui.menu ? ui.menu.items.filter((i) => !i.separator).map((i) => i.label) : null,
        collabPanel: collab.open,
      },
      project: runner.project ? { tool: runner.project.label, root: runner.project.root, run: runner.project.run?.cmd, build: runner.project.build?.cmd } : null,
      git: git.repo ? { branch: git.branch, ahead: git.ahead, behind: git.behind, remote: git.remoteUrl, changes: git.changes.map((c) => `${c.x}${c.y} ${c.path}`) } : null,
      debugger: { status: dbg.status, label: dbg.label, stopReason: dbg.stopReason, location: dbg.exec, panel: dbg.panel },
      terminal: { visible: terms.visible, tabs: terms.tabs.map((t) => ({ id: t.id, title: t.title, kind: t.kind, exited: t.exited, active: t.id === terms.active })) },
      collab: collab.role ? { role: collab.role, status: collab.status, participants: collab.participants.map((p) => ({ name: p.name, role: p.role, direct: p.direct, rtt: p.rtt })), pendingRequests: collab.requests.map((r) => r.name) } : null,
      recentToasts: toastLog.slice(-8),
    }),
  },
  {
    name: "list_commands",
    description: "Alle Befehle der IDE (ID, Beschriftung, Gruppe, Tastenkürzel, ob gerade verfügbar). IDs für run_command.",
    inputSchema: obj({ filter: str("Optionaler Suchtext") }),
    run: ({ filter }) => {
      const avail = new Set(availableCommands().map((c) => c.id));
      const q = (filter ?? "").toLowerCase();
      return COMMANDS.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q)).map((c) => ({ id: c.id, label: c.label, group: c.group, keys: keysFor(c.id).map(formatKey), available: avail.has(c.id) }));
    },
  },
  {
    name: "run_command",
    description: "Führt einen IDE-Befehl per ID aus (siehe list_commands), z.B. 'search.inFiles', 'run.run', 'debug.start', 'git.commit', 'mode.markdown'.",
    inputSchema: obj({ id: str("Befehls-ID") }, ["id"]),
    run: async ({ id }) => {
      if (!COMMANDS.some((c) => c.id === id)) throw new Error(`Unbekannter Befehl: ${id}`);
      runCommand(id);
      await sleep(150);
      return `ausgeführt: ${id}`;
    },
  },
  {
    name: "set_mode",
    description: "Wechselt den Modus: text, markdown, latex oder code.",
    inputSchema: obj({ mode: { type: "string", enum: ["text", "markdown", "latex", "code"] } }, ["mode"]),
    run: ({ mode }) => (setMode(mode as Mode), `Modus: ${mode}`),
  },
  {
    name: "open_file",
    description: "Öffnet eine Datei (absoluter Pfad oder relativ zum Projektordner) als Tab, optional an einer Zeile.",
    inputSchema: obj({ path: str("Dateipfad"), line: num("Zeile (1-basiert)") }, ["path"]),
    run: async ({ path, line }) => {
      const abs = path.startsWith("/") ? path : `${app.root}/${path}`;
      await openFile(abs);
      if (line) {
        const v = ed.getView();
        v?.dispatch({ selection: { anchor: posOf(line, 1) }, scrollIntoView: true });
      }
      return editorInfo();
    },
  },
  {
    name: "get_editor_text",
    description: "Inhalt des aktiven Editors (oder eines offenen Tabs per Pfad) mit Cursor/Auswahl. Optional nur Zeilenbereich.",
    inputSchema: obj({ path: str("Pfad eines offenen Tabs (optional)"), fromLine: num("ab Zeile"), toLine: num("bis Zeile") }),
    run: ({ path, fromLine, toLine }) => {
      const tab = path ? app.tabs.find((t) => t.path === path || t.path?.endsWith("/" + path)) : activeTab();
      if (!tab) throw new Error("Kein passender Tab offen");
      let text = ed.getText(tab.id);
      if (fromLine || toLine) text = text.split("\n").slice((fromLine ?? 1) - 1, toLine ?? undefined).join("\n");
      return { path: tab.path, dirty: tab.dirty, ...(tab.id === app.activeId ? { editor: editorInfo() } : {}), text };
    },
  },
  {
    name: "edit_text",
    description: "Bearbeitet den aktiven Editor wie ein Nutzer (mit Undo): 'insert' fügt an Cursor oder Position ein, 'replace' ersetzt den ersten Treffer von search, 'set' ersetzt alles.",
    inputSchema: obj({
      action: { type: "string", enum: ["insert", "replace", "set"] },
      text: str("Einzufügender/neuer Text"),
      search: str("Für replace: zu ersetzender Text"),
      line: num("Für insert: Zeile (1-basiert, optional)"),
      column: num("Für insert: Spalte (1-basiert, optional; Standard Zeilenende)"),
    }, ["action", "text"]),
    run: ({ action, text, search, line, column }) => {
      const v = ed.getView();
      if (!v || !activeTab()) throw new Error("Kein Editor aktiv");
      const doc = v.state.doc.toString();
      if (action === "set") v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, userEvent: "input" });
      else if (action === "replace") {
        const i = doc.indexOf(search ?? "");
        if (!search || i < 0) throw new Error("Suchtext nicht gefunden");
        v.dispatch({ changes: { from: i, to: i + search.length, insert: text }, selection: { anchor: i + text.length }, userEvent: "input" });
      } else {
        const at = line ? posOf(line, column) : v.state.selection.main.head;
        v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
      }
      return editorInfo();
    },
  },
  {
    name: "set_cursor",
    description: "Setzt Cursor oder Auswahl im aktiven Editor (1-basierte Zeilen/Spalten) und fokussiert ihn.",
    inputSchema: obj({ line: num("Zeile"), column: num("Spalte"), toLine: num("Auswahl bis Zeile"), toColumn: num("Auswahl bis Spalte") }, ["line"]),
    run: ({ line, column, toLine, toColumn }) => {
      const v = ed.getView();
      if (!v) throw new Error("Kein Editor aktiv");
      const anchor = posOf(line, column ?? 1);
      const head = toLine ? posOf(toLine, toColumn) : anchor;
      v.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      v.focus();
      return editorInfo();
    },
  },
  {
    name: "save",
    description: "Speichert den aktiven Tab bzw. alle (passiert sonst automatisch).",
    inputSchema: obj({ all: bool("Alle geänderten Tabs speichern") }),
    run: async ({ all }) => {
      if (all) for (const t of app.tabs) if (t.dirty) await save(t.id);
      else await save();
      return "gespeichert";
    },
  },
  {
    name: "read_file",
    description: "Liest eine Datei von der Platte (absolut oder relativ zum Projektordner).",
    inputSchema: obj({ path: str("Dateipfad") }, ["path"]),
    run: ({ path }) => fsApi.readFile(path.startsWith("/") ? path : `${app.root}/${path}`),
  },
  {
    name: "write_file",
    description: "Schreibt eine Datei auf die Platte (offene Tabs laden automatisch nach).",
    inputSchema: obj({ path: str("Dateipfad"), content: str("Inhalt") }, ["path", "content"]),
    run: async ({ path, content }) => {
      const abs = path.startsWith("/") ? path : `${app.root}/${path}`;
      await fsApi.writeFile(abs, content);
      app.treeVersion++;
      const { syncFromDisk } = await import("../state.svelte");
      await syncFromDisk();
      return `geschrieben: ${abs}`;
    },
  },
  {
    name: "query_ui",
    description: "Listet sichtbare, bedienbare Elemente (Buttons, Tabs, Einträge, Eingabefelder) – optional gefiltert nach Text/Tooltip oder CSS-Selektor. Für click/type_text.",
    inputSchema: obj({ text: str("Text, aria-label oder Tooltip (Teilstring)"), selector: str("CSS-Selektor"), limit: num("max. Anzahl (Standard 60)") }),
    run: ({ text, selector, limit }) => findElements({ text, selector }).slice(0, limit ?? 60).map(describe),
  },
  {
    name: "click",
    description: "Klickt ein Element an, gefunden über sichtbaren Text, aria-label, Tooltip oder CSS-Selektor. Bei mehreren Treffern 'index' angeben.",
    inputSchema: obj({ text: str("Text/Label/Tooltip"), selector: str("CSS-Selektor"), index: num("Treffer-Index (Standard 0)"), double: bool("Doppelklick"), exact: bool("Text muss exakt passen") }),
    run: async ({ text, selector, index, double, exact }) => {
      const els = findElements({ text, selector, exact });
      const el = els[index ?? 0];
      if (!el) throw new Error(`Kein Element gefunden (${text ?? selector}). Treffer: ${els.length}`);
      const info = describe(el, index ?? 0);
      clickElement(el, double);
      await sleep(200);
      return { clicked: info, alternatives: els.length - 1 };
    },
  },
  {
    name: "type_text",
    description: "Gibt Text in das fokussierte Element ein (Eingabefeld oder Editor), optional vorher ein Element per Text/Selektor fokussieren. submit=true drückt danach Enter.",
    inputSchema: obj({ text: str("Text"), target: str("Optional: Element per Text/Placeholder fokussieren"), selector: str("Optional: CSS-Selektor"), submit: bool("Danach Enter drücken") }, ["text"]),
    run: async ({ text, target, selector, submit }) => {
      if (target || selector) {
        const el = findElements({ text: target, selector }).find((e) => e.matches("input, textarea, [contenteditable=true]")) ?? findElements({ text: target, selector })[0];
        if (!el) throw new Error("Zielelement nicht gefunden");
        el.focus();
      }
      const el = document.activeElement as HTMLElement | null;
      const v = ed.getView();
      const tid = focusedTerminal();
      if (tid) await invoke("pty_write", { id: tid, data: text });
      else if (v && el && v.dom.contains(el)) {
        const at = v.state.selection.main;
        v.dispatch({ changes: { from: at.from, to: at.to, insert: text }, selection: { anchor: at.from + text.length }, userEvent: "input.type" });
      } else if (el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        const start = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd ?? start);
        el.setSelectionRange(start + text.length, start + text.length);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      } else throw new Error("Kein Eingabefeld fokussiert");
      if (submit) await pressKey({ key: "Enter" });
      await sleep(120);
      return "eingegeben";
    },
  },
  {
    name: "press_key",
    description: "Drückt eine Taste/Kombination im fokussierten Element, z.B. key='Enter', 'Escape', 'ArrowDown', 'F9', 'p' mit ctrl+shift.",
    inputSchema: obj({ key: str("Taste (KeyboardEvent.key)"), ctrl: bool("Strg"), shift: bool("Umschalt"), alt: bool("Alt") }, ["key"]),
    run: (a) => pressKey(a),
  },
  {
    name: "wait_for",
    description: "Wartet, bis ein Element (Text/Selektor) sichtbar ist – oder mit gone=true verschwunden ist.",
    inputSchema: obj({ text: str("Text/Label"), selector: str("CSS-Selektor"), gone: bool("Auf Verschwinden warten"), timeoutMs: num("Standard 8000") }),
    run: async ({ text, selector, gone, timeoutMs }) => {
      const end = Date.now() + (timeoutMs ?? 8000);
      while (Date.now() < end) {
        const found = findElements({ text, selector }).length > 0;
        if (found !== !!gone) return { ok: true, waitedMs: (timeoutMs ?? 8000) - (end - Date.now()) };
        await sleep(100);
      }
      throw new Error("Zeitüberschreitung beim Warten");
    },
  },
  {
    name: "screenshot",
    description: "Screenshot des App-Inhalts (PNG) – ganzes Fenster oder ein Element per Selektor/Text.",
    inputSchema: obj({ selector: str("CSS-Selektor (optional)"), text: str("Element per Text (optional)"), scale: num("Skalierung, Standard 0.75") }),
    run: async ({ selector, text, scale }) => {
      const el = selector || text ? findElements({ selector, text })[0] : document.body;
      if (!el) throw new Error("Element nicht gefunden");
      const url = await toPng(el, { pixelRatio: scale ?? 0.75, cacheBust: true, backgroundColor: "#030304", filter: (n) => !(n instanceof HTMLElement && n.classList.contains("tip")) });
      return { __image: url.split(",")[1] };
    },
  },
  {
    name: "get_console",
    description: "Letzte Konsolenmeldungen der App (Fehler, Warnungen, Logs) inkl. unbehandelter Fehler.",
    inputSchema: obj({ level: { type: "string", enum: ["error", "warn", "log", "info", "all"] }, limit: num("Standard 40") }),
    run: ({ level, limit }) => consoleLog.filter((m) => !level || level === "all" || m.level === level).slice(-(limit ?? 40)),
  },
  {
    name: "terminal_run",
    description: "Führt einen Shell-Befehl im 'Ausführen'-Terminal der IDE aus (sichtbar für den Nutzer). Ausgabe danach mit terminal_read lesen.",
    inputSchema: obj({ command: str("Shell-Befehl"), cwd: str("Arbeitsverzeichnis (Standard: Projektordner)") }, ["command"]),
    run: ({ command, cwd }) => (runInTerminal(command, cwd ?? app.root, "KI: Befehl", false), "gestartet"),
  },
  {
    name: "terminal_write",
    description: "Schreibt Text direkt in ein Terminal (wie Tippen; Steuerzeichen erlaubt, z.B. \\r für Enter, \\x03 für Strg+C).",
    inputSchema: obj({ text: str("Text bzw. Steuerzeichen"), id: str("Terminal-ID aus get_state (Standard: aktives)"), enter: bool("Danach Enter senden") }, ["text"]),
    run: async ({ text, id, enter }) => {
      const tid = id ?? terms.active;
      if (!tid) throw new Error("Kein Terminal offen");
      await invoke("pty_write", { id: tid, data: text + (enter ? "\r" : "") });
      return `geschrieben an ${tid}`;
    },
  },
  {
    name: "terminal_read",
    description: "Liest die letzten Zeilen eines Terminals (Standard: aktives).",
    inputSchema: obj({ id: str("Terminal-ID aus get_state (optional)"), lines: num("Standard 60") }),
    run: ({ id, lines }) => readTerminal(id ?? terms.active, lines ?? 60),
  },
];

const TERM_KEYS: Record<string, string> = {
  Enter: "\r", Escape: "\x1b", Tab: "\t", Backspace: "\x7f", Delete: "\x1b[3~",
  ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
  Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
};

/** Terminal id if keyboard focus is inside a terminal (xterm ignores synthetic key events). */
function focusedTerminal(): string | null {
  const host = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".term-host");
  return host?.dataset.tid ?? null;
}

async function pressKey({ key, ctrl, shift, alt }: Args) {
  const tid = focusedTerminal();
  if (tid) {
    let seq = TERM_KEYS[key] ?? key;
    if (ctrl && key.length === 1) seq = String.fromCharCode(key.toUpperCase().charCodeAt(0) & 0x1f);
    if (alt) seq = "\x1b" + seq;
    await invoke("pty_write", { id: tid, data: seq });
    await sleep(150);
    return `an Terminal gesendet: ${[ctrl && "Strg", alt && "Alt", key].filter(Boolean).join("+")}`;
  }
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const init = { key, bubbles: true, cancelable: true, composed: true, ctrlKey: !!ctrl, shiftKey: !!shift, altKey: !!alt, code: key.length === 1 ? `Key${key.toUpperCase()}` : key };
  const down = new KeyboardEvent("keydown", init);
  target.dispatchEvent(down);
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  await sleep(150);
  return `gedrückt: ${[ctrl && "Strg", shift && "Umschalt", alt && "Alt", key].filter(Boolean).join("+")}`;
}

// ------------------------------------------------------------------ server lifecycle

export const control = $state({
  enabled: localStorage.getItem("mcp.control") === "true",
  port: Number(localStorage.getItem("mcp.port")) || 47821,
  token: localStorage.getItem("mcp.token") || "",
  running: false,
  error: "",
  calls: 0,
  lastTool: "",
});

function newToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
if (!control.token) {
  control.token = newToken();
  localStorage.setItem("mcp.token", control.token);
}

export async function startControl() {
  control.error = "";
  try {
    await invoke("mcp_control_start", { port: control.port, token: control.token, tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    control.running = true;
  } catch (e) {
    control.running = false;
    control.error = String(e);
  }
}

export async function setControlEnabled(on: boolean) {
  control.enabled = on;
  localStorage.setItem("mcp.control", String(on));
  if (on) await startControl();
  else {
    await invoke("mcp_control_stop");
    control.running = false;
  }
}

export async function regenerateToken() {
  control.token = newToken();
  localStorage.setItem("mcp.token", control.token);
  if (control.enabled) await startControl();
}

export async function setControlPort(p: number) {
  control.port = p;
  localStorage.setItem("mcp.port", String(p));
  if (control.enabled) await startControl();
}

const url = () => `http://127.0.0.1:${control.port}/mcp`;
/** Command that registers the control MCP in each agent (run once in a terminal). */
export const mcpAddCommand = (agent: "claude" | "codex" | "opencode") =>
  agent === "claude"
    ? `claude mcp add --scope user --transport http studio ${url()} --header "Authorization: Bearer ${control.token}"`
    : agent === "codex"
      ? // Codex reads the token from STUDIO_MCP_TOKEN (set in Studio's terminals).
        `codex mcp add studio --url ${url()} --bearer-token-env-var STUDIO_MCP_TOKEN`
      : `opencode mcp add studio --url ${url()} --header "Authorization=Bearer ${control.token}" --global`;
export const claudeAddCommand = () => mcpAddCommand("claude");

listen<{ call: number; name: string; args: Args }>("mcp-call", async (e) => {
  const { call, name, args } = e.payload;
  const tool = TOOLS.find((t) => t.name === name);
  control.calls++;
  control.lastTool = name;
  let result: object;
  try {
    if (!tool) throw new Error(`Unbekanntes Werkzeug: ${name}`);
    const out: any = await tool.run(args ?? {});
    if (out && typeof out === "object" && "__image" in out) result = { content: [{ type: "image", data: out.__image, mimeType: "image/png" }] };
    else result = { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] };
  } catch (err) {
    result = { content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }], isError: true };
  }
  invoke("mcp_reply", { call, result });
});

if (control.enabled) startControl();

// Event listeners/intervals live at module level → full reload instead of duplicate HMR instances.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
