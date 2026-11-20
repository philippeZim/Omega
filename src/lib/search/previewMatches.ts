/** Match highlighting for the Find in Files preview editor. */
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

/** Dispatch this when the query (or its options) changed, so the highlights are rebuilt. */
export const refreshMatches = StateEffect.define<null>();

/** Highlights every match of `regex()` in the visible part of the editor. */
export function matchHighlighter(regex: () => RegExp | null) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(v: EditorView) {
        this.decorations = this.build(v);
      }
      update(u: ViewUpdate) {
        const refresh = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMatches)));
        if (refresh || u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
      }
      build(v: EditorView) {
        const re = regex();
        const b = new RangeSetBuilder<Decoration>();
        if (!re) return b.finish();
        for (const { from, to } of v.visibleRanges) {
          const text = v.state.sliceDoc(from, to);
          re.lastIndex = 0;
          for (let m; (m = re.exec(text)); ) {
            if (!m[0].length) { re.lastIndex++; continue; }
            b.add(from + m.index, from + m.index + m[0].length, Decoration.mark({ class: "find-match" }));
          }
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
