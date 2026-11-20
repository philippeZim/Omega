import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { matchHighlighter, refreshMatches } from "./previewMatches";

function marked(v: EditorView) {
  return [...v.contentDOM.querySelectorAll(".find-match")].map((e) => e.textContent);
}

describe("preview match highlighter", () => {
  it("rebuilds the highlights when the query changes", () => {
    let query = "bar";
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "foo.bar\nnaïve café", extensions: matchHighlighter(() => new RegExp(query, "g")) }),
    });
    expect(marked(view)).toEqual(["bar"]);
    query = "café";
    view.dispatch({ effects: refreshMatches.of(null) });
    expect(marked(view)).toEqual(["café"]);
    view.destroy();
  });
});
