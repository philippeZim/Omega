/** LSP document highlights: other uses of the symbol at the cursor, marked subtly and never animated. */
import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { LspClient } from "./lsp.svelte";

/** Pause after the cursor moves or the text changes before asking the server. */
export const HIGHLIGHT_MS = 200;
/** More than this in one file is noise, and slow to draw. */
const MAX_HIGHLIGHTS = 2000;

const MARKS = {
  text: Decoration.mark({ class: "cm-lspHighlight" }),
  read: Decoration.mark({ class: "cm-lspHighlight cm-lspHighlight-read" }),
  write: Decoration.mark({ class: "cm-lspHighlight cm-lspHighlight-write" }),
};

const isPos = (p: any) => Number.isInteger(p?.line) && p.line >= 0 && Number.isInteger(p?.character) && p.character >= 0;

/** The server's highlights as decorations; anything malformed or outside the text is left out. */
export function highlightDecorations(doc: Text, items: unknown): DecorationSet {
  if (!Array.isArray(items)) return Decoration.none;
  const out: Range<Decoration>[] = [];
  for (const item of items.slice(0, MAX_HIGHLIGHTS)) {
    const { start, end } = item?.range ?? {};
    if (!isPos(start) || !isPos(end) || start.line >= doc.lines || end.line >= doc.lines) continue;
    const a = doc.line(start.line + 1);
    const b = doc.line(end.line + 1);
    const from = Math.min(a.to, a.from + start.character);
    const to = Math.min(b.to, b.from + end.character);
    if (from >= to) continue;
    out.push((item.kind === 3 ? MARKS.write : item.kind === 2 ? MARKS.read : MARKS.text).range(from, to));
  }
  return Decoration.set(out, true);
}

const setHighlights = StateEffect.define<DecorationSet>();

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHighlights)) next = e.value;
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function touches(set: DecorationSet, pos: number) {
  let hit = false;
  set.between(pos, pos, () => {
    hit = true;
    return false;
  });
  return hit;
}

const theme = EditorView.baseTheme({
  ".cm-lspHighlight": { backgroundColor: "rgba(var(--fg-rgb), 0.08)", borderRadius: "2px" },
  ".cm-lspHighlight-write": { backgroundColor: "rgba(var(--fg-rgb), 0.11)", boxShadow: "inset 0 -1px 0 rgba(var(--fg-rgb), 0.45)" },
});

export function documentHighlights(getClient: () => LspClient | null, getUri: () => string, flush: () => void): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: number | undefined;
      /** Identifies the latest request: an older answer is dropped. */
      seq = 0;
      destroyed = false;
      constructor(readonly view: EditorView) {}

      show(set: DecorationSet) {
        if (this.destroyed || (set.size === 0 && this.view.state.field(field).size === 0)) return;
        this.view.dispatch({ effects: setHighlights.of(set) });
      }
      schedule() {
        clearTimeout(this.timer);
        const my = ++this.seq;
        this.timer = window.setTimeout(() => void this.request(my), HIGHLIGHT_MS);
      }
      async request(my: number) {
        const client = getClient();
        const { state } = this.view;
        const sel = state.selection.main;
        if (!client?.capabilities.documentHighlightProvider || !sel.empty) return this.show(Decoration.none);
        flush();
        const line = state.doc.lineAt(sel.head);
        const res = await client
          .request("textDocument/documentHighlight", { textDocument: { uri: getUri() }, position: { line: line.number - 1, character: sel.head - line.from } }, 5000)
          .catch(() => null);
        if (my !== this.seq || this.destroyed || this.view.state.doc !== state.doc) return;
        this.show(highlightDecorations(state.doc, res));
      }
      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet) return;
        const sel = u.state.selection.main;
        // Still on the marked symbol: the marks are right, so nothing redraws.
        if (!u.docChanged && sel.empty && touches(u.state.field(field), sel.head)) {
          clearTimeout(this.timer);
          this.seq++;
          return;
        }
        this.schedule();
      }
      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
      }
    },
  );
  return [field, plugin, theme];
}
