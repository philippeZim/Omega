import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { HIGHLIGHT_MS, documentHighlights, highlightDecorations } from "./lspHighlight";

const r = (l1: number, c1: number, l2: number, c2: number, kind?: number) => ({ range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }, ...(kind ? { kind } : {}) });

function list(set: DecorationSet) {
  const out: [number, number, string][] = [];
  set.between(0, 1e9, (from, to, d) => void out.push([from, to, String(d.spec.class)]));
  return out;
}

describe("highlightDecorations", () => {
  const doc = EditorState.create({ doc: "int a;\na = a + 1;\n" }).doc;

  test("read, write and plain occurrences get their own marks, in order", () => {
    const got = list(highlightDecorations(doc, [r(1, 4, 1, 5, 2), r(0, 4, 0, 5, 1), r(1, 0, 1, 1, 3)]));
    expect(got.map((x) => x.slice(0, 2))).toEqual([[4, 5], [7, 8], [11, 12]]);
    expect(got[0][2]).toBe("cm-lspHighlight");
    expect(got[1][2]).toContain("write");
    expect(got[2][2]).toContain("read");
  });

  test("no kind counts as plain text", () => {
    expect(list(highlightDecorations(doc, [r(0, 4, 0, 5)]))[0][2]).toBe("cm-lspHighlight");
  });

  test("malformed, empty and out-of-range entries are left out", () => {
    const bad = [null, {}, { range: null }, r(0, 4, 0, 4), r(0, 5, 0, 4), r(99, 0, 99, 1), { range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } } }];
    expect(list(highlightDecorations(doc, bad))).toEqual([]);
    expect(list(highlightDecorations(doc, null))).toEqual([]);
    expect(list(highlightDecorations(doc, "x"))).toEqual([]);
  });

  test("a range past the line's end stops at the line", () => {
    expect(list(highlightDecorations(doc, [r(0, 4, 0, 99)]))[0].slice(0, 2)).toEqual([4, 6]);
  });
});

describe("documentHighlights in the editor", () => {
  let views: EditorView[] = [];
  afterEach(() => {
    for (const v of views) v.destroy();
    views = [];
    vi.useRealTimers();
  });

  function setup(doc: string, answer: any, caps: any = { documentHighlightProvider: true }) {
    const request = vi.fn(async (..._a: any[]) => answer);
    const client: any = { capabilities: caps, request };
    const v = new EditorView({ state: EditorState.create({ doc, extensions: documentHighlights(() => client, () => "file:///a.c", vi.fn()) }), parent: document.body });
    views.push(v);
    return { v, request, client };
  }
  const marks = (v: EditorView) => v.contentDOM.querySelectorAll(".cm-lspHighlight").length;
  const tick = async (ms = HIGHLIGHT_MS) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  test("marks the occurrences after a pause", async () => {
    vi.useFakeTimers();
    const { v, request } = setup("a b a", [r(0, 0, 0, 1, 3), r(0, 4, 0, 5, 2)]);
    v.dispatch({ selection: { anchor: 4 } });
    await tick(HIGHLIGHT_MS - 1);
    expect(request).not.toHaveBeenCalled();
    await tick(1);
    expect(request.mock.calls[0][0]).toBe("textDocument/documentHighlight");
    expect(request.mock.calls[0][1]).toMatchObject({ textDocument: { uri: "file:///a.c" }, position: { line: 0, character: 4 } });
    expect(marks(v)).toBe(2);
    expect(v.contentDOM.querySelector(".cm-lspHighlight-write")!.textContent).toBe("a");
  });

  test("moving quickly asks once, for the last position", async () => {
    vi.useFakeTimers();
    const { v, request } = setup("a b a", []);
    for (const anchor of [1, 2, 3]) {
      v.dispatch({ selection: { anchor } });
      await tick(HIGHLIGHT_MS / 4);
    }
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].position.character).toBe(3);
  });

  test("moving within a marked symbol asks nothing and keeps the marks", async () => {
    vi.useFakeTimers();
    const { v, request } = setup("abc d abc", [r(0, 0, 0, 3), r(0, 6, 0, 9)]);
    v.dispatch({ selection: { anchor: 1 } });
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    v.dispatch({ selection: { anchor: 2 } });
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(marks(v)).toBe(2);
  });

  test("leaving the symbol clears the marks when the answer arrives, not before", async () => {
    vi.useFakeTimers();
    const { v, request } = setup("abc d abc", [r(0, 0, 0, 3), r(0, 6, 0, 9)]);
    v.dispatch({ selection: { anchor: 1 } });
    await tick();
    request.mockResolvedValue([]);
    v.dispatch({ selection: { anchor: 5 } });
    expect(marks(v)).toBe(2);
    await tick();
    expect(marks(v)).toBe(0);
  });

  test("a selection clears them without asking", async () => {
    vi.useFakeTimers();
    const { v, request } = setup("abc d abc", [r(0, 0, 0, 3)]);
    v.dispatch({ selection: { anchor: 1 } });
    await tick();
    v.dispatch({ selection: { anchor: 4, head: 5 } });
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(marks(v)).toBe(0);
  });

  test("an answer for older text is dropped, marks move with edits", async () => {
    vi.useFakeTimers();
    const { v, request } = setup("abc abc", [r(0, 0, 0, 3), r(0, 4, 0, 7)]);
    v.dispatch({ selection: { anchor: 1 } });
    await tick();
    let answer!: (x: any) => void;
    request.mockImplementation(() => new Promise((res) => (answer = res)));
    v.dispatch({ selection: { anchor: 3 }, changes: { from: 0, insert: "  " } });
    await tick();
    v.dispatch({ changes: { from: 0, insert: "#" } });
    answer([r(0, 0, 0, 1)]);
    await vi.advanceTimersByTimeAsync(0);
    const texts = [...v.contentDOM.querySelectorAll(".cm-lspHighlight")].map((e) => e.textContent);
    expect(texts).toEqual(["abc", "abc"]);
  });

  test("a server without the feature is never asked", async () => {
    vi.useFakeTimers();
    const { v, request } = setup("abc", [], {});
    v.dispatch({ selection: { anchor: 1 } });
    await tick();
    expect(request).not.toHaveBeenCalled();
  });

  test("the marks are not animated", () => {
    const { v } = setup("abc", []);
    const css = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    const rules = css.split("}").filter((rule) => rule.includes("cm-lspHighlight"));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/animation|transition|transform|opacity/);
    expect(v).toBeTruthy();
  });
});
