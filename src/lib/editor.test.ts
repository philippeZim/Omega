import { describe, expect, test, vi } from "vitest";

vi.mock("./modes", () => ({ modeExtensions: () => [] }));
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
