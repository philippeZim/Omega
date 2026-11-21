/**
 * Central command registry. Every shortcut in the app is a command with default keys that the
 * user can override (Settings → Keyboard Shortcuts). Used by the global key handler, the editor,
 * the command palette and the Shortcuts cheat sheet.
 */
import type { EditorView } from "@codemirror/view";
import { onGlobalChange } from "./windowStorage";
import { candidates, formatKey, normalize } from "./keys";
import { EDITOR_COMMANDS, type CommandGroup } from "./editorCommands";
import { KEYMAPS, type KeymapId } from "./keymaps";
import { t, type Key } from "./i18n/index.svelte";
import * as ed from "./editor";
import { app, newFileInSession, save, openFolder, closeTab, setMode, cycleTab, toggleSpell, reopenClosedTab } from "./state.svelte";
import { ui } from "./ui.svelte";
import { checkForUpdates } from "./updater.svelte";
import { report } from "./report.svelte";
import { settings, setSize } from "./settings.svelte";
import { runner, runAction, stopRun, openNewProject } from "./code/runner.svelte";
import { openLanguageMenu } from "./code/langMenu";
import * as debug from "./debug/debugger.svelte";
import { dbg } from "./debug/store.svelte";
import { setTerminalKeyFilter } from "./terminal.svelte";
import { toggleZone, toggleFocus, showView, moveFocused, resetLayout } from "./layout.svelte";
import { forwardSync } from "./latex/controller.svelte";
import { openFind } from "./search/search.svelte";
import { blockedAsGuest, blockedWhileHosting } from "./collab/guard";
import { collab, startHosting, joinFromClipboard, approveNext, leave as leaveCollab } from "./collab/collab.svelte";
import { git, push as gitPush, pull as gitPull, newBranch, cloneRepo, publishGitHub, refresh as gitRefresh, connectRemote, initRepo } from "./git/git.svelte";
import { activeTab } from "./state.svelte";
import { blameSettings, setGitBlame } from "./git/blame.svelte";
import { MODES, type Mode } from "./modeList";

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
  /**
   * Hard-to-undo command: when triggered by a shortcut it asks first (resolves true to proceed) and it
   * never fires from a text field. The palette and buttons run it directly.
   */
  confirmKey?: () => Promise<boolean>;
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
  { id: "app.settings", group: "general", keys: ["Mod-,"], run: () => (settings.open = !settings.open) },
  { id: "app.checkUpdates", group: "general", keys: [], run: () => checkForUpdates(true) },
  { id: "app.report", group: "general", keys: [], run: () => (report.open = true), inTerminal: true },
  { id: "app.zoomIn", group: "general", keys: ["Mod-Plus", "Mod-="], run: () => setSize("uiScale", Math.min(1.5, +(settings.uiScale + 0.05).toFixed(2))), inTerminal: true },
  { id: "app.zoomOut", group: "general", keys: ["Mod-Hyphen"], run: () => setSize("uiScale", Math.max(0.75, +(settings.uiScale - 0.05).toFixed(2))), inTerminal: true },
  { id: "app.zoomReset", group: "general", keys: ["Mod-0"], run: () => setSize("uiScale", 1), inTerminal: true },
  { id: "app.sidebar", group: "window", keys: ["Mod-b"], run: () => toggleZone("left"), inTerminal: true },
  { id: "app.spell", group: "general", keys: ["F7"], run: toggleSpell, when: () => !debugging() },

  // A guest's new file goes into the host's project, so it's shared and saved there (#133).
  { id: "file.new", group: "files", keys: ["Mod-n"], run: () => newFileInSession() },
  { id: "file.openFolder", group: "files", keys: ["Mod-o"], run: openFolder },
  { id: "file.save", group: "files", keys: ["Mod-s"], run: () => save() },
  { id: "file.saveAs", group: "files", keys: ["Mod-Shift-s"], run: () => save(app.activeId, true) },
  { id: "project.new", group: "files", keys: [], run: () => openNewProject() },
  { id: "tab.close", group: "files", keys: ["Mod-w"], run: () => app.activeId && closeTab(app.activeId) },
  { id: "tab.reopen", group: "files", keys: ["Mod-Shift-t"], run: reopenClosedTab },
  { id: "tab.next", group: "files", keys: ["Mod-Tab"], run: () => cycleTab(1), inTerminal: true },
  { id: "tab.prev", group: "files", keys: ["Mod-Shift-Tab"], run: () => cycleTab(-1), inTerminal: true },

  { id: "git.commit", group: "git", keys: ["Mod-k"], run: () => {
    showView("changes");
    gitRefresh();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".changes textarea")?.focus());
  } },
  { id: "git.push", group: "git", keys: ["Mod-Shift-k"], run: () => gitPush(), confirmKey: () =>
    ui.confirm(t("git.confirmPushTitle", { ref: git.upstream ?? "origin/" + git.branch }), t("git.confirmPushBody"), "Push") },
  { id: "git.pull", group: "git", keys: ["Mod-t"], run: () => gitPull(), confirmKey: () =>
    ui.confirm(t("git.confirmPullTitle", { ref: git.upstream ?? "origin/" + git.branch }), t("git.confirmPullBody"), "Pull") },
  { id: "git.branch", group: "git", keys: [], run: () => newBranch() },
  { id: "git.clone", group: "git", keys: [], run: () => cloneRepo() },
  { id: "git.remote", group: "git", keys: [], run: () => connectRemote() },
  { id: "git.init", group: "git", keys: [], run: () => initRepo() },
  { id: "git.publish", group: "git", keys: [], run: () => publishGitHub() },
  { id: "git.blame", group: "git", keys: [], run: () => setGitBlame(!blameSettings.enabled) },
  { id: "collab.open", group: "collab", keys: ["Mod-Shift-c"], run: () => (collab.open = !collab.open), inTerminal: false },
  { id: "collab.host", group: "collab", keys: [], run: () => { if (blockedAsGuest()) return; collab.open = true; if (!blockedWhileHosting()) startHosting(); } },
  { id: "collab.join", group: "collab", keys: [], run: () => { if (!blockedAsGuest() && !blockedWhileHosting()) return joinFromClipboard(); } },
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
  { id: "terminal.toggle", group: "terminal", keys: ["Mod-Backquote", "Alt-4"], run: () => toggleFocus("terminal"), inTerminal: true },
  { id: "view.files", group: "window", keys: ["Alt-1"], run: () => toggleFocus("files"), inTerminal: true },
  { id: "view.changes", group: "window", keys: ["Alt-2"], run: () => { toggleFocus("changes"); gitRefresh(); }, inTerminal: true },
  { id: "view.outline", group: "window", keys: ["Alt-3"], run: () => toggleFocus("outline"), modes: ["latex"], inTerminal: true },
  { id: "view.console", group: "window", keys: ["Alt-6"], run: () => toggleFocus("console"), inTerminal: true },
  { id: "view.search", group: "window", keys: ["Alt-7"], run: () => toggleFocus("search"), inTerminal: true },
  { id: "view.pdf", group: "window", keys: ["Alt-8"], run: () => toggleFocus("pdf"), modes: ["latex"], inTerminal: true },
  { id: "layout.moveLeft", group: "window", keys: ["Mod-Alt-Shift-ArrowLeft"], run: () => moveFocused("left"), inTerminal: true },
  { id: "layout.moveRight", group: "window", keys: ["Mod-Alt-Shift-ArrowRight"], run: () => moveFocused("right"), inTerminal: true },
  { id: "layout.moveBottom", group: "window", keys: ["Mod-Alt-Shift-ArrowDown"], run: () => moveFocused("bottom"), inTerminal: true },
  { id: "layout.reset", group: "window", keys: [], run: resetLayout },

  { id: "code.language", group: "code", keys: [], run: () => openLanguageMenu(), modes: ["code"] },
  { id: "run.run", group: "run", keys: ["Shift-F10"], run: () => runAction(runner.project?.run), modes: ["code"] },
  { id: "run.build", group: "run", keys: ["Mod-F9"], run: () => runAction(runner.project?.build), modes: ["code"] },
  { id: "run.test", group: "run", keys: [], run: () => runAction(runner.project?.test), modes: ["code"] },
  { id: "run.stop", group: "run", keys: ["Mod-F2"], run: () => (debugging() ? debug.stopDebugging() : stopRun()), inTerminal: true },
  { id: "debug.start", group: "run", keys: ["Shift-F9"], run: debug.startDebugging, inTerminal: true },
  { id: "debug.continue", group: "run", keys: ["F9"], run: debug.continueRun, when: debugging, inTerminal: true },
  { id: "debug.stepOver", group: "run", keys: ["F8"], run: debug.stepOver, when: debugging, inTerminal: true },
  { id: "debug.stepInto", group: "run", keys: ["F7"], run: debug.stepInto, when: debugging, inTerminal: true },
  { id: "debug.stepOut", group: "run", keys: ["Shift-F8"], run: debug.stepOut, when: debugging, inTerminal: true },
  { id: "debug.panel", group: "window", keys: ["Alt-5"], run: () => toggleFocus("debug"), when: () => dbg.status !== "idle", inTerminal: true },

  { id: "latex.sync", group: "latex", keys: ["Mod-j"], modes: ["latex"], run: () => {
    const v = ed.getView();
    if (v) forwardSync(activeTab()?.path ?? null, v.state.doc.lineAt(v.state.selection.main.head).number);
  } },
];


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

function loadPreset(): KeymapId {
  const id = localStorage.getItem("keymap.preset");
  return KEYMAPS.some((k) => k.id === id) ? (id as KeymapId) : "omega";
}

export const keymapState = $state({ overrides: loadOverrides(), preset: loadPreset() });

const modesOverlap = (a: Command | undefined, b: Command) => !a?.modes || !b.modes || a.modes.some((m) => b.modes!.includes(m));

const baseCache = new Map<KeymapId, Record<string, string[]>>();

/** Keys of every command under a preset: its own entries, else Omega's defaults minus keys the preset gave to others. */
function presetBase(id: KeymapId): Record<string, string[]> {
  let base = baseCache.get(id);
  if (base) return base;
  const preset = KEYMAPS.find((k) => k.id === id)?.keys ?? {};
  // Only keys a command newly gets count as claimed; clashes Omega already has (and resolves by scope) stay.
  const claimed = COMMANDS.filter((c) => c.id in preset).map((c) => {
    const own = c.keys.map(normalize);
    return { c, keys: preset[c.id].map(normalize).filter((k) => !own.includes(k)) };
  });
  base = {};
  for (const c of COMMANDS) {
    if (c.id in preset) base[c.id] = preset[c.id].map(normalize);
    else base[c.id] = c.keys.map(normalize).filter((k) => !claimed.some((p) => p.keys.includes(k) && modesOverlap(p.c, c)));
  }
  baseCache.set(id, base);
  return base;
}

/** Display names of the modes a command is limited to ("LaTeX", not the raw id "latex"). */
export function modeNames(modes: Mode[] | undefined): string {
  return (modes ?? []).map((m) => MODES.find((x) => x.id === m)?.label ?? m).join(", ");
}

/** Keys of a command in the active preset, ignoring the user's own changes. */
export function defaultKeysFor(id: string): string[] {
  return presetBase(keymapState.preset)[id] ?? [];
}

export function keysFor(id: string): string[] {
  return (keymapState.overrides[id] ?? defaultKeysFor(id)).map(normalize);
}

// Changed in another window.
onGlobalChange("keybindings", () => (keymapState.overrides = loadOverrides()));
onGlobalChange("keymap.preset", () => (keymapState.preset = loadPreset()));

function saveOverrides() {
  if (Object.keys(keymapState.overrides).length) localStorage.setItem("keybindings", JSON.stringify(keymapState.overrides));
  else localStorage.removeItem("keybindings");
}

/** Current shortcut(s) of a command for menus and tooltips, e.g. "Ctrl 1 / Ctrl 2"; "" when unbound. */
export function shortcutLabel(id: string): string {
  return keysFor(id).map(formatKey).join(" / ");
}

/** Shortcuts of the four mode commands for hints: "Ctrl 1 – 4" for the usual run, else each first key ("" if none is bound). */
export function modeSwitchLabel(): string {
  const keys = MODES.map((m) => keysFor(`mode.${m.id}`)[0]);
  const prefix = keys[0]?.replace(/1$/, "");
  if (prefix && keys[0] !== prefix && keys.every((k, i) => k === `${prefix}${i + 1}`)) return `${formatKey(keys[0]!)} – ${keys.length}`;
  return keys.filter((k): k is string => !!k).map(formatKey).join(" / ");
}

/** Tooltip text with the current shortcut appended, e.g. "Sidebar (Ctrl B)". */
export function withShortcut(text: string, id: string): string {
  const s = shortcutLabel(id);
  return s ? `${text} (${s})` : text;
}

export function setKeys(id: string, keys: string[] | null) {
  if (keys === null) delete keymapState.overrides[id];
  else keymapState.overrides[id] = keys.map(normalize);
  saveOverrides();
}

export function resetAllKeys() {
  keymapState.overrides = {};
  saveOverrides();
}

/** Switches to another IDE's keymap. `keepCustom`: the user's own bindings stay on top of it. */
export function applyKeymap(id: KeymapId, keepCustom: boolean) {
  keymapState.preset = id;
  localStorage.setItem("keymap.preset", id);
  if (!keepCustom) keymapState.overrides = {};
  else {
    // Overrides identical to the new preset's keys are no longer custom.
    for (const [cid, keys] of Object.entries(keymapState.overrides)) {
      const base = defaultKeysFor(cid);
      if (keys.length === base.length && keys.every((k) => base.includes(k))) delete keymapState.overrides[cid];
    }
  }
  saveOverrides();
}

/** Commands (other than `id`) that currently use `key` in an overlapping context. */
export function conflicts(id: string, key: string): Command[] {
  const self = COMMANDS.find((c) => c.id === id);
  const k = normalize(key);
  return COMMANDS.filter((c) => {
    if (c.id === id || !keysFor(c.id).includes(k)) return false;
    return modesOverlap(self, c);
  });
}

function active(c: Command) {
  return (!c.modes || c.modes.includes(app.mode)) && (!c.when || c.when());
}

/** Commands with a `when` guard first, so a shared key (VS Code F5: continue while debugging, else start) picks the specific one. */
const BY_PRIORITY = [...COMMANDS].sort((a, b) => Number(!a.when) - Number(!b.when));

function find(e: KeyboardEvent, scope: Command["scope"] | null) {
  const cands = candidates(e).map(normalize);
  if (!cands.length) return null;
  for (const c of BY_PRIORITY) {
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
  if (!c) {
    // Reload (F5 / Ctrl+R) would throw away never-saved files and running terminals.
    if (!inTerminal && (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r"))) e.preventDefault();
    return;
  }
  if (inTerminal && !c.inTerminal) return;
  if (inInput && (c.confirmKey || (!e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.key)))) return;
  e.preventDefault();
  e.stopPropagation();
  if (c.confirmKey) c.confirmKey().then((ok) => ok && c.run());
  else c.run();
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
/** True if the key event is an app shortcut that also works while a terminal has focus. */
export const isTerminalShortcut = (e: KeyboardEvent) => !!find(e, "app")?.inTerminal;
setTerminalKeyFilter(isTerminalShortcut);
