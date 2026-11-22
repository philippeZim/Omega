import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forEachDiagnostic, type Diagnostic } from "@codemirror/lint";
import { applyItem, lspExtension, renderDoc, setLspHooks, toOffset, toPos } from "./lspExtension";
import { fileUri, registerShadow } from "./lsp.svelte";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";
import { runViewAction, viewActionState } from "../editorActions";
import { indentFor, langFor } from "./languages";

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

describe("renderDoc", () => {
  test("plaintext shows <, > and & literally", () => {
    const el = renderDoc({ kind: "plaintext", value: "Vec<T> && Option<&str>" })!;
    expect(el.textContent).toBe("Vec<T> && Option<&str>");
  });

  test("plaintext cannot inject markup", () => {
    const el = renderDoc({ kind: "plaintext", value: '<img src=x onerror="alert(1)"><script>x</script>' })!;
    expect(el.children.length).toBe(0);
    expect(el.textContent).toContain("<img");
  });

  test("plaintext keeps markdown characters and line breaks", () => {
    const el = renderDoc({ kind: "plaintext", value: "a `b` **c**\nnext" })!;
    expect(el.children.length).toBe(0);
    expect(el.textContent).toBe("a `b` **c**\nnext");
  });

  test("empty plaintext renders nothing", () => {
    expect(renderDoc({ kind: "plaintext", value: "  " })).toBeNull();
  });

  test("markdown is still escaped once", () => {
    const el = renderDoc({ kind: "markdown", value: "`Vec<T>` <img src=x>" })!;
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("code")!.textContent).toBe("Vec<T>");
  });
});

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

  test("a quoted insertText takes the place of the typed quote", () => {
    const v = view('route("');
    applyItem(v, { label: '"/api"', insertText: '"/api"' }, 7, 7);
    expect(v.state.doc.toString()).toBe('route("/api"');
  });

  test("a quoted insertText also takes the place of the auto-closed quote", () => {
    const v = view('route("")');
    applyItem(v, { label: '"/api"', insertText: '"/api"' }, 7, 7);
    expect(v.state.doc.toString()).toBe('route("/api")');
    expect(v.state.selection.main.head).toBe(12);
  });

  test("a textEdit up to the cursor doesn't leave the auto-closed quote behind", () => {
    const v = view('route("")');
    applyItem(v, { label: '"/api"', textEdit: { range: range(0, 6, 0, 7), newText: '"/api"' } }, 7, 7);
    expect(v.state.doc.toString()).toBe('route("/api")');
  });

  test("a textEdit range past the cursor is replaced", () => {
    const v = view('route("")');
    applyItem(v, { label: '"/api"', textEdit: { range: range(0, 6, 0, 8), newText: '"/api"' } }, 7, 7);
    expect(v.state.doc.toString()).toBe('route("/api")');
  });

  test("a textEdit range end moves with what was typed after the request", () => {
    const v = view('route("/a")');
    applyItem(v, { label: '"/api"', textEdit: { range: range(0, 6, 0, 8), newText: '"/api"' } }, 7, 9, 7);
    expect(v.state.doc.toString()).toBe('route("/api")');
  });

  test("a quote that closes an earlier string or starts the next one stays", () => {
    const after = view('"abc"');
    applyItem(after, { label: '"d"', insertText: '"d"' }, 5, 5);
    expect(after.state.doc.toString()).toBe('"abc""d"');
    const before = view('f("bar")');
    applyItem(before, { label: '"d"', insertText: '"d"' }, 2, 2);
    expect(before.state.doc.toString()).toBe('f("d""bar")');
  });

  test("a completion without quotes inside a string keeps the quotes", () => {
    const v = view('"fo"');
    applyItem(v, { label: "foo", insertText: "foo" }, 1, 3);
    expect(v.state.doc.toString()).toBe('"foo"');
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
    exitListeners: new Set<() => void>(),
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

describe("lspExtension formatting", () => {
  const optionsFor = async (path: string, doc: string) => {
    const c = fakeClient({ capabilities: { documentFormattingProvider: true } });
    m.client = c;
    const v = view(doc, [indentFor(langFor(path)), lspExtension(PATH, LANG)]);
    await vi.waitFor(() => expect(c.open).toHaveBeenCalled());
    runViewAction(v, "lsp.format");
    await vi.waitFor(() => expect(c.request).toHaveBeenCalled());
    const call = c.request.mock.calls.find((x: any[]) => x[0] === "textDocument/formatting") as any[];
    return call[1].options;
  };

  test("a file indented with tabs is formatted with tabs", async () => {
    expect(await optionsFor("a.py", "def f():\n\tif x:\n\t\treturn 1\n")).toEqual({ tabSize: 4, insertSpaces: false });
  });

  test("a file indented with two spaces keeps two spaces", async () => {
    expect(await optionsFor("a.py", "def f():\n  if x:\n    return 1\n")).toEqual({ tabSize: 2, insertSpaces: true });
  });

  test("clangd's result keeps the file's tabs", async () => {
    const edits = [{ range: range(1, 0, 1, 1), newText: "  " }, { range: range(1, 3, 1, 4), newText: "" }, { range: range(2, 0, 2, 1), newText: "  " }];
    const c = fakeClient({ capabilities: { documentFormattingProvider: true }, request: vi.fn(async () => edits) });
    m.client = c;
    const v = view("void f() {\n\tg( );\n\th();\n}\n", [lspExtension("/w/proj/main.c", { server: "clangd", lspId: "c" } as any)]);
    await vi.waitFor(() => expect(c.open).toHaveBeenCalled());
    runViewAction(v, "lsp.format");
    await vi.waitFor(() => expect(v.state.doc.toString()).toBe("void f() {\n\tg();\n\th();\n}\n"));
  });

  test("clangd edits that make no sense change nothing and don't throw", async () => {
    const c = fakeClient({ capabilities: { documentFormattingProvider: true }, request: vi.fn(async () => [{ range: range(2, 0, 0, 0), newText: "x" }]) });
    m.client = c;
    const text = "void f() {\n\tg();\n\th();\n}\n";
    const v = view(text, [lspExtension("/w/proj/main.c", { server: "clangd", lspId: "c" } as any)]);
    await vi.waitFor(() => expect(c.open).toHaveBeenCalled());
    runViewAction(v, "lsp.format");
    await vi.waitFor(() => expect(c.request).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(v.state.doc.toString()).toBe(text);
  });

  test("without indentation the language's convention counts", async () => {
    expect(await optionsFor("a.ts", "let x = 1;\n")).toEqual({ tabSize: 2, insertSpaces: true });
    expect(await optionsFor("a.py", "x = 1\n")).toEqual({ tabSize: 4, insertSpaces: true });
  });
});

describe("lspExtension signature help", () => {
  test("typing a trigger character shows the server's signature", async () => {
    const help = { signatures: [{ label: "f(int a)", parameters: [{ label: "int a" }] }], activeParameter: 0 };
    const c = fakeClient({ capabilities: { signatureHelpProvider: { triggerCharacters: ["("] } }, request: vi.fn(async () => help) });
    const v = await mountWith(c, "f");
    v.dispatch({ changes: { from: 1, insert: "(" }, selection: { anchor: 2 }, userEvent: "input.type" });
    await vi.waitFor(() => expect(v.dom.querySelector(".lsp-signature-active")?.textContent).toBe("int a"));
    expect(c.request).toHaveBeenCalledWith("textDocument/signatureHelp", expect.objectContaining({ textDocument: { uri: URI } }), 5000);
  });
});

describe("lspExtension document highlights", () => {
  test("marks the server's occurrences of the symbol at the cursor", async () => {
    const c = fakeClient({ capabilities: { documentHighlightProvider: true }, request: vi.fn(async () => [{ range: range(0, 0, 0, 1), kind: 3 }, { range: range(0, 4, 0, 5), kind: 2 }]) });
    const v = await mountWith(c, "a = a");
    v.dispatch({ selection: { anchor: 4 } });
    await vi.waitFor(() => expect(v.contentDOM.querySelectorAll(".cm-lspHighlight").length).toBe(2));
    expect(c.request).toHaveBeenCalledWith("textDocument/documentHighlight", { textDocument: { uri: URI }, position: pos(0, 4) }, 5000);
  });
});

describe("lspExtension go to implementation, type definition, declaration", () => {
  const CAPS = { implementationProvider: true, typeDefinitionProvider: true, declarationProvider: true };
  const hit = (uri: string, line: number) => ({ uri, range: range(line, 2, line, 3) });

  test.each([
    ["lsp.gotoImplementation", "textDocument/implementation"],
    ["lsp.gotoTypeDefinition", "textDocument/typeDefinition"],
    ["lsp.gotoDeclaration", "textDocument/declaration"],
  ])("%s asks the server and goes to the one result", async (id, method) => {
    const navigate = vi.fn(async () => {});
    setLspHooks({ workspace: () => null, askInstall: async () => false, navigate });
    const c = fakeClient({ capabilities: CAPS, request: vi.fn(async () => [hit(fileUri("/w/proj/b.py"), 7)]) });
    const v = await mountWith(c, "abc");
    v.dispatch({ selection: { anchor: 2 } });
    runViewAction(v, id);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/w/proj/b.py", 7, 2));
    expect(c.request).toHaveBeenCalledWith(method, { textDocument: { uri: URI }, position: pos(0, 2) });
  });

  test("several results open a picker that navigates", async () => {
    const navigate = vi.fn(async () => {});
    setLspHooks({ workspace: () => null, askInstall: async () => false, navigate });
    const c = fakeClient({ capabilities: CAPS, request: vi.fn(async () => [hit(fileUri("/w/proj/b.py"), 1), hit(fileUri("/w/proj/c.py"), 2)]) });
    const v = await mountWith(c, "abc");
    vi.mocked(ui.openMenu).mockClear();
    runViewAction(v, "lsp.gotoImplementation");
    await vi.waitFor(() => expect(ui.openMenu).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    const items = vi.mocked(ui.openMenu).mock.calls[0][1];
    expect(items.map((i) => i.label)).toEqual(["b.py:2", "c.py:3"]);
    items[1].action!();
    expect(navigate).toHaveBeenCalledWith("/w/proj/c.py", 2, 2);
  });

  test("a result in a private copy opens the real file", async () => {
    const navigate = vi.fn(async () => {});
    setLspHooks({ workspace: () => null, askInstall: async () => false, navigate });
    registerShadow("/w/proj/real.txt", "/priv/lsp/real.py", "/priv/lsp");
    const c = fakeClient({ capabilities: CAPS, request: vi.fn(async () => [hit(fileUri("/priv/lsp/real.py"), 3)]) });
    const v = await mountWith(c, "abc");
    runViewAction(v, "lsp.gotoTypeDefinition");
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/w/proj/real.txt", 3, 2));
  });

  test("no result, or a server without the feature, says so", async () => {
    const c = fakeClient({ capabilities: { implementationProvider: true }, request: vi.fn(async () => null) });
    const v = await mountWith(c, "abc");
    vi.mocked(ui.toast).mockClear();
    runViewAction(v, "lsp.gotoImplementation");
    await vi.waitFor(() => expect(ui.toast).toHaveBeenCalledWith(t("code.lsp.gotoNone")));
    vi.mocked(ui.toast).mockClear();
    runViewAction(v, "lsp.gotoDeclaration");
    expect(ui.toast).toHaveBeenCalledWith(t("code.lsp.gotoUnsupported"));
    expect(c.request).toHaveBeenCalledTimes(1);
  });

  test("the context menu can tell what the server supports", async () => {
    const c = fakeClient({ capabilities: { implementationProvider: true } });
    const v = await mountWith(c, "abc");
    expect(viewActionState(v, "lsp.gotoImplementation")).toBe("enabled");
    expect(viewActionState(v, "lsp.gotoDeclaration")).toBe("disabled");
    expect(viewActionState(v, "lsp.nothing")).toBeNull();
  });
});

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
    expect(c.exitListeners.size).toBe(0);
  });

  // #116: an editor without a client (server failed or was missing) connects after a manual restart.
  test("an editor without a client connects after restartServer", async () => {
    const { restartListeners } = await import("./lsp.svelte");
    m.client = null;
    const v = view("x = 1\n", [lspExtension(PATH, LANG)]);
    await new Promise((r) => setTimeout(r, 10));
    const c = fakeClient();
    m.client = c;
    for (const l of restartListeners) l();
    await vi.waitFor(() => expect(c.open).toHaveBeenCalledWith(URI, "python", "x = 1\n"));
    v.destroy();
    expect(restartListeners.size).toBe(0);
  });

  // #111: after a server crash the editor kept the dead client (and its diagnostics) until the tab was switched.
  test("server exit clears stale diagnostics and reconnects to the restarted server", async () => {
    const c = fakeClient();
    c.diagnostics.set(URI, [{ range: range(0, 0, 0, 1), severity: 1, message: "old" }]);
    const v = await mountWith(c, "a = 1\n");
    await vi.waitFor(() => expect(diagsOf(v).map((d) => d.message)).toEqual(["old"]));
    const next = fakeClient();
    m.client = next;
    for (const l of [...c.exitListeners]) l();
    expect(diagsOf(v)).toEqual([]);
    expect(c.diagnosticListeners.size).toBe(0);
    await vi.waitFor(() => expect(next.open).toHaveBeenCalledWith(URI, "python", "a = 1\n"), { timeout: 3000 });
    expect(next.diagnosticListeners.size).toBe(1);
    expect(next.exitListeners.size).toBe(1);
  });
});
