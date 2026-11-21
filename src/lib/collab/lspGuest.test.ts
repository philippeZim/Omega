// Code Together guest editor: diagnostics from the host, only on the text they belong to.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";

const h = vi.hoisted(() => ({
  texts: new Map<string, any>(),
  call: vi.fn(),
  topic: null as ((p: unknown) => void) | null,
  can: true,
  openRemote: vi.fn(async () => {}),
}));
vi.mock("./rpc.svelte", () => ({
  call: h.call,
  isObj: (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v),
  subscribe: (_t: string, cb: (p: unknown) => void) => ((h.topic = cb), () => {}),
  rpcErrorText: (c: string) => c,
}));
vi.mock("./collab.svelte", () => ({ collab: { role: "guest" } }));
vi.mock("./share.svelte", () => ({ REMOTE: "collab:", sharedText: (rel: string) => h.texts.get(rel) ?? null, openRemote: h.openRemote }));
vi.mock("../editor", () => ({ getView: () => view }));
vi.mock("./guard", () => ({ guestCan: () => h.can, blockedByCapability: () => !h.can }));
vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn(), openMenu: vi.fn() } }));
vi.mock("../rpc", () => ({ onRpc: () => () => {} }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true, withInstallProgress: async () => {}, serverProgressId: (k: string) => k }));

const { guestLspExtension, applyDocs } = await import("./lspGuest.svelte");
const { runViewAction } = await import("../editorActions");
const { ui } = await import("../ui.svelte");
const { remoteLsp } = await import("../code/remoteLsp");
const { t } = await import("../i18n/index.svelte");
const { textHash } = await import("./lspProtocol");

const features = { triggers: ["."], hover: true, definition: true, format: true, codeActions: true, resolve: false };
let rev = 100;
const entry = (text: string, diagnostics: any[]) => ({ rev: ++rev, hash: textHash(text), len: text.length, diagnostics, features });
const err = (line: number, c1: number, c2: number, message = "bad") => ({ range: { start: { line, character: c1 }, end: { line, character: c2 } }, severity: 1, message });
const tick = () => new Promise((r) => setTimeout(r, 5));

let view: EditorView;
let ytext: Y.Text;
function open(text: string) {
  ytext = new Y.Doc().getText("content");
  ytext.insert(0, text);
  h.texts.set("a.py", ytext);
  view = new EditorView({ state: EditorState.create({ doc: text, extensions: guestLspExtension("a.py") }), parent: document.body });
}
const shown = () => {
  const out: { from: number; to: number; severity: string; message: string }[] = [];
  forEachDiagnostic(view.state, (d, from, to) => out.push({ from, to, severity: d.severity, message: d.message }));
  return out;
};
function edit(from: number, insert: string) {
  ytext.insert(from, insert);
  view.dispatch({ changes: { from, insert } });
}

beforeEach(() => {
  h.can = true;
  h.call.mockReset().mockResolvedValue({ ok: true, value: { fixes: [] } });
  h.texts.clear();
  applyDocs(null);
});
afterEach(() => view?.destroy());

test("diagnostics for this exact text show at their positions", async () => {
  open("x = 1\ny = (\n");
  applyDocs({ docs: { "a.py": entry("x = 1\ny = (\n", [err(1, 4, 5, "( was not closed")]) } });
  await tick();
  expect(shown()).toEqual([{ from: 10, to: 11, severity: "error", message: "( was not closed" }]);
});

test("diagnostics for another version of the text are held back", async () => {
  open("# new line\ny = (\n");
  applyDocs({ docs: { "a.py": entry("y = (\n", [err(0, 4, 5)]) } });
  await tick();
  expect(shown()).toEqual([]);
});

test("held-back diagnostics appear when this copy catches up", async () => {
  open("y = \n");
  applyDocs({ docs: { "a.py": entry("y = (\n", [err(0, 4, 5)]) } });
  await tick();
  expect(shown()).toEqual([]);
  edit(4, "(");
  await tick();
  expect(shown().map((d) => [d.from, d.to])).toEqual([[4, 5]]);
});

test("after a fix the new, empty result clears the marks", async () => {
  open("y = (\n");
  applyDocs({ docs: { "a.py": entry("y = (\n", [err(0, 4, 5)]) } });
  await tick();
  expect(shown()).toHaveLength(1);
  edit(5, ")");
  applyDocs({ docs: { "a.py": entry("y = ()\n", []) } });
  await tick();
  expect(shown()).toEqual([]);
});

test("marks follow local typing until the next result", async () => {
  open("y = (\n");
  applyDocs({ docs: { "a.py": entry("y = (\n", [err(0, 4, 5)]) } });
  await tick();
  edit(0, "# ");
  await tick();
  expect(shown().map((d) => d.from)).toEqual([6]);
});

test("the end of the session clears the marks", async () => {
  open("y = (\n");
  applyDocs({ docs: { "a.py": entry("y = (\n", [err(0, 4, 5)]) } });
  await tick();
  applyDocs(null);
  await tick();
  expect(shown()).toEqual([]);
});

test("malformed entries from the wire are ignored", async () => {
  open("y\n");
  applyDocs({ docs: { "a.py": { rev: "x", hash: 1, diagnostics: "no" } } });
  applyDocs({ docs: { "a.py": { ...entry("y\n", []), diagnostics: [{ message: "no range" }] } } });
  applyDocs("nonsense");
  await tick();
  expect(shown()).toEqual([]);
});

const edit0 = (c1: number, c2: number, newText: string) => ({ range: { start: { line: 0, character: c1 }, end: { line: 0, character: c2 } }, newText });

test("quick fixes from the host appear on the diagnostic and edit the text", async () => {
  open("y = (\n");
  const e = entry("y = (\n", [err(0, 4, 5)]);
  h.call.mockResolvedValue({ ok: true, value: { base: { len: e.len, hash: e.hash }, fixes: [[{ title: "Close it", edits: [edit0(5, 5, ")")] }]] } });
  applyDocs({ docs: { "a.py": e } });
  await tick();
  await tick();
  let action: any;
  forEachDiagnostic(view.state, (d) => (action = d.actions?.[0]));
  expect(action.name).toBe("Close it");
  action.apply(view, 0, 0);
  expect(view.state.doc.toString()).toBe("y = ()\n");
});

test("a read-only guest isn't offered quick fixes", async () => {
  h.can = false;
  open("y = (\n");
  applyDocs({ docs: { "a.py": entry("y = (\n", [err(0, 4, 5)]) } });
  await tick();
  expect(h.call).not.toHaveBeenCalled();
  expect(shown()).toHaveLength(1);
});

test("a quick fix for text that moved on is refused, not applied at wrong positions", async () => {
  open("y = (\n");
  const e = entry("y = (\n", [err(0, 4, 5)]);
  h.call.mockResolvedValue({ ok: true, value: { base: { len: e.len, hash: e.hash }, fixes: [[{ title: "Close it", edits: [edit0(5, 5, ")")] }]] } });
  applyDocs({ docs: { "a.py": e } });
  await tick();
  await tick();
  let action: any;
  forEachDiagnostic(view.state, (d) => (action = d.actions?.[0]));
  edit(0, "# ");
  action.apply(view, 0, 0);
  expect(view.state.doc.toString()).toBe("# y = (\n");
  expect(ui.toast).toHaveBeenCalledWith(t("code.lsp.guestStale"), "error");
});

test("format applies the host's edits to the guest's text", async () => {
  open("x=1\n");
  h.call.mockResolvedValue({ ok: true, value: { base: { len: 4, hash: textHash("x=1\n") }, edits: [edit0(0, 3, "x = 1")] } });
  runViewAction(view, "lsp.format");
  await tick();
  expect(h.call.mock.calls[0][0]).toBe("lsp.format");
  expect(view.state.doc.toString()).toBe("x = 1\n");
});

test("format without the edit right stops before asking the host", async () => {
  h.can = false;
  open("x=1\n");
  runViewAction(view, "lsp.format");
  await tick();
  expect(h.call).not.toHaveBeenCalled();
});

test("go to definition opens the project file at the position", async () => {
  open("import b\n");
  h.texts.set("b.py", ytext);
  h.call.mockResolvedValue({ ok: true, value: { path: "b.py", line: 0, character: 3 } });
  runViewAction(view, "lsp.gotoDefinition");
  await tick();
  expect(h.openRemote).toHaveBeenCalledWith("b.py", 1);
  expect(view.state.selection.main.head).toBe(3);
});

test("a definition outside the project is a clear message", async () => {
  open("print\n");
  h.openRemote.mockClear();
  h.call.mockResolvedValue({ ok: true, value: { outside: "builtins.pyi" } });
  runViewAction(view, "lsp.gotoDefinition");
  await tick();
  expect(h.openRemote).not.toHaveBeenCalled();
  expect(ui.toast).toHaveBeenCalledWith(t("code.lsp.guestOutside", { name: "builtins.pyi" }));
});

test("symbols from the host come back as shared paths", async () => {
  h.call.mockResolvedValue({ ok: true, value: [{ name: "f", kind: 12, path: "src/b.py", line: 1, character: 0 }] });
  expect(await remoteLsp.symbols!("f")).toEqual([{ name: "f", kind: 12, path: "collab:src/b.py", line: 1, character: 0 }]);
});
