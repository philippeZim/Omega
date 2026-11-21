import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseTheme, proseLayout } from "./theme";

describe("proseLayout", () => {
  // #46: baseTheme's ".cm-content" padding (12px 0) won over the prose column padding.
  test("keeps its padding with baseTheme first, as in editor.ts", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "x", extensions: [baseTheme, proseLayout] }), parent: document.body });
    const s = getComputedStyle(view.contentDOM);
    expect([s.paddingTop, s.paddingLeft, s.paddingRight]).toEqual(["48px", "32px", "32px"]);
    view.destroy();
  });
});
