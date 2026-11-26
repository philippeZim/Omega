import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * Gutters are sticky only while the editor is scrolled sideways (#297).
 *
 * CodeMirror makes `.cm-gutters` `position: sticky` so line numbers stay put when long lines are
 * scrolled sideways. WebKitGTK composites a sticky box in a scroll container as its own layer, and
 * whenever CodeMirror puts in new line numbers during vertical scrolling that layer is shown empty
 * for a frame: the numbers flicker (screen recording: 8 blank frames in 4 s of wheel scrolling,
 * none without sticky). Scrolled fully left, which is nearly always (and always with line
 * wrapping), a plain box sits at exactly the same place, so sticky is switched on only once the
 * editor actually is scrolled sideways.
 */
export const stickyGuttersWhenScrolled = [
  ViewPlugin.fromClass(
    class {
      on = false;
      constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener("scroll", this.check, { passive: true });
        this.check();
      }
      check = () => {
        const on = this.view.scrollDOM.scrollLeft > 0;
        if (on === this.on) return;
        this.on = on;
        this.view.scrollDOM.toggleAttribute("data-hscrolled", on);
      };
      destroy() {
        this.view.scrollDOM.removeEventListener("scroll", this.check);
      }
    },
  ),
  // CodeMirror sets sticky as an inline style, so only !important outranks it.
  EditorView.theme({ ".cm-scroller:not([data-hscrolled]) > .cm-gutters": { position: "relative !important" } }),
];
