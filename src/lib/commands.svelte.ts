/**
 * Central command registry. Every shortcut in the app is a command with default keys that the
 * user can override (Einstellungen → Tastenkürzel). Used by the global key handler, the editor,
 * the command palette and the Shortcuts cheat sheet.
 */
import type { EditorView } from "@codemirror/view";
import { candidates, normalize } from "./keys";
import { EDITOR_COMMANDS } from "./editorCommands";
import * as ed from "./editor";
import { app, newFile, save, openFolder, closeTab, setMode, cycleTab, toggleSpell, reopenClosedTab } from "./state.svelte";
import { ui } from "./ui.svelte";
import { settings, setSize } from "./settings.svelte";
import { runner, runAction, stopRun } from "./code/runner.svelte";
import * as debug from "./debug/debugger.svelte";
import { dbg } from "./debug/store.svelte";
import { terms, toggleTerminal, focusTerm, setTerminalKeyFilter } from "./terminal.svelte";
import { forwardSync } from "./latex/controller.svelte";
import { openFind } from "./search/search.svelte";
import { collab, startHosting, joinFromClipboard, approveNext, leave as leaveCollab } from "./collab/collab.svelte";
import { push as gitPush, pull as gitPull, newBranch, cloneRepo, publishGitHub, refresh as gitRefresh, connectRemote, initRepo } from "./git/git.svelte";
import { activeTab } from "./state.svelte";
import type { Mode } from "./modes";

export interface Command {
  id: string;
  label: string;
  group: string;
  keys: string[];
  /** "app" commands run anywhere; "editor" commands need the editor focused. */
  scope: "app" | "editor";
  run: (view?: EditorView) => unknown;
  modes?: Mode[];
  when?: () => boolean;
  /** Still active while the terminal has focus. */
  inTerminal?: boolean;
}

const debugging = () => dbg.status === "running" || dbg.status === "stopped" || dbg.status === "starting";

export type PaletteTab = "all" | "files" | "symbols" | "actions" | "text";
export const palette = $state({ open: false, tab: "all" as PaletteTab });

const APP_COMMANDS: Omit<Command, "scope">[] = [
  { id: "mode.text", label: "Modus: Text", group: "Allgemein", keys: ["Mod-1"], run: () => setMode("text"), inTerminal: true },
  { id: "mode.markdown", label: "Modus: Markdown", group: "Allgemein", keys: ["Mod-2"], run: () => setMode("markdown"), inTerminal: true },
  { id: "mode.latex", label: "Modus: LaTeX", group: "Allgemein", keys: ["Mod-3"], run: () => setMode("latex"), inTerminal: true },
  { id: "mode.code", label: "Modus: Code", group: "Allgemein", keys: ["Mod-4"], run: () => setMode("code"), inTerminal: true },
  { id: "search.everywhere", label: "Überall suchen", group: "Suchen", keys: ["Shift-Shift"], run: () => openPalette("all"), inTerminal: true },
  { id: "search.files", label: "Datei öffnen (nach Name)", group: "Suchen", keys: ["Mod-Shift-n", "Mod-p"], run: () => openPalette("files"), inTerminal: true },
  { id: "search.symbols", label: "Symbol suchen (Klassen, Funktionen)", group: "Suchen", keys: ["Mod-Alt-Shift-n"], run: () => openPalette("symbols"), inTerminal: true },
  { id: "search.actions", label: "Aktion / Befehl suchen", group: "Suchen", keys: ["Mod-Shift-a", "Mod-Shift-p"], run: () => openPalette("actions"), inTerminal: true },
  { id: "search.inFiles", label: "In Dateien suchen", group: "Suchen", keys: ["Mod-Shift-f"], run: () => openFind(false), inTerminal: true },
  { id: "search.replaceInFiles", label: "In Dateien ersetzen", group: "Suchen", keys: ["Mod-Shift-r"], run: () => openFind(true), inTerminal: true },
  { id: "app.help", label: "Hilfe / Cheat Sheets", group: "Allgemein", keys: ["F1"], run: () => (ui.help = !ui.help) },
  { id: "app.settings", label: "Einstellungen", group: "Allgemein", keys: ["Mod-Comma"], run: () => (settings.open = !settings.open) },
  { id: "app.zoomIn", label: "Oberfläche vergrößern", group: "Allgemein", keys: ["Mod-Plus", "Mod-="], run: () => setSize("uiScale", Math.min(1.5, +(settings.uiScale + 0.05).toFixed(2))), inTerminal: true },
  { id: "app.zoomOut", label: "Oberfläche verkleinern", group: "Allgemein", keys: ["Mod-Hyphen"], run: () => setSize("uiScale", Math.max(0.75, +(settings.uiScale - 0.05).toFixed(2))), inTerminal: true },
  { id: "app.zoomReset", label: "Oberfläche: Originalgröße", group: "Allgemein", keys: ["Mod-0"], run: () => setSize("uiScale", 1), inTerminal: true },
  { id: "app.sidebar", label: "Seitenleiste ein/aus", group: "Allgemein", keys: ["Mod-b"], run: () => (app.sidebar = !app.sidebar) },
  { id: "app.spell", label: "Rechtschreibprüfung ein/aus", group: "Allgemein", keys: ["F7"], run: toggleSpell, when: () => !debugging() },

  { id: "file.new", label: "Neue Datei", group: "Dateien & Tabs", keys: ["Mod-n"], run: newFile },
  { id: "file.openFolder", label: "Ordner öffnen", group: "Dateien & Tabs", keys: ["Mod-o"], run: openFolder },
  { id: "file.save", label: "Speichern (passiert automatisch)", group: "Dateien & Tabs", keys: ["Mod-s"], run: () => save() },
  { id: "file.saveAs", label: "Speichern unter", group: "Dateien & Tabs", keys: ["Mod-Shift-s"], run: () => save(app.activeId, true) },
  { id: "project.new", label: "Neues Projekt", group: "Dateien & Tabs", keys: [], run: () => (runner.newProject = true) },
  { id: "tab.close", label: "Tab schließen", group: "Dateien & Tabs", keys: ["Mod-w"], run: () => app.activeId && closeTab(app.activeId) },
  { id: "tab.reopen", label: "Geschlossenen Tab wieder öffnen", group: "Dateien & Tabs", keys: ["Mod-Shift-t"], run: reopenClosedTab },
  { id: "tab.next", label: "Nächster Tab", group: "Dateien & Tabs", keys: ["Mod-Tab"], run: () => cycleTab(1), inTerminal: true },
  { id: "tab.prev", label: "Vorheriger Tab", group: "Dateien & Tabs", keys: ["Mod-Shift-Tab"], run: () => cycleTab(-1), inTerminal: true },

  { id: "git.commit", label: "Git: Commit (Änderungen)", group: "Git", keys: ["Mod-k"], run: () => {
    app.sidebar = true;
    app.sidebarView = "changes";
    gitRefresh();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".changes textarea")?.focus());
  } },
  { id: "git.push", label: "Git: Push", group: "Git", keys: ["Mod-Shift-k"], run: () => gitPush() },
  { id: "git.pull", label: "Git: Pull / Aktualisieren", group: "Git", keys: ["Mod-t"], run: () => gitPull() },
  { id: "git.branch", label: "Git: Neuer Branch", group: "Git", keys: [], run: () => newBranch() },
  { id: "git.clone", label: "Git: Repository klonen", group: "Git", keys: [], run: () => cloneRepo() },
  { id: "git.remote", label: "Git: Remote verbinden / ändern", group: "Git", keys: [], run: () => connectRemote() },
  { id: "git.init", label: "Git: Repository erstellen", group: "Git", keys: [], run: () => initRepo() },
  { id: "git.publish", label: "Git: Auf GitHub veröffentlichen", group: "Git", keys: [], run: () => publishGitHub() },
  { id: "collab.open", label: "Zusammen coden (Session)", group: "Zusammen coden", keys: ["Mod-Shift-c"], run: () => (collab.open = !collab.open), inTerminal: false },
  { id: "collab.host", label: "Zusammen coden: Session starten", group: "Zusammen coden", keys: [], run: () => { collab.open = true; startHosting(); } },
  { id: "collab.join", label: "Zusammen coden: Beitreten (Code aus Zwischenablage)", group: "Zusammen coden", keys: [], run: () => joinFromClipboard() },
  { id: "collab.approve", label: "Zusammen coden: Anfrage zulassen", group: "Zusammen coden", keys: [], run: () => approveNext(), when: () => collab.requests.length > 0 },
  { id: "ai.claude", label: "Claude Code im Terminal starten", group: "KI", keys: [], run: async () => (await import("./ai/ide.svelte")).startAgent("claude") },
  { id: "ai.codex", label: "Codex im Terminal starten", group: "KI", keys: [], run: async () => (await import("./ai/ide.svelte")).startAgent("codex") },
  { id: "ai.opencode", label: "OpenCode im Terminal starten", group: "KI", keys: [], run: async () => (await import("./ai/ide.svelte")).startAgent("opencode") },
  { id: "ai.mention", label: "Auswahl an KI-Agent senden", group: "KI", keys: ["Mod-Alt-k"], run: async () => (await import("./ai/ide.svelte")).mentionSelection() },
  { id: "ai.control", label: "Steuerungs-MCP ein/aus", group: "KI", keys: [], run: async () => {
    const c = await import("./ai/control.svelte");
    await c.setControlEnabled(!c.control.enabled);
    ui.toast(c.control.enabled ? (c.control.running ? `Steuerungs-MCP läuft auf Port ${c.control.port}` : `Steuerungs-MCP: ${c.control.error}`) : "Steuerungs-MCP aus");
  } },
  { id: "collab.follow", label: "Zusammen coden: Folgen (Host bzw. ersten Gast)", group: "Zusammen coden", keys: [], when: () => !!collab.role, run: async () => {
    const { follow } = await import("./collab/share.svelte");
    const target = collab.role === "guest" ? "host" : collab.participants.find((p) => p.peer !== "self")?.peer;
    if (target) follow(target);
  } },
  { id: "collab.leave", label: "Zusammen coden: Session verlassen / beenden", group: "Zusammen coden", keys: [], run: () => leaveCollab(), when: () => !!collab.role },
  { id: "terminal.toggle", label: "Terminal öffnen / schließen", group: "Terminal", keys: ["Mod-Backquote"], run: terminalToggle, inTerminal: true },

  { id: "run.run", label: "Ausführen", group: "Ausführen & Debuggen", keys: ["Shift-F10"], run: () => runAction(runner.project?.run), modes: ["code"] },
  { id: "run.build", label: "Bauen", group: "Ausführen & Debuggen", keys: ["Mod-F9"], run: () => runAction(runner.project?.build), modes: ["code"] },
  { id: "run.test", label: "Tests ausführen", group: "Ausführen & Debuggen", keys: [], run: () => runAction(runner.project?.test), modes: ["code"] },
  { id: "run.stop", label: "Stopp (Programm / Debugger)", group: "Ausführen & Debuggen", keys: ["Mod-F2"], run: () => (debugging() ? debug.stopDebugging() : stopRun()), inTerminal: true },
  { id: "debug.start", label: "Debuggen starten", group: "Ausführen & Debuggen", keys: ["Shift-F9"], run: debug.startDebugging, inTerminal: true },
  { id: "debug.continue", label: "Fortsetzen", group: "Ausführen & Debuggen", keys: ["F9"], run: debug.continueRun, when: debugging, inTerminal: true },
  { id: "debug.stepOver", label: "Step Over", group: "Ausführen & Debuggen", keys: ["F8"], run: debug.stepOver, when: debugging, inTerminal: true },
  { id: "debug.stepInto", label: "Step Into", group: "Ausführen & Debuggen", keys: ["F7"], run: debug.stepInto, when: debugging, inTerminal: true },
  { id: "debug.stepOut", label: "Step Out", group: "Ausführen & Debuggen", keys: ["Shift-F8"], run: debug.stepOut, when: debugging, inTerminal: true },
  { id: "debug.panel", label: "Debug-Panel auf-/zuklappen", group: "Ausführen & Debuggen", keys: [], run: () => (dbg.panel = !dbg.panel), when: debugging },

  { id: "latex.sync", label: "Cursor-Stelle im PDF zeigen", group: "LaTeX", keys: ["Mod-j"], modes: ["latex"], run: () => {
    const v = ed.getView();
    if (v) forwardSync(activeTab()?.path ?? null, v.state.doc.lineAt(v.state.selection.main.head).number);
  } },
];

function terminalToggle(e?: unknown) {
  if (app.mode !== "code") setMode("code");
  const inTerminal = !!(document.activeElement as HTMLElement | null)?.closest?.(".xterm");
  if (terms.visible && inTerminal) {
    toggleTerminal();
    ed.focus();
  } else {
    if (!terms.visible) toggleTerminal();
    requestAnimationFrame(() => focusTerm());
  }
  void e;
}

export const COMMANDS: Command[] = [
  ...APP_COMMANDS.map((c) => ({ ...c, scope: "app" as const })),
  ...EDITOR_COMMANDS.map((c) => ({ ...c, scope: "editor" as const, run: (v?: EditorView) => (v ? c.run(v) : false) })),
];

// ------------------------------------------------------------------ user overrides

function loadOverrides(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem("keybindings") || "{}");
  } catch {
    return {};
  }
}

export const keymapState = $state({ overrides: loadOverrides() });

export function keysFor(id: string): string[] {
  const c = COMMANDS.find((x) => x.id === id);
  return (keymapState.overrides[id] ?? c?.keys ?? []).map(normalize);
}

export function setKeys(id: string, keys: string[] | null) {
  if (keys === null) delete keymapState.overrides[id];
  else keymapState.overrides[id] = keys.map(normalize);
  localStorage.setItem("keybindings", JSON.stringify(keymapState.overrides));
}

export function resetAllKeys() {
  keymapState.overrides = {};
  localStorage.removeItem("keybindings");
}

/** Commands (other than `id`) that currently use `key` in an overlapping context. */
export function conflicts(id: string, key: string): Command[] {
  const self = COMMANDS.find((c) => c.id === id);
  const k = normalize(key);
  return COMMANDS.filter((c) => {
    if (c.id === id || !keysFor(c.id).includes(k)) return false;
    const modesOverlap = !self?.modes || !c.modes || self.modes.some((m) => c.modes!.includes(m));
    return modesOverlap;
  });
}

function active(c: Command) {
  return (!c.modes || c.modes.includes(app.mode)) && (!c.when || c.when());
}

function find(e: KeyboardEvent, scope: Command["scope"] | null) {
  const cands = candidates(e).map(normalize);
  if (!cands.length) return null;
  for (const c of COMMANDS) {
    if (scope && c.scope !== scope) continue;
    if (!active(c)) continue;
    if (keysFor(c.id).some((k) => cands.includes(k))) return c;
  }
  return null;
}

/** Editor keydown (runs before CodeMirror's own keymaps). */
export function handleEditorKey(e: KeyboardEvent, view: EditorView): boolean {
  const c = find(e, "editor");
  if (!c) return false;
  const handled = c.run(view) !== false;
  if (handled) e.preventDefault();
  return handled;
}

// Double-Shift (like IntelliJ "Search Everywhere") for quick open.
let lastShift = 0;

/** Window keydown for app-wide commands. */
export function handleGlobalKey(e: KeyboardEvent) {
  if (ui.dialog || e.defaultPrevented || recording.active) return;
  if (e.key === "Shift" && !e.repeat && !e.ctrlKey && !e.altKey) {
    const now = Date.now();
    if (now - lastShift < 350 && keysFor("search.everywhere").includes("Shift-Shift")) {
      lastShift = 0;
      openPalette("all");
    } else lastShift = now;
    return;
  }
  const inTerminal = !!(e.target as HTMLElement | null)?.closest?.(".xterm");
  const inInput = (e.target as HTMLElement | null)?.matches?.("input, textarea") ?? false;
  const c = find(e, "app");
  if (!c) return;
  if (inTerminal && !c.inTerminal) return;
  if (inInput && !e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  c.run();
}

/** Runs any command by id (palette). Editor commands target the active editor. */
export function runCommand(id: string) {
  const c = COMMANDS.find((x) => x.id === id);
  if (!c) return;
  if (c.scope === "editor") {
    const v = ed.getView();
    if (v) {
      v.focus();
      c.run(v);
    }
  } else c.run();
}

export function availableCommands(): Command[] {
  return COMMANDS.filter(active);
}

function openPalette(tab: PaletteTab) {
  palette.tab = tab;
  palette.open = true;
}

/** True while the shortcut editor is recording a key (global handling paused). */
export const recording = $state({ active: false });

ed.setKeyHandler(handleEditorKey);
setTerminalKeyFilter((e) => !!find(e, "app")?.inTerminal);
