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

/**
 * The fake file system plus the backend's symlink check: in these tests "/p/ext" is a symlink to a
 * folder outside the project.
 */
function hostFs(initial: Record<string, string> = {}) {
  const fs = fakeFs(initial);
  const other = fs.other;
  fs.other = (cmd, args) => (cmd === "collab_path_inside" ? !`${args.path}/`.startsWith("/p/ext/") : other(cmd, args));
  return fs;
}

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
  hostFs({ "/p/main.rs": "fn main() {}\n" });
  app.tabs.push({ id: "t1", path: "/p/main.rs", name: "main.rs" });
  texts.set("t1", "fn main() {}\n");
  await receive("g1", { t: "doc.open", path: "main.rs" });
  expect(guestCopy("main.rs")).toBe("fn main() {}\n");

  runAction("t1", "collab.undo");
  expect(guestCopy("main.rs")).toBe("fn main() {}\n");
});

test("undo after a remote edit leaves the loaded text alone (#126)", async () => {
  hostFs({ "/p/a.txt": "original\n" });
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
  hostFs({ "/p/a.txt": "one\n" });
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
    const fs = hostFs({ "/p/a.txt": "original a\n" });
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
    const fs = hostFs({ "/p/a.txt": "original a\n" });
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

test("host deletes a shared file it has open: guests are told, the host tab is unshared (#134)", async () => {
  hostFs({ "/p/src/x.rs": "fn x() {}\n" });
  app.tabs.push({ id: "t1", path: "/p/src/x.rs", name: "x.rs" });
  texts.set("t1", "fn x() {}\n");
  await receive("g1", { t: "doc.open", path: "src/x.rs" });
  expect(bindings.has("t1")).toBe(true);

  collabHooks.pathMoved("/p/src/x.rs", null);
  expect(sent.find((s) => s.msg.t === "doc.gone")).toEqual({ peer: "g1", msg: { t: "doc.gone", path: "src/x.rs", reason: "deleted" } });
  expect(bindings.has("t1")).toBe(false);
});

test("a background doc whose file is deleted outside Omega isn't recreated by guest edits (#134)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = hostFs({ "/p/a.txt": "a\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    fs.files.delete("/p/a.txt");
    for (const f of fileListeners) f(["/p/a.txt"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent.some((s) => s.msg.t === "doc.gone" && s.msg.reason === "deleted")).toBe(true);

    await guestInsert("a.txt", 0, "more");
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.files.has("/p/a.txt")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("guest: a file the host deleted stays open as an unsaved tab with its text (#134)", async () => {
  collab.role = "guest";
  const h = new Y.Doc();
  h.getText("content").insert(0, "fn x() {}\n// guest\n");
  await receive("host-peer", { t: "doc.state", path: "src/x.rs", name: "x.rs", update: b64(Y.encodeStateAsUpdate(h)) });
  const tab = await vi.waitFor(() => {
    const x = app.tabs.find((y) => y.path === "collab:src/x.rs");
    if (!x || !bindings.has(x.id)) throw new Error("not open yet");
    return x;
  });
  expect(bindings.has(tab.id)).toBe(true);

  await receive("host-peer", { t: "doc.gone", path: "src/x.rs", reason: "deleted" });
  expect(app.tabs).toContainEqual({ id: tab.id, path: null, name: "x.rs", dirty: true });
  expect(bindings.has(tab.id)).toBe(false);
  expect(closeTab).not.toHaveBeenCalled();
  expect(ui.toasts[0]?.kind).toBe("error");
});

test("host renames a shared file: the doc follows, guest edits go to the new name (#127)", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = hostFs({ "/p/a.txt": "original a\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    fs.files.set("/p/b.txt", fs.files.get("/p/a.txt")!);
    fs.files.delete("/p/a.txt");
    collabHooks.pathMoved("/p/a.txt", "/p/b.txt");
    expect(sent.find((s) => s.msg.t === "doc.moved")).toEqual({ peer: "g1", msg: { t: "doc.moved", path: "a.txt", to: "b.txt", name: "b.txt" } });

    // One edit still sent under the old name (in flight during the rename), one under the new.
    const g = await guestInsert("a.txt", 11, "x\n");
    await guestInsert("b.txt", 13, "guest line after rename\n", g);
    for (const f of fileListeners) f(["/p/a.txt", "/p/b.txt"]);
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.files.has("/p/a.txt")).toBe(false);
    expect(fs.files.get("/p/b.txt")).toBe("original a\nx\nguest line after rename\n");
  } finally {
    vi.useRealTimers();
  }
});

test("renaming a folder moves the shared docs inside it, moving a file out of the project unshares it (#127)", async () => {
  hostFs({ "/p/src/a.rs": "a\n", "/p/src/b.rs": "b\n" });
  await receive("g1", { t: "doc.open", path: "src/a.rs" });
  await receive("g1", { t: "doc.open", path: "src/b.rs" });
  collabHooks.pathMoved("/p/src", "/p/lib");
  expect(sent.filter((s) => s.msg.t === "doc.moved").map((s) => s.msg.to)).toEqual(["lib/a.rs", "lib/b.rs"]);
  collabHooks.pathMoved("/p/lib/a.rs", "/elsewhere/a.rs");
  expect(sent.find((s) => s.msg.t === "doc.gone")?.msg).toEqual({ t: "doc.gone", path: "lib/a.rs", reason: "deleted" });
});

test("guest: the tab of a file the host renamed follows the new name (#127)", async () => {
  collab.role = "guest";
  const h = new Y.Doc();
  h.getText("content").insert(0, "original a\n");
  await receive("host-peer", { t: "doc.state", path: "a.txt", name: "a.txt", update: b64(Y.encodeStateAsUpdate(h)) });
  const tab = await vi.waitFor(() => {
    const x = app.tabs.find((y) => y.path === "collab:a.txt");
    if (!x || !bindings.has(x.id)) throw new Error("not open yet");
    return x;
  });
  await receive("host-peer", { t: "doc.moved", path: "a.txt", to: "b.txt", name: "b.txt" });
  expect(tab).toMatchObject({ path: "collab:b.txt", name: "b.txt" });

  // Typing now goes out under the new name.
  const { EditorView } = await import("@codemirror/view");
  const view = new EditorView({ state: EditorState.create({ doc: "original a\n", extensions: bindings.get(tab.id) as any }) });
  sent.length = 0;
  view.dispatch({ changes: { from: 11, insert: "guest\n" } });
  expect(sent.map((s) => [s.peer, s.msg.t, s.msg.path])).toContainEqual(["host-peer", "doc.update", "b.txt"]);
  view.destroy();
});

test("leaving a session with an open shared tab logs no yjs errors (#135)", async () => {
  collab.role = "guest";
  // Like the real closeTab: closing a tab reports it to the collab layer.
  closeTab.mockImplementation(async (id: string) => {
    const tab = app.tabs.find((t) => t.id === id);
    app.tabs = app.tabs.filter((t) => t.id !== id);
    collabHooks.tabClosed(tab?.path ?? null, id);
  });
  const h = new Y.Doc();
  h.getText("content").insert(0, "text\n");
  await receive("host-peer", { t: "doc.state", path: "a.txt", name: "a.txt", update: b64(Y.encodeStateAsUpdate(h)) });
  await vi.waitFor(() => {
    if (!app.tabs.some((t) => bindings.has(t.id))) throw new Error("not open yet");
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await share.teardownShare();
  expect(errors).not.toHaveBeenCalled();
  expect(app.tabs).toEqual([]);
});

test("host refuses guest requests that leave the shared folder through a symlink (#138)", async () => {
  const fs = hostFs({ "/p/ext/passwd": "root:x:0:0" , "/p/a.txt": "a\n" });
  await receive("g1", { t: "doc.open", path: "ext/passwd" });
  expect(sent.at(-1)!.msg).toEqual({ t: "doc.error", path: "ext/passwd", error: "unavailable" });
  await receive("g1", { t: "fs.list", path: "ext", req: 3 });
  expect(sent.at(-1)!.msg).toEqual({ t: "fs.list.res", req: 3, entries: [] });
  for (const path of ["../etc/passwd", "/etc/passwd", "src/../../x"]) {
    await receive("g1", { t: "doc.open", path });
    expect(sent.at(-1)!.msg.t).toBe("doc.error");
  }
  expect(fs.calls.filter((c) => c.cmd === "read_file" || c.cmd === "list_dir")).toEqual([]);

  // Inside the folder everything still works.
  await receive("g1", { t: "doc.open", path: "a.txt" });
  expect(guestCopy("a.txt")).toBe("a\n");
});
