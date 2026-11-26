/**
 * Owns the CodeMirror views: one per editor group (pane, #219). Every document keeps its own
 * EditorState (doc, selection, undo history). Mode switches only reconfigure a compartment, so
 * undo history and cursor survive switching between Text / Markdown / LaTeX / Code.
 *
 * A document shown in several panes at once: one pane holds its own state (the owner, with the
 * live-collaboration binding), the others get a mirror state on the same text. Every change in
 * one is forwarded to the others, so they stay equal; each keeps its own cursor, scroll, mode
 * and undo history. When the owner moves on, a mirror becomes the owner.
 */
import { Annotation, Compartment, EditorState, Transaction, type Text } from "@codemirror/state";
import { setDiagnostics } from "@codemirror/lint";
import {
  EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars,
  rectangularSelection, crosshairCursor, lineNumbers, showPanel,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { modeExtensions, type Mode } from "./modes";
import { stickyGuttersWhenScrolled } from "./stickyGutters";
import { spellcheck, type SpellLang } from "./spell";

export interface EditorConfig {
  mode: Mode;
  path: string | null;
  spell: SpellLang | null;
  /** Set for the read-only view of a too large file's start: the banner text. No language features (#174). */
  headNote?: string | null;
  /** Set for a large file open in full: the label. Editable, but no language features (#174). */
  largeNote?: string | null;
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
  /** Pane whose view holds this document's state; null = `state` is current (not shown). */
  owner: string | null;
}

interface Pane {
  view: EditorView;
  /** Document shown, null = none (the view is hidden). */
  doc: string | null;
  /** Config of what the pane shows. */
  cfg: EditorConfig | null;
}

/** Marks changes forwarded from another pane on the same document. */
const synced = Annotation.define<boolean>();
/** The pane a test or a caller without groups uses. */
export const MAIN_PANE = "main";

// The editor owns live view/document state; hot-swapping this module would leave a second,
// orphaned view behind. Force a full reload instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());

const docs = new Map<string, Doc>();
const modeConf = new Compartment();
const spellConf = new Compartment();
const collabConf = new Compartment();
const phraseConf = new Compartment();
const sameCfg = (a: EditorConfig | null, b: EditorConfig) => !!a && a.mode === b.mode && a.path === b.path && a.spell === b.spell && (a.headNote ?? null) === (b.headNote ?? null) && (a.largeNote ?? null) === (b.largeNote ?? null);

/** Plain text with line numbers and a label on top, whatever the mode (#174). */
function plainView(note: string, className: string) {
  const panel = () => {
    const dom = document.createElement("div");
    dom.className = className;
    dom.setAttribute("role", "status");
    dom.textContent = note;
    dom.style.cssText = "padding: 6px 14px; font-size: 12px; color: var(--orange);";
    return { dom, top: true };
  };
  return [lineNumbers(), showPanel.of(panel), EditorView.editorAttributes.of({ class: "mode-code" })];
}

/** A too large file's start: nothing can change it. */
const headView = (note: string) => [plainView(note, "cm-head-note"), EditorState.readOnly.of(true), EditorState.changeFilter.of(() => false)];

const modeExt = (cfg: EditorConfig) =>
  cfg.headNote ? headView(cfg.headNote) : cfg.largeNote ? plainView(cfg.largeNote, "cm-large-note") : modeExtensions(cfg.mode, cfg.path);
const panes = new Map<string, Pane>();
let focusedPane = MAIN_PANE;
/** Cursor and scroll of a document in a pane, for when the pane shows it again (key: pane + doc). */
const places = new Map<string, { anchor: number; head: number; scroll: import("@codemirror/state").StateEffect<unknown> }>();
const placeKey = (pane: string, id: string) => `${pane}\u001f${id}`;
let cb = {
  onDirty: (_id: string, _d: boolean) => {},
  onCursor: (_l: number, _c: number, _s: number) => {},
  onChange: (_id: string) => {},
};

const focused = () => panes.get(focusedPane) ?? null;
/** Panes showing `id`. */
const panesOf = (id: string) => [...panes.entries()].filter(([, p]) => p.doc === id);
/** The view holding document `id`'s own state, if it's shown. */
function ownerView(id: string): EditorView | null {
  const o = docs.get(id)?.owner;
  return (o && panes.get(o)?.view) || null;
}
/** Current state of document `id`, wherever it lives. */
function stateOf(id: string): EditorState | null {
  return ownerView(id)?.state ?? docs.get(id)?.state ?? null;
}

export function setCallbacks(c: typeof cb) {
  cb = c;
}

// Re-translate CodeMirror's own UI in every configured document when the UI language changes.
onLocaleChange(() => {
  const effects = phraseConf.reconfigure(phrases());
  for (const p of panes.values()) if (p.doc) p.view.dispatch({ effects });
  for (const d of docs.values()) if (!d.owner && d.cfg) d.state = d.state.update({ effects }).state;
});

function baseExtensions(id: string, cfg: EditorConfig, collab: import("@codemirror/state").Extension | null = null) {
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
    stickyGuttersWhenScrolled,
    modeConf.of(modeExt(cfg)),
    collabConf.of(collab ?? []),
    spellConf.of(cfg.spell ? spellcheck(cfg.spell, cfg.mode) : []),
    phraseConf.of(phrases()),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((tr) => tr.annotation(synced))) {
        // The same document in other panes follows (their own undo history leaves it out).
        for (const [, p] of panesOf(id))
          if (p.view !== u.view) p.view.dispatch({ changes: u.changes, annotations: [synced.of(true), Transaction.addToHistory.of(false)] });
        const d = docs.get(id);
        if (d) cb.onDirty(id, !u.state.doc.eq(d.saved));
        cb.onChange(id);
      }
      if ((u.docChanged || u.selectionSet) && u.view === focused()?.view) reportCursor(u.state);
    }),
  ];
}

function reportCursor(s: EditorState) {
  const r = s.selection.main;
  const line = s.doc.lineAt(r.head);
  cb.onCursor(line.number, r.head - line.from + 1, Math.abs(r.to - r.from));
}

function emptyState() {
  return EditorState.create({ doc: "" });
}

/** Creates the view of pane `pane` in `parent`, or moves the existing one there (UI rebuilt). */
export function mount(parent: HTMLElement, pane = MAIN_PANE) {
  // If the UI is rebuilt, re-attach the existing view. Creating a fresh (empty) view while a
  // tab is active would make autosave write an empty document over the real file.
  const p = panes.get(pane);
  if (p) {
    parent.appendChild(p.view.dom);
    return;
  }
  const view = new EditorView({ parent, state: emptyState() });
  view.dom.style.display = "none";
  panes.set(pane, { view, doc: null, cfg: null });
}

/** The pane's group is gone: its document is handed on, its view removed. */
export function destroyPane(pane: string) {
  const p = panes.get(pane);
  if (!p) return;
  release(pane, p);
  p.view.destroy();
  panes.delete(pane);
  for (const k of places.keys()) if (k.startsWith(pane + "\u001f")) places.delete(k);
}

/** Pane `pane` stops showing its document: remembers its place; the state goes back to the document or to another pane. */
function release(pane: string, p: Pane) {
  const id = p.doc;
  if (!id) return;
  const { anchor, head } = p.view.state.selection.main;
  places.set(placeKey(pane, id), { anchor, head, scroll: p.view.scrollSnapshot() });
  const d = docs.get(id);
  p.doc = null;
  if (d && d.owner === pane) {
    d.owner = null;
    d.state = p.view.state;
    // Another pane on the same document takes over: its own state gets the collaboration binding.
    const heir = panesOf(id)[0];
    if (heir) {
      d.owner = heir[0];
      d.cfg = heir[1].cfg;
      heir[1].view.dispatch({ effects: collabConf.reconfigure(d.collab ?? []) });
    }
  }
  p.view.setState(emptyState());
}

/** The pane commands, the cursor display and `getView` refer to. */
export function setFocusedPane(pane: string) {
  if (focusedPane === pane) return;
  focusedPane = pane;
  const p = focused();
  if (p?.doc) reportCursor(p.view.state);
}

export function getFocusedPane() {
  return focusedPane;
}

export function createDoc(id: string, content: string) {
  // The state is created lazily with the right extensions on first activation.
  // The BOM is not part of the text (it would show as a special character); save writes it back (eol.ts).
  const state = EditorState.create({ doc: stripBom(content) });
  docs.set(id, { state, saved: state.doc, cfg: null, collab: null, owner: null });
}

/** Cursor of recently closed files (by path), restored when the file is opened again in this session. */
const closedPos = new Map<string, { anchor: number; head: number }>();

export function disposeDoc(id: string) {
  const d = docs.get(id);
  const path = d?.cfg?.path;
  if (d && path) {
    const { anchor, head } = (stateOf(id) ?? d.state).selection.main;
    closedPos.delete(path);
    closedPos.set(path, { anchor, head });
    if (closedPos.size > 100) closedPos.delete(closedPos.keys().next().value!);
  }
  for (const [pane, p] of panesOf(id)) {
    release(pane, p);
    p.view.dom.style.display = "none";
  }
  for (const k of places.keys()) if (k.endsWith("\u001f" + id)) places.delete(k);
  docs.delete(id);
}

/** Shows document `id` (null = nothing) in the focused pane. */
export function activate(id: string | null, cfg: EditorConfig) {
  show(focusedPane, id, cfg, true);
}

/** Shows document `id` (null = nothing) in pane `pane`, configured with `cfg`. */
export function show(pane: string, id: string | null, cfg: EditorConfig, focus = pane === focusedPane) {
  const p = panes.get(pane);
  if (!p) return;
  if (p.doc === id && id) {
    if (!sameCfg(p.cfg, cfg)) configurePane(pane, cfg);
    if (pane === focusedPane) reportCursor(p.view.state);
    if (focus) p.view.focus();
    return;
  }
  release(pane, p);
  if (!id || !docs.has(id)) {
    p.view.dom.style.display = "none";
    p.cfg = null;
    return;
  }
  const d = docs.get(id)!;
  const place = places.get(placeKey(pane, id));
  const clip = (s: { anchor: number; head: number }, len: number) => ({ anchor: Math.min(s.anchor, len), head: Math.min(s.head, len) });
  let restored: number | null = null;
  p.view.dom.style.display = "";
  if (d.owner === null) {
    if (d.cfg === null) {
      const pos = cfg.path ? closedPos.get(cfg.path) : undefined;
      const selection = pos && clip(pos, d.state.doc.length);
      d.state = EditorState.create({ doc: d.state.doc, selection, extensions: baseExtensions(id, cfg, d.collab) });
      d.cfg = cfg;
      if (selection) restored = selection.head;
    }
    d.owner = pane;
    p.cfg = d.cfg;
    p.view.setState(place ? d.state.update({ selection: clip(place, d.state.doc.length) }).state : d.state);
  } else {
    // Already shown in another pane: a mirror on the same text.
    const doc = stateOf(id)!.doc;
    const at = place ?? (ownerView(id)?.state.selection.main);
    p.cfg = cfg;
    p.view.setState(EditorState.create({ doc, selection: at && clip(at, doc.length), extensions: baseExtensions(id, cfg) }));
  }
  p.doc = id;
  if (place) p.view.dispatch({ effects: place.scroll });
  else if (restored !== null) p.view.dispatch({ effects: EditorView.scrollIntoView(restored, { y: "center" }) });
  if (!sameCfg(p.cfg, cfg)) configurePane(pane, cfg);
  if (pane === focusedPane) reportCursor(p.view.state);
  if (focus) p.view.focus();
}

/** Reconfigures the focused pane's document (mode switch, rename, spellcheck language). */
export function configure(cfg: EditorConfig) {
  configurePane(focusedPane, cfg);
}

export function configurePane(pane: string, cfg: EditorConfig) {
  const p = panes.get(pane);
  if (!p?.doc) return;
  const d = docs.get(p.doc)!;
  const prev = p.cfg;
  p.cfg = cfg;
  if (d.owner === pane) d.cfg = cfg;
  const effects = [];
  if (!prev || prev.mode !== cfg.mode || prev.path !== cfg.path || prev.headNote !== cfg.headNote || prev.largeNote !== cfg.largeNote) effects.push(modeConf.reconfigure(modeExt(cfg)));
  if (!prev || prev.spell !== cfg.spell || prev.mode !== cfg.mode) effects.push(spellConf.reconfigure(cfg.spell ? spellcheck(cfg.spell, cfg.mode) : []));
  if (effects.length) p.view.dispatch({ effects });
}

/**
 * This editor's document `id` has a new path or language: new highlighting and tooling, same text,
 * cursor and undo history. Also for a background tab, whose stored path would otherwise be stale.
 */
export function refreshLanguage(id: string, path: string | null) {
  const d = docs.get(id);
  if (!d?.cfg) return; // not shown yet: it's configured with the current path when activated
  d.cfg = { ...d.cfg, path };
  const shown = panesOf(id);
  for (const [, p] of shown) {
    p.cfg = { ...(p.cfg ?? d.cfg), path };
    p.view.dispatch({ effects: modeConf.reconfigure(modeExt(p.cfg)) });
  }
  if (!d.owner) d.state = d.state.update({ effects: modeConf.reconfigure(modeExt(d.cfg)) }).state;
}

export function getText(id: string): string {
  return stateOf(id)?.doc.toString() ?? "";
}

export function getDoc(id: string): Text | null {
  return stateOf(id)?.doc ?? null;
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
  focused()?.view.focus();
}

/** The focused pane's view. */
export function getView() {
  return focused()?.view ?? null;
}

/** Views showing document `id`, with the mode each shows it in (the focused pane first). */
export function viewsOf(id: string): { view: EditorView; mode: Mode | null; pane: string }[] {
  return panesOf(id)
    .sort(([a], [b]) => Number(b === focusedPane) - Number(a === focusedPane))
    .map(([pane, p]) => ({ view: p.view, mode: p.cfg?.mode ?? null, pane }));
}

/** The pane a view belongs to. */
export function paneOfView(view: EditorView): string | null {
  for (const [id, p] of panes) if (p.view === view) return id;
  return null;
}

/**
 * Applies changes to a document from outside the main view (find/replace, search preview).
 * Open tabs keep undo history; the dirty flag (and with it autosave) updates as usual.
 */
export function applyChanges(id: string, spec: Pick<import("@codemirror/state").TransactionSpec, "changes" | "annotations">) {
  const d = docs.get(id);
  if (!d) return;
  const view = ownerView(id);
  if (view) {
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
  const view = getView();
  if (view) view.dispatch(setDiagnostics(view.state, []));
}

/** Binds/unbinds a live-collaboration extension (yCollab) to a document. */
export function setCollab(id: string, ext: import("@codemirror/state").Extension | null) {
  const d = docs.get(id);
  if (!d) return;
  d.collab = ext;
  if (d.cfg === null) return; // state created lazily with the binding
  const effects = collabConf.reconfigure(ext ?? []);
  const view = ownerView(id);
  if (view) view.dispatch({ effects });
  else d.state = d.state.update({ effects }).state;
}

/** Mode the focused pane's document is configured for (null without a document there). */
export function activeMode(): Mode | null {
  const p = focused();
  return (p?.doc && p.cfg?.mode) || null;
}

/** The document is shown in some pane (its state lives in a view, with the collaboration binding). */
export function isActive(id: string) {
  return !!docs.get(id)?.owner;
}

export function hasDoc(id: string) {
  return docs.has(id);
}
