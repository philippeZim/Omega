// Code Together shared documents (share.svelte.ts), driven through the collab message handler with
// the session layer, app state and editor replaced by small fakes.
import { beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { fakeFs, fakeUi } from "../../test/fakes";

type Msg = Record<string, any>;
const handlers: ((peer: string, msg: Msg) => unknown)[] = [];
const sent: { peer: string; msg: Msg }[] = [];
const collab = { role: "host" as "host" | "guest" | null, status: "connected", hostPeer: "host-peer", me: { name: "Me", color: "#123456" }, participants: [] as unknown[] };
vi.mock("./collab.svelte", () => ({
  collab,
  send: (peer: string, msg: Msg) => void sent.push({ peer, msg }),
  broadcast: (msg: Msg) => void sent.push({ peer: "*", msg }),
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void handlers.push(fn),
}));

const app = { root: "/p" as string | null, tabs: [] as { id: string; path: string | null; name: string; dirty?: boolean }[], activeId: null as string | null, mode: "code" };
const collabHooks = {} as Record<string, (...a: any[]) => unknown>;
const closeTab = vi.fn(async (id: string) => {
  app.tabs = app.tabs.filter((t) => t.id !== id);
});
vi.mock("../state.svelte", () => ({
  app,
  collabHooks,
  closeTab,
  openFile: vi.fn(),
  activeTab: () => app.tabs.find((t) => t.id === app.activeId) ?? null,
  activate: vi.fn(),
  setMode: vi.fn(),
  openVirtual: vi.fn((path: string, name: string, content: string) => {
    const id = `v${app.tabs.length + 1}`;
    app.tabs.push({ id, path, name });
    texts.set(id, content);
    return id;
  }),
}));

const fileListeners: ((files: string[]) => void)[] = [];
vi.mock("../fsWatch.svelte", () => ({ onFilesChanged: (fn: (files: string[]) => void) => void fileListeners.push(fn) }));

const texts = new Map<string, string>();
const bindings = new Map<string, unknown>();
vi.mock("../editor", () => ({
  getText: (id: string) => texts.get(id) ?? "",
  replaceDocText: (id: string, text: string) => void texts.set(id, text),
  setCollab: (id: string, ext: unknown) => void (ext ? bindings.set(id, ext) : bindings.delete(id)),
  isActive: () => false,
  hasDoc: (id: string) => texts.has(id),
  applyChanges: vi.fn(),
  getView: () => null,
}));

const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));

const share = await import("./share.svelte");
const { viewActions } = await import("../editorActions");

/** Delivers a message as if it came from `peer`. */
async function receive(peer: string, msg: Msg) {
  for (const h of handlers) await h(peer, msg);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A guest's copy of a shared doc, kept in sync with everything the host sends to "g1". */
function guestCopy(path: string, doc = new Y.Doc()) {
  for (const { peer, msg } of sent) if (peer === "g1" && msg.path === path && msg.update && msg.t !== "aw") Y.applyUpdate(doc, unb64(msg.update));
  return doc.getText("content").toString();
}

/** Runs one of the per-view actions (collab.undo/redo) a tab's binding contributes. */
function runAction(tabId: string, id: string) {
  const state = EditorState.create({ extensions: bindings.get(tabId) as any });
  return state.facet(viewActions)[id](null as any);
}

beforeEach(async () => {
  await share.teardownShare();
  sent.length = 0;
  texts.clear();
  bindings.clear();
  closeTab.mockClear();
  ui.reset();
  Object.assign(collab, { role: "host", status: "connected" });
  Object.assign(app, { root: "/p", tabs: [], activeId: null });
});

test("host's first undo after sharing an open tab doesn't wipe the file (#126)", async () => {
  fakeFs({ "/p/main.rs": "fn main() {}\n" });
  app.tabs.push({ id: "t1", path: "/p/main.rs", name: "main.rs" });
  texts.set("t1", "fn main() {}\n");
  await receive("g1", { t: "doc.open", path: "main.rs" });
  expect(guestCopy("main.rs")).toBe("fn main() {}\n");

  runAction("t1", "collab.undo");
  expect(guestCopy("main.rs")).toBe("fn main() {}\n");
});

test("undo after a remote edit leaves the loaded text alone (#126)", async () => {
  fakeFs({ "/p/a.txt": "original\n" });
  app.tabs.push({ id: "t1", path: "/p/a.txt", name: "a.txt" });
  texts.set("t1", "original\n");
  await receive("g1", { t: "doc.open", path: "a.txt" });
  // The guest types a line.
  const g = new Y.Doc();
  Y.applyUpdate(g, unb64(sent.find((s) => s.msg.t === "doc.state")!.msg.update));
  const before = Y.encodeStateVector(g);
  g.getText("content").insert(9, "guest\n");
  await receive("g1", { t: "doc.update", path: "a.txt", update: b64(Y.encodeStateAsUpdate(g, before)) });

  runAction("t1", "collab.undo");
  expect(guestCopy("a.txt", g)).toBe("original\nguest\n");
});

test("the host's own edits in the editor stay undoable (#126)", async () => {
  const { EditorView } = await import("@codemirror/view");
  fakeFs({ "/p/a.txt": "one\n" });
  app.tabs.push({ id: "t1", path: "/p/a.txt", name: "a.txt" });
  texts.set("t1", "one\n");
  await receive("g1", { t: "doc.open", path: "a.txt" });
  const view = new EditorView({ state: EditorState.create({ doc: "one\n", extensions: bindings.get("t1") as any }) });
  view.dispatch({ changes: { from: 4, insert: "two\n" } });
  expect(guestCopy("a.txt")).toBe("one\ntwo\n");
  view.state.facet(viewActions)["collab.undo"](view);
  expect(guestCopy("a.txt")).toBe("one\n");
  view.destroy();
});

/** A guest edit (insert at `at`) arriving at the host; returns the guest's doc. */
async function guestInsert(path: string, at: number, text: string, g = new Y.Doc()) {
  guestCopy(path, g);
  const before = Y.encodeStateVector(g);
  g.getText("content").insert(at, text);
  await receive("g1", { t: "doc.update", path, update: b64(Y.encodeStateAsUpdate(g, before)) });
  return g;
}

test("a background doc follows an outside change of its file, the guest's next edit keeps it (#128)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = fakeFs({ "/p/a.txt": "original a\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    fs.files.set("/p/a.txt", "EXTERNAL v2\n");
    for (const f of fileListeners) f(["/p/a.txt"]);
    await vi.advanceTimersByTimeAsync(10);
    const g = new Y.Doc();
    expect(guestCopy("a.txt", g)).toBe("EXTERNAL v2\n");

    await guestInsert("a.txt", 0, "Y", g);
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.files.get("/p/a.txt")).toBe("YEXTERNAL v2\n");
  } finally {
    vi.useRealTimers();
  }
});

test("an outside change the watcher hasn't reported yet isn't overwritten by a guest edit (#128)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = fakeFs({ "/p/a.txt": "original a\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    fs.files.set("/p/a.txt", "EXTERNAL v2\n");
    const g = await guestInsert("a.txt", 0, "Y");
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.files.get("/p/a.txt")).toBe("EXTERNAL v2\n");
    expect(guestCopy("a.txt", g)).toBe("EXTERNAL v2\n");
  } finally {
    vi.useRealTimers();
  }
});
