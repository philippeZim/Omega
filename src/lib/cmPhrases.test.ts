import { expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { phrases } from "./cmPhrases";
import { i18n } from "./i18n/index.svelte";

// #122: in English CodeMirror's own lowercase labels ("next", "match case", "go") were shown.
test("search and go-to-line labels are capitalised in every language", () => {
  for (const locale of ["en", "de", "fr"] as const) {
    i18n.locale = locale;
    const s = EditorState.create({ extensions: phrases() });
    for (const p of ["next", "previous", "all", "match case", "regexp", "by word", "replace", "replace all", "go"]) {
      const label = s.phrase(p);
      expect(label, `${locale}: ${p}`).not.toBe(p);
      expect(label[0], `${locale}: ${p}`).toBe(label[0].toUpperCase());
    }
  }
  i18n.locale = "en";
  expect(EditorState.create({ extensions: phrases() }).phrase("match case")).toBe("Match case");
});
