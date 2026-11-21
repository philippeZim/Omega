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
}));
vi.mock("./rpc.svelte", () => ({
  call: h.call,
  isObj: (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v),
  subscribe: (_t: string, cb: (p: unknown) => void) => ((h.topic = cb), () => {}),
  rpcErrorText: (c: string) => c,
}));
vi.mock("./share.svelte", () => ({ sharedText: (rel: string) => h.texts.get(rel) ?? null, openRemote: vi.fn() }));
vi.mock("./guard", () => ({ guestCan: () => h.can, blockedByCapability: () => !h.can }));
vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn(), openMenu: vi.fn() } }));
vi.mock("../rpc", () => ({ onRpc: () => () => {} }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true, withInstallProgress: async () => {}, serverProgressId: (k: string) => k }));

const { guestLspExtension, applyDocs } = await import("./lspGuest.svelte");
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
