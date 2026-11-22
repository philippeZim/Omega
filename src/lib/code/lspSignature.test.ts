import { afterEach, describe, expect, test, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { activeSignature, paramRange, renderSignature, signatureHelp } from "./lspSignature";

const plainDoc = (c: any) => {
  const el = document.createElement("div");
  el.className = "doc";
  el.textContent = typeof c === "string" ? c : c.value;
  return el;
};
const HELP = { signatures: [{ label: "add(int first, int second)", parameters: [{ label: "int first" }, { label: "int second" }] }], activeSignature: 0, activeParameter: 1 };

describe("paramRange", () => {
  test("label offsets", () => expect(paramRange("f(a, b)", { label: [5, 6] })).toEqual([5, 6]));
  test("invalid offsets are ignored", () => {
    expect(paramRange("f(a)", { label: [2, 99] })).toBeNull();
    expect(paramRange("f(a)", { label: [3, 2] })).toBeNull();
  });
  test("a name matches as a whole word after the bracket", () => {
    expect(paramRange("fn(fn2, n)", { label: "n" })).toEqual([8, 9]);
  });
  test("unknown name", () => expect(paramRange("f(a)", { label: "z" })).toBeNull());
});

describe("activeSignature", () => {
  test("the signature's own active parameter comes first", () => {
    expect(activeSignature({ signatures: [{ label: "f", parameters: [{}, {}], activeParameter: 1 }], activeParameter: 0 })!.index).toBe(1);
  });
  test("out of range counts as the first, null as none", () => {
    expect(activeSignature({ signatures: [{ label: "f", parameters: [{}] }], activeParameter: 7 })!.index).toBe(0);
    expect(activeSignature({ signatures: [{ label: "f", parameters: [{}], activeParameter: null }] })!.index).toBe(-1);
  });
  test("nothing to show", () => {
    expect(activeSignature(null)).toBeNull();
    expect(activeSignature({ signatures: [] })).toBeNull();
    expect(activeSignature({ signatures: [null] })).toBeNull();
    expect(activeSignature({ signatures: ["f()"] })).toBeNull();
  });
});

describe("renderSignature", () => {
  test("marks the active parameter", () => {
    const el = renderSignature(HELP, plainDoc);
    expect(el.querySelector(".lsp-signature-active")!.textContent).toBe("int second");
    expect(el.querySelector(".lsp-signature-label")!.textContent).toBe("add(int first, int second)");
  });
  test("server text cannot inject markup", () => {
    const label = '<img src=x onerror="alert(1)">(a)';
    const el = renderSignature({ signatures: [{ label, parameters: [{ label: "a" }] }] }, plainDoc);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img");
  });
  test("shows which of several signatures, and the docs", () => {
    const el = renderSignature({ signatures: [{ label: "f()" }, { label: "f(a)", documentation: "about f", parameters: [{ label: "a", documentation: "about a" }] }], activeSignature: 1 }, plainDoc);
    expect(el.querySelector(".lsp-signature-count")!.textContent).toBe("2/2");
    expect([...el.querySelectorAll(".doc")].map((d) => d.textContent)).toEqual(["about a", "about f"]);
  });
});

describe("signatureHelp in the editor", () => {
  let views: EditorView[] = [];
  afterEach(() => {
    for (const v of views) v.destroy();
    views = [];
  });

  function setup(doc: string, answer: any = HELP, provider: any = { triggerCharacters: ["(", ","] }) {
    const request = vi.fn(async (..._args: any[]) => answer);
    const client: any = { capabilities: { signatureHelpProvider: provider }, request };
    const flush = vi.fn();
    const v = new EditorView({
      state: EditorState.create({ doc, selection: EditorSelection.cursor(doc.length), extensions: [signatureHelp(() => client, () => "file:///a.c", flush, plainDoc)] }),
      parent: document.body,
    });
    views.push(v);
    return { v, request, flush, client };
  }
  const type = (v: EditorView, text: string) => {
    const at = v.state.selection.main.head;
    v.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
  };
  const popup = (v: EditorView) => v.dom.querySelector(".lsp-signature");
  const escape = (v: EditorView) => runScopeHandlers(v, new KeyboardEvent("keydown", { key: "Escape" }), "editor");
  const shown = (v: EditorView) => vi.waitFor(() => expect(popup(v)).not.toBeNull());

  test("a trigger character asks the server and shows the popup", async () => {
    const { v, request, flush } = setup("add");
    type(v, "(");
    await shown(v);
    expect(flush).toHaveBeenCalled();
    expect(request.mock.calls[0][0]).toBe("textDocument/signatureHelp");
    expect(request.mock.calls[0][1]).toMatchObject({ textDocument: { uri: "file:///a.c" }, position: { line: 0, character: 4 }, context: { triggerKind: 2, triggerCharacter: "(", isRetrigger: false } });
    expect(popup(v)!.querySelector(".lsp-signature-active")!.textContent).toBe("int second");
  });

  test("other characters don't ask", async () => {
    const { v, request } = setup("add");
    type(v, "x");
    await new Promise((r) => setTimeout(r, 120));
    expect(request).not.toHaveBeenCalled();
  });

  test("only the server's trigger characters count", async () => {
    const { v, request } = setup("add", HELP, { triggerCharacters: ["<"] });
    type(v, "(");
    await new Promise((r) => setTimeout(r, 120));
    expect(request).not.toHaveBeenCalled();
  });

  test("typing while open updates it, and it closes when the call ends", async () => {
    const { v, request } = setup("add");
    type(v, "(");
    await shown(v);
    request.mockResolvedValue(null);
    type(v, ")");
    await vi.waitFor(() => expect(popup(v)).toBeNull());
    expect(request.mock.calls[1][1].context).toMatchObject({ triggerKind: 3, isRetrigger: true, activeSignatureHelp: HELP });
  });

  test("Escape closes it and is consumed only then", async () => {
    const { v } = setup("add");
    expect(escape(v)).toBe(false);
    type(v, "(");
    await shown(v);
    expect(escape(v)).toBe(true);
    await vi.waitFor(() => expect(popup(v)).toBeNull());
    expect(escape(v)).toBe(false);
  });

  test("an answer arriving after Escape doesn't reopen it", async () => {
    const { v, request } = setup("add");
    let answer!: (x: any) => void;
    request.mockImplementation(() => new Promise((r) => (answer = r)));
    type(v, "(");
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    escape(v);
    answer(HELP);
    await new Promise((r) => setTimeout(r, 20));
    expect(popup(v)).toBeNull();
  });

  test("an answer for older text is dropped", async () => {
    const { v, request } = setup("add");
    const answers: ((x: any) => void)[] = [];
    request.mockImplementation(() => new Promise((r) => answers.push(r)));
    type(v, "(");
    await vi.waitFor(() => expect(answers.length).toBe(1));
    type(v, "1");
    answers[0](HELP);
    await new Promise((r) => setTimeout(r, 20));
    expect(popup(v)).toBeNull();
    await vi.waitFor(() => expect(answers.length).toBe(2));
    answers[1](HELP);
    await shown(v);
  });

  test("a selection closes it", async () => {
    const { v } = setup("add");
    type(v, "(");
    await shown(v);
    v.dispatch({ selection: { anchor: 0, head: 2 } });
    await vi.waitFor(() => expect(popup(v)).toBeNull());
  });

  test("a server without signature help is never asked", async () => {
    const { v, request, client } = setup("add");
    client.capabilities = {};
    type(v, "(");
    await new Promise((r) => setTimeout(r, 120));
    expect(request).not.toHaveBeenCalled();
  });
});
