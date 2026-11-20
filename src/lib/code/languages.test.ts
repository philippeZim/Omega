import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { detectIndent, indentFor, langFor } from "./languages";

// #118: Enter/Tab must follow the file's indentation, not a fixed one per language.
describe("detectIndent", () => {
  test("tabs", () => {
    expect(detectIndent("def f(x):\n\tif x:\n\t\treturn 1\n\treturn 2")).toBe("\t");
  });

  test("the most common space step", () => {
    expect(detectIndent("function f() {\n    if (x) {\n        y();\n    }\n}")).toBe("    ");
    expect(detectIndent("a:\n  b:\n    c: 1\n  d: 2")).toBe("  ");
  });

  test("null without enough indented lines", () => {
    expect(detectIndent("a\nb\nc")).toBeNull();
    expect(detectIndent("a\n    b")).toBeNull();
    expect(detectIndent("")).toBeNull();
  });
});

describe("indentFor", () => {
  const unit = (path: string, doc: string) => EditorState.create({ doc, extensions: indentFor(langFor(path)) }).facet(indentUnit);

  test("uses the file's indentation", () => {
    expect(unit("code.py", "def f(x):\n\tif x:\n\t\treturn 1\n\treturn 2")).toBe("\t");
    expect(unit("code.js", "function f() {\n    if (x) {\n        y();\n    }\n}")).toBe("    ");
  });

  test("falls back to the language convention", () => {
    expect(unit("code.js", "x")).toBe("  ");
    expect(unit("code.py", "x")).toBe("    ");
  });
});
