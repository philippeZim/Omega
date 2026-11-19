/**
 * Central command registry. Every shortcut in the app is a command with default keys that the
 * user can override (Settings → Keyboard Shortcuts). Used by the global key handler, the editor,
 * the command palette and the Shortcuts cheat sheet.
 */
import type { EditorView } from "@codemirror/view";
import { candidates, normalize } from "./keys";
import { EDITOR_COMMANDS, type CommandGroup } from "./editorCommands";
import { t, type Key } from "./i18n/index.svelte";
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
  /** Localized (getter, follows the UI language). */
  readonly label: string;
  /** Localized group name (getter). */
  readonly group: string;
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

type CommandDef = Omit<Command, "scope" | "label" | "group"> & { group: CommandGroup };

const APP_COMMANDS: CommandDef[] = [
  { id: "mode.text", group: "general", keys: ["Mod-1"], run: () => setMode("text"), inTerminal: true },
  { id: "mode.markdown", group: "general", keys: ["Mod-2"], run: () => setMode("markdown"), inTerminal: true },
  { id: "mode.latex", group: "general", keys: ["Mod-3"], run: () => setMode("latex"), inTerminal: true },
  { id: "mode.code", group: "general", keys: ["Mod-4"], run: () => setMode("code"), inTerminal: true },
  { id: "search.everywhere", group: "search", keys: ["Shift-Shift"], run: () => openPalette("all"), inTerminal: true },
  { id: "search.files", group: "search", keys: ["Mod-Shift-n", "Mod-p"], run: () => openPalette("files"), inTerminal: true },
  { id: "search.symbols", group: "search", keys: ["Mod-Alt-Shift-n"], run: () => openPalette("symbols"), inTerminal: true },
  { id: "search.actions", group: "search", keys: ["Mod-Shift-a", "Mod-Shift-p"], run: () => openPalette("actions"), inTerminal: true },
  { id: "search.inFiles", group: "search", keys: ["Mod-Shift-f"], run: () => openFind(false), inTerminal: true },
  { id: "search.replaceInFiles", group: "search", keys: ["Mod-Shift-r"], run: () => openFind(true), inTerminal: true },
  { id: "app.help", group: "general", keys: ["F1"], run: () => (ui.help = !ui.help) },
  { id: "app.settings", group: "general", keys: ["Mod-Comma"], run: () => (settings.open = !settings.open) },
  { id: "app.zoomIn", group: "general", keys: ["Mod-Plus", "Mod-="], run: () => setSize("uiScale", Math.min(1.5, +(settings.uiScale + 0.05).toFixed(2))), inTerminal: true },
  { id: "app.zoomOut", group: "general", keys: ["Mod-Hyphen"], run: () => setSize("uiScale", Math.max(0.75, +(settings.uiScale - 0.05).toFixed(2))), inTerminal: true },
  { id: "app.zoomReset", group: "general", keys: ["Mod-0"], run: () => setSize("uiScale", 1), inTerminal: true },
  { id: "app.sidebar", group: "general", keys: ["Mod-b"], run: () => (app.sidebar = !app.sidebar) },
  { id: "app.spell", group: "general", keys: ["F7"], run: toggleSpell, when: () => !debugging() },

  { id: "file.new", group: "files", keys: ["Mod-n"], run: newFile },
  { id: "file.openFolder", group: "files", keys: ["Mod-o"], run: openFolder },
  { id: "file.save", group: "files", keys: ["Mod-s"], run: () => save() },
  { id: "file.saveAs", group: "files", keys: ["Mod-Shift-s"], run: () => save(app.activeId, true) },
  { id: "project.new", group: "files", keys: [], run: () => (runner.newProject = true) },
  { id: "tab.close", group: "files", keys: ["Mod-w"], run: () => app.activeId && closeTab(app.activeId) },
  { id: "tab.reopen", group: "files", keys: ["Mod-Shift-t"], run: reopenClosedTab },
  { id: "tab.next", group: "files", keys: ["Mod-Tab"], run: () => cycleTab(1), inTerminal: true },
  { id: "tab.prev", group: "files", keys: ["Mod-Shift-Tab"], run: () => cycleTab(-1), inTerminal: true },

  { id: "git.commit", group: "git", keys: ["Mod-k"], run: () => {
    app.sidebar = true;
    app.sidebarView = "changes";
    gitRefresh();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".changes textarea")?.focus());
  } },
  { id: "git.push", group: "git", keys: ["Mod-Shift-k"], run: () => gitPush() },
  { id: "git.pull", group: "git", keys: ["Mod-t"], run: () => gitPull() },
  { id: "git.branch", group: "git", keys: [], run: () => newBranch() },
  { id: "git.clone", group: "git", keys: [], run: () => cloneRepo() },
  { id: "git.remote", group: "git", keys: [], run: () => connectRemote() },
  { id: "git.init", group: "git", keys: [], run: () => initRepo() },
  { id: "git.publish", group: "git", keys: [], run: () => publishGitHub() },
  { id: "collab.open", group: "collab", keys: ["Mod-Shift-c"], run: () => (collab.open = !collab.open), inTerminal: false },
  { id: "collab.host", group: "collab", keys: [], run: () => { collab.open = true; startHosting(); } },
  { id: "collab.join", group: "collab", keys: [], run: () => joinFromClipboard() },
  { id: "collab.approve", group: "collab", keys: [], run: () => approveNext(), when: () => collab.requests.length > 0 },
  { id: "ai.claude", group: "ai", keys: [], run: async () => (await import("./ai/ide.svelte")).startAgent("claude") },
  { id: "ai.codex", group: "ai", keys: [], run: async () => (await import("./ai/ide.svelte")).startAgent("codex") },
  { id: "ai.opencode", group: "ai", keys: [], run: async () => (await import("./ai/ide.svelte")).startAgent("opencode") },
  { id: "ai.mention", group: "ai", keys: ["Mod-Alt-k"], run: async () => (await import("./ai/ide.svelte")).mentionSelection() },
  { id: "ai.control", group: "ai", keys: [], run: async () => {
    const c = await import("./ai/control.svelte");
    await c.setControlEnabled(!c.control.enabled);
    ui.toast(c.control.enabled ? (c.control.running ? t("commands.controlRunning", { port: c.control.port }) : t("commands.controlError", { error: String(c.control.error) })) : t("commands.controlOff"));
  } },
  { id: "collab.follow", group: "collab", keys: [], when: () => !!collab.role, run: async () => {
    const { follow } = await import("./collab/share.svelte");
    const target = collab.role === "guest" ? "host" : collab.participants.find((p) => p.peer !== "self")?.peer;
    if (target) follow(target);
  } },
  { id: "collab.leave", group: "collab", keys: [], run: () => leaveCollab(), when: () => !!collab.role },
  { id: "terminal.toggle", group: "terminal", keys: ["Mod-Backquote"], run: terminalToggle, inTerminal: true },

  { id: "run.run", group: "run", keys: ["Shift-F10"], run: () => runAction(runner.project?.run), modes: ["code"] },
  { id: "run.build", group: "run", keys: ["Mod-F9"], run: () => runAction(runner.project?.build), modes: ["code"] },
  { id: "run.test", group: "run", keys: [], run: () => runAction(runner.project?.test), modes: ["code"] },
  { id: "run.stop", group: "run", keys: ["Mod-F2"], run: () => (debugging() ? debug.stopDebugging() : stopRun()), inTerminal: true },
  { id: "debug.start", group: "run", keys: ["Shift-F9"], run: debug.startDebugging, inTerminal: true },
  { id: "debug.continue", group: "run", keys: ["F9"], run: debug.continueRun, when: debugging, inTerminal: true },
  { id: "debug.stepOver", group: "run", keys: ["F8"], run: debug.stepOver, when: debugging, inTerminal: true },
  { id: "debug.stepInto", group: "run", keys: ["F7"], run: debug.stepInto, when: debugging, inTerminal: true },
  { id: "debug.stepOut", group: "run", keys: ["Shift-F8"], run: debug.stepOut, when: debugging, inTerminal: true },
  { id: "debug.panel", group: "run", keys: [], run: () => (dbg.panel = !dbg.panel), when: debugging },

  { id: "latex.sync", group: "latex", keys: ["Mod-j"], modes: ["latex"], run: () => {
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

/** Adds `label` / `group` getters so every consumer sees the current UI language. */
function localized(c: Omit<Command, "label" | "group"> & { group: CommandGroup }): Command {
  const { group, ...rest } = c;
  return Object.defineProperties(rest, {
    label: { get: () => t(`commands.cmd.${c.id}` as Key), enumerable: true },
    group: { get: () => t(`commands.group.${group}` as Key), enumerable: true },
  }) as Command;
}

export const COMMANDS: Command[] = [
  ...APP_COMMANDS.map((c) => localized({ ...c, scope: "app" })),
  ...EDITOR_COMMANDS.map((c) => localized({ ...c, scope: "editor", run: (v?: EditorView) => (v ? c.run(v) : false) })),
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
