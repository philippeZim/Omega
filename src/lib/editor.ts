/**
 * Owns the single CodeMirror view. Every tab keeps its own EditorState (doc, selection,
 * undo history). Mode switches only reconfigure a compartment, so undo history and cursor
 * survive switching between Text / Markdown / LaTeX / Code.
 */
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { setDiagnostics } from "@codemirror/lint";
import {
  EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars,
  rectangularSelection, crosshairCursor, lineNumbers, showPanel,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { modeExtensions, type Mode } from "./modes";
import { spellcheck, type SpellLang } from "./spell";

export interface EditorConfig {
  mode: Mode;
  path: string | null;
  spell: SpellLang | null;
  /** Set for the read-only view of a too large file's start: the banner text. No language features (#174). */
  headNote?: string | null;
}
import { baseTheme } from "./theme";
import { REGISTERED_RUNS } from "./editorCommands";
import { Prec } from "@codemirror/state";
import { onLocaleChange } from "./i18n/index.svelte";
import { stripBom } from "./eol";
import { phrases } from "./cmPhrases";

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
const sameCfg = (a: EditorConfig | null, b: EditorConfig) => !!a && a.mode === b.mode && a.path === b.path && a.spell === b.spell && (a.headNote ?? null) === (b.headNote ?? null);

/** A too large file's start: plain text that nothing can change, whatever the mode (#174). */
function headView(note: string) {
  const panel = () => {
    const dom = document.createElement("div");
    dom.className = "cm-head-note";
    dom.setAttribute("role", "status");
    dom.textContent = note;
    dom.style.cssText = "padding: 6px 14px; font-size: 12px; color: var(--orange);";
    return { dom, top: true };
  };
  return [lineNumbers(), EditorState.readOnly.of(true), EditorState.changeFilter.of(() => false), showPanel.of(panel), EditorView.editorAttributes.of({ class: "mode-code" })];
}

const modeExt = (cfg: EditorConfig) => (cfg.headNote ? headView(cfg.headNote) : modeExtensions(cfg.mode, cfg.path));
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
    modeConf.of(modeExt(cfg)),
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
  // The BOM is not part of the text (it would show as a special character); save writes it back (eol.ts).
  const state = EditorState.create({ doc: stripBom(content) });
  docs.set(id, { state, saved: state.doc, cfg: null, collab: null });
}

/** Cursor of recently closed files (by path), restored when the file is opened again in this session. */
const closedPos = new Map<string, { anchor: number; head: number }>();

export function disposeDoc(id: string) {
  const d = docs.get(id);
  const path = d?.cfg?.path;
  if (d && path) {
    const { anchor, head } = (id === activeId && view ? view.state : d.state).selection.main;
    closedPos.delete(path);
    closedPos.set(path, { anchor, head });
    if (closedPos.size > 100) closedPos.delete(closedPos.keys().next().value!);
  }
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
  let restored: number | null = null;
  if (d.cfg === null) {
    const pos = cfg.path ? closedPos.get(cfg.path) : undefined;
    const len = d.state.doc.length;
    const selection = pos && { anchor: Math.min(pos.anchor, len), head: Math.min(pos.head, len) };
    d.state = EditorState.create({ doc: d.state.doc, selection, extensions: baseExtensions(cfg, d.collab) });
    d.cfg = cfg;
    if (selection) restored = selection.head;
  }
  view.dom.style.display = "";
  view.setState(d.state);
  if (restored !== null) view.dispatch({ effects: EditorView.scrollIntoView(restored, { y: "center" }) });
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
  if (!prev || prev.mode !== cfg.mode || prev.path !== cfg.path || prev.headNote !== cfg.headNote) effects.push(modeConf.reconfigure(modeExt(cfg)));
  if (!prev || prev.spell !== cfg.spell || prev.mode !== cfg.mode) effects.push(spellConf.reconfigure(cfg.spell ? spellcheck(cfg.spell, cfg.mode) : []));
  if (effects.length) view.dispatch({ effects });
}

/**
 * This editor's document `id` has a new path or language: new highlighting and tooling, same text,
 * cursor and undo history. Also for a background tab, whose stored path would otherwise be stale.
 */
export function refreshLanguage(id: string, path: string | null) {
  const d = docs.get(id);
  if (!d?.cfg) return; // not shown yet: it's configured with the current path when activated
  d.cfg = { ...d.cfg, path };
  const effects = modeConf.reconfigure(modeExt(d.cfg));
  if (id === activeId && view) view.dispatch({ effects });
  else d.state = d.state.update({ effects }).state;
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
export function applyChanges(id: string, spec: Pick<import("@codemirror/state").TransactionSpec, "changes" | "annotations">) {
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

/** Mode the active document is configured for (null without an active document). */
export function activeMode(): Mode | null {
  return (activeId && docs.get(activeId)?.cfg?.mode) || null;
}

export function isActive(id: string) {
  return id === activeId;
}

export function hasDoc(id: string) {
  return docs.has(id);
}
