import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forEachDiagnostic, type Diagnostic } from "@codemirror/lint";
import { applyItem, lspExtension, toOffset, toPos } from "./lspExtension";
import { fileUri } from "./lsp.svelte";

const m = vi.hoisted(() => ({ client: null as any }));

// rpc.ts/tools.svelte.ts listen to Tauri events at import time; not needed here.
vi.mock("../rpc", () => ({ onRpc: () => () => {} }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true, withInstallProgress: async () => {}, serverProgressId: (k: string) => k }));
vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn(), openMenu: vi.fn() } }));
vi.mock("./lsp.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lsp.svelte")>()),
  clientFor: async () => m.client,
}));

let views: EditorView[] = [];
function view(doc: string, extensions: any[] = []) {
  const v = new EditorView({ state: EditorState.create({ doc, extensions }), parent: document.body });
  views.push(v);
  return v;
}
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
});

const pos = (line: number, character: number) => ({ line, character });
const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: pos(l1, c1), end: pos(l2, c2) });

// ---------------------------------------------------------------- positions

describe("toPos / toOffset", () => {
  const doc = EditorState.create({ doc: "ab\ncdé\n\nlast" }).doc;
  test("round trip", () => {
    for (let o = 0; o <= doc.length; o++) expect(toOffset(doc, toPos(doc, o))).toBe(o);
    expect(toPos(doc, 4)).toEqual(pos(1, 1));
  });
  test("clamps past the line end and past the last line", () => {
    expect(toOffset(doc, pos(0, 50))).toBe(2);
    expect(toOffset(doc, pos(10, 0))).toBe(doc.length);
  });
});

// ---------------------------------------------------------------- completion apply

describe("applyItem", () => {
  test("insertText replaces from..to", () => {
    const v = view("obj.fo");
    applyItem(v, { label: "foo()", insertText: "foo" }, 4, 6);
    expect(v.state.doc.toString()).toBe("obj.foo");
  });

  test("falls back to the label", () => {
    const v = view("pri");
    applyItem(v, { label: "print" }, 0, 3);
    expect(v.state.doc.toString()).toBe("print");
  });

  test("textEdit range start wins over `from`", () => {
    // e.g. clangd replacing "->" member access: range starts before the word.
    const v = view("p.fo");
    applyItem(v, { label: "foo", textEdit: { range: range(0, 1, 0, 4), newText: "->foo" } }, 2, 4);
    expect(v.state.doc.toString()).toBe("p->foo");
  });

  test("InsertReplaceEdit uses the insert range", () => {
    const v = view("x.ab");
    applyItem(v, { label: "abc", textEdit: { insert: range(0, 2, 0, 4), replace: range(0, 2, 0, 4), newText: "abc" } }, 2, 4);
    expect(v.state.doc.toString()).toBe("x.abc");
  });

  test("snippet (insertTextFormat 2) expands placeholders", () => {
    const v = view("ma");
    applyItem(v, { label: "max", insertText: "max(${1:a}, $2)$0", insertTextFormat: 2 }, 0, 2);
    expect(v.state.doc.toString()).toBe("max(a, )");
    // First placeholder selected.
    const sel = v.state.selection.main;
    expect(v.state.sliceDoc(sel.from, sel.to)).toBe("a");
  });

  test("plain text is not treated as a snippet", () => {
    const v = view("");
    applyItem(v, { label: "x", insertText: "cost $1", insertTextFormat: 1 }, 0, 0);
    expect(v.state.doc.toString()).toBe("cost $1");
  });

  test("additionalTextEdits above the cursor shift the insert position", () => {
    const v = view("x = pa");
    applyItem(
      v,
      { label: "path", insertText: "path", additionalTextEdits: [{ range: range(0, 0, 0, 0), newText: "from os import path\n" }] },
      4,
      6,
    );
    expect(v.state.doc.toString()).toBe("from os import path\nx = path");
  });
});

// ---------------------------------------------------------------- diagnostics via the extension

const PATH = "/w/proj/main.py";
const URI = fileUri(PATH);
const LANG = { server: "python", lspId: "python" } as any;

function fakeClient(over: Record<string, any> = {}) {
  return {
    capabilities: {},
    diagnostics: new Map<string, any[]>(),
    diagnosticListeners: new Set<(u: string) => void>(),
    open: vi.fn(),
    change: vi.fn(),
    request: vi.fn(async () => null),
    ...over,
  };
}

function diagsOf(v: EditorView) {
  const out: (Diagnostic & { at: [number, number] })[] = [];
  forEachDiagnostic(v.state, (d, from, to) => out.push({ ...d, at: [from, to] }));
  return out;
}

async function mountWith(client: any, doc: string) {
  m.client = client;
  const v = view(doc, [lspExtension(PATH, LANG)]);
  await vi.waitFor(() => expect(client.open).toHaveBeenCalled());
  return v;
}

describe("lspExtension diagnostics", () => {
  beforeEach(() => {
    m.client = null;
  });

  test("opens the document and maps LSP diagnostics to CodeMirror diagnostics", async () => {
    const doc = "def f():\n    retrun x\n";
    const c = fakeClient();
    c.diagnostics.set(URI, [
      { range: range(1, 4, 1, 10), severity: 1, message: "undefined name", source: "pyright" },
      { range: range(1, 11, 1, 11), severity: 2, message: "empty range" },
      { range: range(0, 0, 0, 3), severity: 3, message: "info" },
      { range: range(0, 4, 0, 5), severity: 4, message: "hint" },
      { range: range(0, 4, 0, 5), message: "no severity" },
      { range: range(40, 0, 40, 5), severity: 1, message: "past the end" },
    ]);
    const v = await mountWith(c, doc);
    expect(c.open).toHaveBeenCalledWith(URI, "python", doc);
    expect(c.diagnosticListeners.size).toBe(1);
    await vi.waitFor(() => expect(diagsOf(v).length).toBe(6));
    const d = diagsOf(v).map((x) => [x.message, x.severity, x.at, x.source]);
    expect(d).toEqual(
      expect.arrayContaining([
        ["undefined name", "error", [13, 19], "pyright"],
        ["empty range", "warning", [20, 21], undefined], // empty → one character wide
        ["info", "info", [0, 3], undefined],
        ["hint", "hint", [4, 5], undefined],
        ["no severity", "hint", [4, 5], undefined],
        ["past the end", "error", [doc.length, doc.length], undefined],
      ]),
    );
  });

  test("diagnostics for other files are ignored, updates for this file are applied", async () => {
    const c = fakeClient();
    const v = await mountWith(c, "a = 1\n");
    c.diagnostics.set(URI, [{ range: range(0, 0, 0, 1), severity: 1, message: "first" }]);
    c.diagnostics.set(fileUri("/w/proj/other.py"), [{ range: range(0, 0, 0, 1), severity: 1, message: "other" }]);
    for (const l of c.diagnosticListeners) l(fileUri("/w/proj/other.py"));
    await new Promise((r) => setTimeout(r, 10));
    expect(diagsOf(v)).toEqual([]);
    for (const l of c.diagnosticListeners) l(URI);
    await vi.waitFor(() => expect(diagsOf(v).map((d) => d.message)).toEqual(["first"]));
    c.diagnostics.set(URI, []);
    for (const l of c.diagnosticListeners) l(URI);
    await vi.waitFor(() => expect(diagsOf(v)).toEqual([]));
  });

  test("inline code actions (clangd) become applicable fixes; command-only actions are dropped", async () => {
    const c = fakeClient();
    c.diagnostics.set(URI, [
      {
        range: range(0, 0, 0, 6),
        severity: 1,
        message: "typo",
        codeActions: [
          { title: "Change to 'return'", kind: "quickfix", edit: { changes: { [URI]: [{ range: range(0, 0, 0, 6), newText: "return" }] } } },
          { title: "Run command", command: { command: "x" } },
          { title: "Refactor", kind: "refactor.extract", edit: { changes: {} } },
        ],
      },
    ]);
    const v = await mountWith(c, "retrun 1");
    await vi.waitFor(() => expect(diagsOf(v)[0]?.actions?.length).toBe(1));
    const [d] = diagsOf(v);
    expect(d.actions![0].name).toBe("Change to 'return'");
    d.actions![0].apply(v, d.at[0], d.at[1]);
    expect(v.state.doc.toString()).toBe("return 1");
  });

  test("fixes via textDocument/codeAction; edits for other documents are ignored", async () => {
    const otherUri = fileUri("/w/proj/other.py");
    // Server spells the URI differently (Windows-style casing would be normalised the same way).
    const c = fakeClient({
      capabilities: { codeActionProvider: true },
      request: vi.fn(async (method: string, params: any) => {
        if (method !== "textDocument/codeAction") return null;
        expect(params.context.only).toEqual(["quickfix"]);
        return [
          {
            title: "Import os",
            kind: "quickfix",
            edit: {
              changes: { [otherUri]: [{ range: range(0, 0, 0, 0), newText: "WRONG" }] },
              documentChanges: [{ textDocument: { uri: URI, version: 1 }, edits: [{ range: range(0, 0, 0, 0), newText: "import os\n" }] }],
            },
          },
        ];
      }),
    });
    c.diagnostics.set(URI, [
      { range: range(0, 0, 0, 2), severity: 1, message: "os undefined" },
      { range: range(0, 0, 0, 2), severity: 3, message: "info: not asked for fixes" },
    ]);
    const v = await mountWith(c, "os.getcwd()");
    await vi.waitFor(() => expect(diagsOf(v).find((d) => d.message === "os undefined")?.actions?.length).toBe(1));
    expect(c.request).toHaveBeenCalledTimes(1); // only for error/warning diagnostics
    const d = diagsOf(v).find((d) => d.message === "os undefined")!;
    d.actions![0].apply(v, d.at[0], d.at[1]);
    expect(v.state.doc.toString()).toBe("import os\nos.getcwd()");
  });

  test("edits are sent debounced; destroy flushes and unsubscribes", async () => {
    const c = fakeClient();
    const v = await mountWith(c, "a");
    v.dispatch({ changes: { from: 1, insert: "b" } });
    v.dispatch({ changes: { from: 2, insert: "c" } });
    expect(c.change).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(c.change).toHaveBeenCalledWith(URI, "abc"));
    expect(c.change).toHaveBeenCalledTimes(1);
    v.dispatch({ changes: { from: 3, insert: "d" } });
    v.destroy();
    expect(c.change).toHaveBeenLastCalledWith(URI, "abcd");
    expect(c.diagnosticListeners.size).toBe(0);
  });
});
