import { describe, expect, test, vi } from "vitest";

const modePaths = vi.hoisted(() => [] as (string | null)[]);
vi.mock("./modes", () => ({ modeExtensions: (_m: string, p: string | null) => (modePaths.push(p), []) }));
vi.mock("./spell", () => ({ spellcheck: () => [] }));

const ed = await import("./editor");

// #120: closing a file and opening it again (also Reopen Closed Tab) keeps the cursor.
describe("cursor of a reopened file", () => {
  const cfg = (path: string) => ({ mode: "text" as const, path, spell: null });
  const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

  test("is restored by path", () => {
    ed.mount(document.createElement("div")); // detached: happy-dom selection events would re-enter CodeMirror
    ed.createDoc("a", text);
    ed.activate("a", cfg("/p/big.log"));
    const pos = ed.getView()!.state.doc.line(150).from + 3;
    ed.getView()!.dispatch({ selection: { anchor: pos } });
    ed.activate(null, cfg("/p/big.log"));
    ed.disposeDoc("a");

    ed.createDoc("b", text);
    ed.activate("b", cfg("/p/big.log"));
    expect(ed.getView()!.state.selection.main.head).toBe(pos);

    // Another file starts at the top; a shorter file clamps the position.
    ed.createDoc("c", text);
    ed.activate("c", cfg("/p/other.log"));
    expect(ed.getView()!.state.selection.main.head).toBe(0);
    ed.activate("b", cfg("/p/big.log"));
    ed.disposeDoc("b");
    ed.createDoc("d", "short");
    ed.activate("d", cfg("/p/big.log"));
    expect(ed.getView()!.state.selection.main.head).toBe(5);
  });
});

describe("refreshLanguage", () => {
  const cfg = (path: string) => ({ mode: "code" as const, path, spell: null });

  test("a renamed background tab gets the new path, keeping its text and undo", () => {
    ed.mount(document.createElement("div"));
    ed.createDoc("bg", "abc");
    ed.activate("bg", cfg("/p/old"));
    ed.applyChanges("bg", { changes: { from: 3, insert: "d" } });
    ed.createDoc("fg", "x");
    ed.activate("fg", cfg("/p/front"));
    modePaths.length = 0;
    ed.refreshLanguage("bg", "/p/new");
    expect(modePaths).toEqual(["/p/new"]);
    expect(ed.getText("bg")).toBe("abcd");
    // Coming back with the same path needs no second reconfigure: the stored path is the new one.
    modePaths.length = 0;
    ed.activate("bg", cfg("/p/new"));
    expect(modePaths).toEqual([]);
  });

  test("a tab not shown yet is left to its first activation", () => {
    ed.createDoc("lazy", "x");
    modePaths.length = 0;
    ed.refreshLanguage("lazy", "/p/z");
    expect(modePaths).toEqual([]);
  });
});

// #174: the start of a too large file: labelled, and nothing can change it.
describe("read-only head view", () => {
  test("rejects every change, shows its banner and skips the mode's extensions", () => {
    ed.mount(document.createElement("div"));
    modePaths.length = 0;
    ed.createDoc("head", "first lines");
    ed.activate("head", { mode: "code", path: null, spell: null, headNote: "Read-only: first 1 MB of 1 GB" });
    const view = ed.getView()!;
    expect(modePaths).toEqual([]);
    expect(view.state.readOnly).toBe(true);
    expect(view.dom.querySelector(".cm-head-note")?.textContent).toBe("Read-only: first 1 MB of 1 GB");
    view.dispatch({ changes: { from: 0, insert: "x" } });
    ed.applyChanges("head", { changes: { from: 0, insert: "y" } });
    expect(ed.getText("head")).toBe("first lines");
    expect(ed.isDirty("head")).toBe(false);
    ed.activate(null, { mode: "code", path: null, spell: null });
    ed.disposeDoc("head");
  });
});

describe("large file in full (#174)", () => {
  test("stays editable, shows its label and skips the mode's extensions", () => {
    ed.mount(document.createElement("div"));
    modePaths.length = 0;
    ed.createDoc("large", "text");
    ed.activate("large", { mode: "code", path: "/p/big.ts", spell: null, largeNote: "Large file" });
    const view = ed.getView()!;
    expect(modePaths).toEqual([]);
    expect(view.state.readOnly).toBe(false);
    expect(view.dom.querySelector(".cm-large-note")?.textContent).toBe("Large file");
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(ed.getText("large")).toBe("xtext");
    ed.activate(null, { mode: "code", path: null, spell: null });
    ed.disposeDoc("large");
  });
});

