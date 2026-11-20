/**
 * Owns the single CodeMirror view. Every tab keeps its own EditorState (doc, selection,
 * undo history). Mode switches only reconfigure a compartment, so undo history and cursor
 * survive switching between Text / Markdown / LaTeX / Code.
 */
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { setDiagnostics } from "@codemirror/lint";
import {
  EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars,
  rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { modeExtensions, type Mode } from "./modes";
import { spellcheck, type SpellLang } from "./spell";

export interface EditorConfig {
  mode: Mode;
  path: string | null;
  spell: SpellLang | null;
}
import { baseTheme } from "./theme";
import { REGISTERED_RUNS } from "./editorCommands";
import { Prec } from "@codemirror/state";
import { i18n, onLocaleChange, t, type Key } from "./i18n/index.svelte";

/** CodeMirror's built-in UI phrases (search panel, go to line, folding, lint) → our dictionary keys. */
const CM_PHRASES: [string, Key][] = [
  ["Find", "commands.cm.find"], ["Replace", "commands.cm.replace"], ["next", "commands.cm.next"],
  ["previous", "commands.cm.previous"], ["all", "commands.cm.all"], ["match case", "commands.cm.matchCase"],
  ["regexp", "commands.cm.regexp"], ["by word", "commands.cm.byWord"], ["replace", "commands.cm.replaceOne"],
  ["replace all", "commands.cm.replaceAll"], ["close", "commands.cm.close"], ["Go to line", "commands.cm.gotoLine"],
  ["go", "commands.cm.go"], ["current match", "commands.cm.currentMatch"], ["on line", "commands.cm.onLine"],
  ["replaced match on line $", "commands.cm.replacedOnLine"], ["replaced $ matches", "commands.cm.replacedCount"],
  ["Completions", "commands.cm.completions"], ["Diagnostics", "commands.cm.diagnostics"],
  ["No diagnostics", "commands.cm.noDiagnostics"], ["folded code", "commands.cm.foldedCode"], ["unfold", "commands.cm.unfold"],
  ["Fold line", "commands.cm.foldLine"], ["Unfold line", "commands.cm.unfoldLine"], ["Folded lines", "commands.cm.foldedLines"],
  ["Unfolded lines", "commands.cm.unfoldedLines"], ["to", "commands.cm.to"], ["Control character", "commands.cm.controlChar"],
  ["Selection deleted", "commands.cm.selectionDeleted"],
];

/** Phrases for the current UI language (English = CodeMirror's defaults). */
function phrases() {
  return i18n.locale === "en" ? [] : EditorState.phrases.of(Object.fromEntries(CM_PHRASES.map(([p, k]) => [p, t(k)])));
}

/** Keys handled by the command registry first (set by commands.svelte.ts). */
let keyHandler: (e: KeyboardEvent, view: EditorView) => boolean = () => false;
export function setKeyHandler(fn: typeof keyHandler) {
  keyHandler = fn;
}

/** CodeMirror's default keymaps minus the commands the user can rebind. */
const builtinKeys = [...defaultKeymap, ...historyKeymap, ...searchKeymap].filter((b) => !REGISTERED_RUNS.has(b.run));

interface Doc {
  state: EditorState;
  saved: Text;
  /** Config the state was last configured with (null = never activated). */
  cfg: EditorConfig | null;
  /** Live-collaboration binding (yCollab) while the file is shared. */
  collab: import("@codemirror/state").Extension | null;
}

// The editor owns live view/document state; hot-swapping this module would leave a second,
// orphaned view behind. Force a full reload instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

const docs = new Map<string, Doc>();
const modeConf = new Compartment();
const spellConf = new Compartment();
const collabConf = new Compartment();
const phraseConf = new Compartment();
const sameCfg = (a: EditorConfig | null, b: EditorConfig) => !!a && a.mode === b.mode && a.path === b.path && a.spell === b.spell;
let view: EditorView | null = null;
let activeId: string | null = null;
let cb = {
  onDirty: (_id: string, _d: boolean) => {},
  onCursor: (_l: number, _c: number, _s: number) => {},
  onChange: (_id: string) => {},
};

export function setCallbacks(c: typeof cb) {
  cb = c;
}

// Re-translate CodeMirror's own UI in every configured document when the UI language changes.
onLocaleChange(() => {
  const effects = phraseConf.reconfigure(phrases());
  for (const [id, d] of docs) {
    if (id === activeId && view) view.dispatch({ effects });
    else if (d.cfg) d.state = d.state.update({ effects }).state;
  }
});

function baseExtensions(cfg: EditorConfig, collab: import("@codemirror/state").Extension | null = null) {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    search({ top: true }),
    Prec.highest(EditorView.domEventHandlers({ keydown: (e, view) => keyHandler(e, view) })),
    keymap.of([...builtinKeys, indentWithTab]),
    baseTheme,
    modeConf.of(modeExtensions(cfg.mode, cfg.path)),
    collabConf.of(collab ?? []),
    spellConf.of(cfg.spell ? spellcheck(cfg.spell, cfg.mode) : []),
    phraseConf.of(phrases()),
    EditorView.updateListener.of((u) => {
      if (!activeId) return;
      if (u.docChanged) {
        const d = docs.get(activeId);
        if (d) cb.onDirty(activeId, !u.state.doc.eq(d.saved));
        cb.onChange(activeId);
      }
      if (u.docChanged || u.selectionSet) reportCursor(u.state);
    }),
  ];
}

function reportCursor(s: EditorState) {
  const r = s.selection.main;
  const line = s.doc.lineAt(r.head);
  cb.onCursor(line.number, r.head - line.from + 1, Math.abs(r.to - r.from));
}

export function mount(parent: HTMLElement) {
  // If the UI is rebuilt, re-attach the existing view. Creating a fresh (empty) view while a
  // tab is active would make autosave write an empty document over the real file.
  if (view) {
    parent.appendChild(view.dom);
    return;
  }
  view = new EditorView({ parent, state: EditorState.create({ doc: "" }) });
  view.dom.style.display = activeId ? "" : "none";
}

export function createDoc(id: string, content: string) {
  // The state is created lazily with the right extensions on first activation.
  const state = EditorState.create({ doc: content });
  docs.set(id, { state, saved: state.doc, cfg: null, collab: null });
}

export function disposeDoc(id: string) {
  docs.delete(id);
}

export function activate(id: string | null, cfg: EditorConfig) {
  if (!view) return;
  // Persist the outgoing tab's state.
  if (activeId && docs.has(activeId)) docs.get(activeId)!.state = view.state;
  activeId = id;
  if (!id) {
    view.dom.style.display = "none";
    return;
  }
  const d = docs.get(id)!;
  if (d.cfg === null) {
    d.state = EditorState.create({ doc: d.state.doc, extensions: baseExtensions(cfg, d.collab) });
    d.cfg = cfg;
  }
  view.dom.style.display = "";
  view.setState(d.state);
  if (!sameCfg(d.cfg, cfg)) configure(cfg);
  reportCursor(view.state);
  view.focus();
}

/** Reconfigures the active tab (mode switch, rename, spellcheck language). */
export function configure(cfg: EditorConfig) {
  if (!view || !activeId) return;
  const d = docs.get(activeId)!;
  const prev = d.cfg;
  d.cfg = cfg;
  const effects = [];
  if (!prev || prev.mode !== cfg.mode || prev.path !== cfg.path) effects.push(modeConf.reconfigure(modeExtensions(cfg.mode, cfg.path)));
  if (!prev || prev.spell !== cfg.spell || prev.mode !== cfg.mode) effects.push(spellConf.reconfigure(cfg.spell ? spellcheck(cfg.spell, cfg.mode) : []));
  if (effects.length) view.dispatch({ effects });
}

export function getText(id: string): string {
  if (id === activeId && view) return view.state.doc.toString();
  return docs.get(id)?.state.doc.toString() ?? "";
}

export function getDoc(id: string): Text | null {
  if (id === activeId && view) return view.state.doc;
  return docs.get(id)?.state.doc ?? null;
}

/** Marks `doc` (the snapshot that was written) as saved; edits made during the write stay dirty. */
export function markSaved(id: string, doc?: Text) {
  const d = docs.get(id);
  if (!d) return;
  d.saved = doc ?? getDoc(id) ?? d.saved;
}

/** The content last loaded from or written to disk (null for unknown docs). */
export function savedText(id: string): string | null {
  return docs.get(id)?.saved.toString() ?? null;
}

export function isDirty(id: string): boolean {
  const d = docs.get(id);
  const cur = getDoc(id);
  return !!d && !!cur && !cur.eq(d.saved);
}

export function focus() {
  view?.focus();
}

export function getView() {
  return view;
}

/**
 * Applies changes to a document from outside the main view (find/replace, search preview).
 * Open tabs keep undo history; the dirty flag (and with it autosave) updates as usual.
 */
export function applyChanges(id: string, spec: { changes: import("@codemirror/state").ChangeSpec }) {
  const d = docs.get(id);
  if (!d) return;
  if (id === activeId && view) {
    view.dispatch({ ...spec, userEvent: "input.external" });
    return;
  }
  d.state = d.state.update({ ...spec, userEvent: "input.external" }).state;
  cb.onDirty(id, !d.state.doc.eq(d.saved));
  cb.onChange(id);
}

/** Replaces the whole text with a minimal change (common prefix/suffix kept). */
export function replaceDocText(id: string, text: string) {
  const cur = getText(id);
  if (cur === text) return;
  let a = 0;
  while (a < cur.length && a < text.length && cur[a] === text[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < text.length - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
  applyChanges(id, { changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) } });
}

/** Removes lint diagnostics (e.g. LaTeX errors) from the active document. */
export function clearDiagnostics() {
  if (view) view.dispatch(setDiagnostics(view.state, []));
}

/** Binds/unbinds a live-collaboration extension (yCollab) to a document. */
export function setCollab(id: string, ext: import("@codemirror/state").Extension | null) {
  const d = docs.get(id);
  if (!d) return;
  d.collab = ext;
  if (d.cfg === null) return; // state created lazily with the binding
  const effects = collabConf.reconfigure(ext ?? []);
  if (id === activeId && view) view.dispatch({ effects });
  else d.state = d.state.update({ effects }).state;
}

export function isActive(id: string) {
  return id === activeId;
}

export function hasDoc(id: string) {
  return docs.has(id);
}
