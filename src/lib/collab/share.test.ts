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
  // Like state.svelte.ts: open tabs follow, then the collab layer is told.
  pathMoved: (from: string, to: string | null) => collabHooks.pathMoved(from, to),
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
const { openFile, activate, setMode } = await import("../state.svelte");

/**
 * The fake file system plus the backend's symlink check: in these tests "/p/ext" is a symlink to a
 * folder outside the project.
 */
function hostFs(initial: Record<string, string> = {}) {
  const fs = fakeFs(initial);
  const other = fs.other;
  fs.other = (cmd, args) =>
    cmd === "collab_path_inside" ? !`${args.path}/`.startsWith("/p/ext/") && !`${args.path}/`.startsWith("/p/gitlink/") : cmd === "collab_tree_has_git" ? args.path === "/p/vendor" : other(cmd, args);
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

test("host carries out a guest's create, rename and delete in its project (#133)", async () => {
  const fs = hostFs({ "/p/src/a.rs": "a\n" });
  const inside = fs.other;
  fs.other = (cmd, args) => {
    if (cmd === "collab_path_inside" || cmd === "collab_tree_has_git") return inside(cmd, args);
    if (cmd === "rename_path") {
      fs.files.set(args.to, fs.files.get(args.from)!);
      fs.files.delete(args.from);
    } else if (cmd === "delete_path") fs.files.delete(args.path);
    return null;
  };
  collab.participants = [{ peer: "g1", name: "Gast", color: "#333333", role: "guest" }];
  const op = async (msg: Msg) => {
    sent.length = 0;
    await receive("g1", { t: "fs.op", req: 7, ...msg });
    return sent.find((s) => s.msg.t === "fs.op.res")!;
  };

  expect(await op({ op: "create", path: "src/new.rs" })).toEqual({ peer: "g1", msg: { t: "fs.op.res", req: 7, error: null } });
  expect(fs.files.get("/p/src/new.rs")).toBe("");
  expect((await op({ op: "create", path: "src/a.rs" })).msg.error).toBe("exists");

  // A guest that has the file open follows the rename.
  await receive("g1", { t: "doc.open", path: "src/a.rs" });
  expect((await op({ op: "rename", path: "src/a.rs", to: "src/b.rs" })).msg.error).toBeNull();
  expect(fs.files.get("/p/src/b.rs")).toBe("a\n");
  expect(sent.some((s) => s.msg.t === "doc.moved" && s.msg.to === "src/b.rs")).toBe(true);

  expect((await op({ op: "delete", path: "src/b.rs" })).msg.error).toBeNull();
  expect(fs.files.has("/p/src/b.rs")).toBe(false);
  expect(ui.toasts.map((x) => x.text)).toEqual(["Gast renamed src/a.rs to src/b.rs", "Gast deleted src/b.rs"]);
  collab.participants = [];
});

test("host refuses guest file operations outside the project (#133)", async () => {
  const fs = hostFs({ "/etc/passwd": "root" });
  for (const msg of [
    { op: "delete", path: "../etc/passwd" },
    { op: "create", path: "/etc/x" },
    { op: "rename", path: "a.txt", to: "../../x" },
    { op: "mkdir", path: "a/./b" },
    { op: "create", path: "ext/evil.sh" },
    { op: "delete", path: "ext/passwd" },
    { op: "rename", path: "a.txt", to: "ext/a.txt" },
  ]) {
    sent.length = 0;
    await receive("g1", { t: "fs.op", req: 1, ...msg });
    expect(sent[0].msg).toEqual({ t: "fs.op.res", req: 1, error: "invalid" });
  }
  expect(fs.calls.filter((c) => c.cmd !== "path_exists" && c.cmd !== "collab_path_inside" && c.cmd !== "collab_tree_has_git")).toEqual([]);
});

test("guest: New File in the shared tree creates it on the host and opens it (#133)", async () => {
  collab.role = "guest";
  ui.prompt.mockResolvedValueOnce("x.rs");
  const done = share.remoteCreate("src", false);
  await vi.waitFor(() => expect(sent.find((s) => s.msg.t === "fs.op")).toBeTruthy());
  const req = sent.find((s) => s.msg.t === "fs.op")!;
  expect(req).toMatchObject({ peer: "host-peer", msg: { op: "create", path: "src/x.rs" } });
  await receive("host-peer", { t: "fs.op.res", req: req.msg.req, error: null });
  await done;
  expect(sent.some((s) => s.msg.t === "doc.open" && s.msg.path === "src/x.rs")).toBe(true);

  // Errors come back as codes and are shown in the guest's language.
  ui.prompt.mockResolvedValueOnce("x.rs");
  sent.length = 0;
  const again = share.remoteCreate("src", false);
  await vi.waitFor(() => expect(sent.find((s) => s.msg.t === "fs.op")).toBeTruthy());
  await receive("host-peer", { t: "fs.op.res", req: sent.find((s) => s.msg.t === "fs.op")!.msg.req, error: "exists" });
  await again;
  expect(ui.toasts.at(-1)).toEqual({ text: '"x.rs" already exists there', kind: "error" });
});

const GIT_PATHS = [".git/config", ".GIT/config", ".git./config", ".git /config", "sub/.git/config", ".git\\config", "sub\\.Git\\config", ".git::$INDEX_ALLOCATION/config", "git~1/config"];

test("guests can't read or write a git folder, in any spelling", async () => {
  const fs = hostFs({ "/p/.git/config": "[core]\n", "/p/.gitignore": "x\n", "/p/a.txt": "a\n" });
  for (const path of GIT_PATHS) {
    await receive("g1", { t: "doc.open", path });
    expect(sent.at(-1)!.msg).toEqual({ t: "doc.error", path, error: "unavailable" });
    await receive("g1", { t: "fs.list", path, req: 2 });
    expect(sent.at(-1)!.msg).toEqual({ t: "fs.list.res", req: 2, entries: [] });
    for (const op of [{ op: "create", path }, { op: "delete", path }, { op: "rename", path, to: "b.txt" }, { op: "rename", path: "a.txt", to: path }]) {
      await receive("g1", { t: "fs.op", req: 1, ...op });
      expect(sent.at(-1)!.msg).toEqual({ t: "fs.op.res", req: 1, error: "invalid" });
    }
  }
  expect(fs.calls.filter((c) => !["collab_path_inside", "path_exists"].includes(c.cmd))).toEqual([]);
  expect(fs.files.get("/p/.git/config")).toBe("[core]\n");

  // Names that only look similar stay usable.
  await receive("g1", { t: "doc.open", path: ".gitignore" });
  expect(guestCopy(".gitignore")).toBe("x\n");
});

test("the file tree doesn't list .git, and a folder holding a nested repository can't be moved or deleted", async () => {
  const fs = hostFs({ "/p/.git/config": "", "/p/a.txt": "a\n", "/p/vendor/lib/.git/config": "" });
  await receive("g1", { t: "fs.list", path: "", req: 4 });
  expect(sent.at(-1)!.msg.entries.map((e: { name: string }) => e.name)).not.toContain(".git");
  for (const op of [{ op: "delete", path: "vendor" }, { op: "rename", path: "vendor", to: "v2" }]) {
    await receive("g1", { t: "fs.op", req: 5, ...op });
    expect(sent.at(-1)!.msg).toEqual({ t: "fs.op.res", req: 5, error: "invalid" });
  }
  expect(fs.calls.filter((c) => c.cmd === "delete_path" || c.cmd === "rename_path")).toEqual([]);
});

test("following a guest never opens a path outside the project or in .git", async () => {
  hostFs({ "/etc/passwd": "root", "/p/.git/config": "", "/p/a.txt": "a\n" });
  vi.mocked(openFile).mockClear();
  share.follow("g1");
  try {
    for (const file of ["../../etc/passwd", "/etc/passwd", "..\\..\\etc\\passwd", "src/../../x", "C:\\Windows\\win.ini", "ext/passwd", ...GIT_PATHS]) {
      sent.length = 0;
      await receive("g1", { t: "presence", file, line: 1, name: "G", color: "#333333" });
      expect(share.share.presence.g1.file).toBeNull();
      expect(sent.find((s) => s.msg.t === "presence")!.msg.file).toBeNull();
    }
    expect(openFile).not.toHaveBeenCalled();

    await receive("g1", { t: "presence", file: "a.txt", line: 1, name: "G", color: "#333333" });
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith("/p/a.txt"));
  } finally {
    share.follow("g1");
  }
});

test("presence: a tab id must be an existing unsaved tab, the other fields are checked", async () => {
  hostFs({});
  collab.participants = [{ peer: "g1", name: "Gast", color: "#7bbf8e", role: "guest" }];
  app.tabs.push({ id: "u1", path: null, name: "Untitled" }, { id: "o1", path: "/etc/hosts", name: "hosts" });
  vi.mocked(activate).mockClear();
  vi.mocked(setMode).mockClear();
  share.follow("g1");
  try {
    await receive("g1", { t: "presence", file: "tab:o1", line: "x", name: { a: 1 }, color: "url(evil)", mode: "nope", extra: "dropped" });
    expect(share.share.presence.g1).toEqual({ file: null, line: 1, name: "Gast", color: "#7bbf8e", mode: undefined });
    expect(sent.at(-1)!.msg).toEqual({ t: "presence", peer: "g1", file: null, line: 1, name: "Gast", color: "#7bbf8e", mode: undefined });
    expect(activate).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();

    await receive("g1", { t: "presence", file: "tab:missing", line: 2, mode: "code" });
    expect(share.share.presence.g1.file).toBeNull();
    await receive("g1", { t: "presence", file: "tab:u1", line: 3, mode: "code" });
    expect(share.share.presence.g1).toMatchObject({ file: "tab:u1", line: 3, mode: "code" });
    expect(activate).toHaveBeenCalledWith("u1");
  } finally {
    share.follow("g1");
    collab.participants = [];
  }
});

test("host tabs outside the project get no key and can't be opened by id; Untitled tabs can", async () => {
  hostFs({ "/etc/secret": "secret" });
  const outside = { id: "o1", path: "/etc/secret", name: "secret" };
  const untitled = { id: "u1", path: null, name: "Untitled" };
  texts.set("o1", "secret");
  texts.set("u1", "draft\n");
  app.tabs.push(outside, untitled);
  expect(share.hostKey(outside as any)).toBeNull();
  expect(share.hostKey({ id: "g", path: "/p/.git/config", name: "config" } as any)).toBeNull();
  expect(share.hostKey(untitled as any)).toBe("tab:u1");
  expect(share.hostKey({ id: "a", path: "/p/a.txt", name: "a.txt" } as any)).toBe("a.txt");

  await receive("g1", { t: "doc.open", path: "tab:o1" });
  expect(sent.at(-1)!.msg).toEqual({ t: "doc.error", path: "tab:o1", error: "unavailable" });
  expect(bindings.has("o1")).toBe(false);
  await receive("g1", { t: "doc.open", path: "tab:u1" });
  expect(guestCopy("tab:u1")).toBe("draft\n");

  // With no folder open a file on disk is outside the project too.
  app.root = null;
  expect(share.hostKey({ id: "a", path: "/p/a.txt", name: "a.txt" } as any)).toBeNull();
});

test("an Untitled tab saved outside the project stops being shared, saved inside it moves", async () => {
  hostFs({});
  const tab = { id: "u1", path: null as string | null, name: "Untitled" };
  texts.set("u1", "draft\n");
  app.tabs.push(tab);
  await receive("g1", { t: "doc.open", path: "tab:u1" });

  tab.path = "/p/saved.txt";
  share.syncSharedTabs();
  expect(sent.at(-1)).toEqual({ peer: "g1", msg: { t: "doc.moved", path: "tab:u1", to: "saved.txt", name: "saved.txt" } });

  tab.path = "/home/me/private.txt";
  sent.length = 0;
  await guestInsert("saved.txt", 0, "late edit");
  expect(sent.find((s) => s.msg.t === "doc.gone")).toEqual({ peer: "g1", msg: { t: "doc.gone", path: "saved.txt" } });
  expect(bindings.has("u1")).toBe(false);
  expect(texts.get("u1")).toBe("draft\n");
});

test("host's presence doesn't name an active tab outside the project", async () => {
  hostFs({});
  app.tabs.push({ id: "o1", path: "/etc/secret", name: "secret" });
  app.activeId = "o1";
  await share.publishPresence();
  expect(sent.at(-1)!.msg).toMatchObject({ t: "presence", peer: "host", file: null });
});

test("host rejects an unknown file operation instead of deleting", async () => {
  const fs = hostFs({ "/p/a.txt": "a\n" });
  for (const op of ["remove", "DELETE", "", "__proto__", "constructor", null, undefined, 7, ["delete"], { op: "delete" }]) {
    sent.length = 0;
    await receive("g1", { t: "fs.op", req: 9, op, path: "a.txt" });
    expect(sent[0].msg).toEqual({ t: "fs.op.res", req: 9, error: "invalid" });
  }
  expect(fs.files.get("/p/a.txt")).toBe("a\n");
  expect(fs.calls.filter((c) => c.cmd !== "collab_path_inside")).toEqual([]);
});

test("host opens another folder: a pending guest edit lands in the old one, the new one is untouched", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = hostFs({ "/p/a.txt": "old\n", "/q/a.txt": "new root\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    await guestInsert("a.txt", 0, "pending ");

    app.root = "/q";
    await share.syncSharedTabs();
    expect(fs.files.get("/p/a.txt")).toBe("pending old\n");
    expect(sent.find((s) => s.msg.t === "doc.gone")).toEqual({ peer: "g1", msg: { t: "doc.gone", path: "a.txt", reason: "folder" } });

    await vi.advanceTimersByTimeAsync(800);
    expect(fs.files.get("/q/a.txt")).toBe("new root\n");
    expect(fs.files.get("/p/a.txt")).toBe("pending old\n");
  } finally {
    vi.useRealTimers();
  }
});

test("a late edit of the old folder's doc can't reach the same-named file of the new folder", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = hostFs({ "/p/a.txt": "old\n", "/q/a.txt": "new root\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    app.root = "/q";
    await share.syncSharedTabs();

    await receive("g2", { t: "doc.open", path: "a.txt" });
    const opened = new Y.Doc();
    Y.applyUpdate(opened, unb64(sent.find((s) => s.peer === "g2" && s.msg.t === "doc.state")!.msg.update));
    expect(opened.getText("content").toString()).toBe("new root\n");

    // Self-contained on purpose: an update that depends on the old doc would just stay pending.
    const late = new Y.Doc();
    late.getText("content").insert(0, "late ");
    await receive("g1", { t: "doc.update", path: "a.txt", update: b64(Y.encodeStateAsUpdate(late)) });
    await vi.advanceTimersByTimeAsync(800);
    expect(sent.filter((s) => s.peer === "g2" && s.msg.t === "doc.update")).toEqual([]);
    expect(fs.files.get("/q/a.txt")).toBe("new root\n");
  } finally {
    vi.useRealTimers();
  }
});

test("host opens another folder: a tab left outside is unshared, Untitled stays, a tab still inside moves", async () => {
  hostFs({ "/p/a.txt": "a\n", "/p/sub/b.txt": "b\n" });
  app.tabs.push({ id: "t1", path: "/p/a.txt", name: "a.txt" }, { id: "t2", path: "/p/sub/b.txt", name: "b.txt" }, { id: "u1", path: null, name: "Untitled" });
  texts.set("t1", "a\n");
  texts.set("t2", "b\n");
  texts.set("u1", "draft\n");
  for (const path of ["a.txt", "sub/b.txt", "tab:u1"]) await receive("g1", { t: "doc.open", path });

  app.root = "/p/sub";
  sent.length = 0;
  await share.syncSharedTabs();
  expect(sent.map((s) => s.msg)).toEqual([
    { t: "doc.gone", path: "a.txt", reason: "folder" },
    { t: "doc.moved", path: "sub/b.txt", to: "b.txt", name: "b.txt" },
  ]);
  expect(bindings.has("t1")).toBe(false);
  expect(bindings.has("t2")).toBe(true);
  expect(bindings.has("u1")).toBe(true);
  expect(texts.get("t1")).toBe("a\n");
});

test("guest: after the host changed folder the tab stays as an unsaved copy", async () => {
  collab.role = "guest";
  const h = new Y.Doc();
  h.getText("content").insert(0, "my text\n");
  await receive("host-peer", { t: "doc.state", path: "a.txt", name: "a.txt", update: b64(Y.encodeStateAsUpdate(h)) });
  const tab = await vi.waitFor(() => {
    const x = app.tabs.find((y) => y.path === "collab:a.txt");
    if (!x || !bindings.has(x.id)) throw new Error("not open yet");
    return x;
  });
  await receive("host-peer", { t: "doc.gone", path: "a.txt", reason: "folder" });
  expect(app.tabs).toContainEqual({ id: tab.id, path: null, name: "a.txt", dirty: true });
  expect(bindings.has(tab.id)).toBe(false);
  expect(closeTab).not.toHaveBeenCalled();
  expect(ui.toasts.at(-1)?.text).toContain("switched folders");
});

/** Opens folder /q the moment the host is busy with `cmd` for a guest request. */
function switchFolderDuring(fs: ReturnType<typeof hostFs>, cmd: string) {
  const other = fs.other;
  fs.other = (c, args) => {
    const result = other(c, args);
    if (c === cmd) app.root = "/q";
    return result;
  };
}
const effects = (fs: ReturnType<typeof hostFs>) => fs.calls.filter((c) => !["collab_path_inside", "collab_tree_has_git", "path_exists"].includes(c.cmd));

test("a folder switch during a guest's file operation doesn't apply it to the new folder", async () => {
  for (const [op, during] of [
    [{ op: "create", path: "new.txt" }, "collab_path_inside"],
    [{ op: "mkdir", path: "dir" }, "collab_path_inside"],
    [{ op: "rename", path: "a.txt", to: "b.txt" }, "collab_path_inside"],
    [{ op: "delete", path: "a.txt" }, "collab_path_inside"],
    [{ op: "delete", path: "a.txt" }, "collab_tree_has_git"],
    [{ op: "rename", path: "a.txt", to: "b.txt" }, "collab_tree_has_git"],
  ] as const) {
    app.root = "/p";
    const fs = hostFs({ "/p/a.txt": "p\n", "/q/a.txt": "q\n" });
    switchFolderDuring(fs, during);
    sent.length = 0;
    await receive("g1", { t: "fs.op", req: 11, ...op });
    expect(sent.find((s) => s.msg.t === "fs.op.res")!.msg, `${op.op} during ${during}`).toEqual({ t: "fs.op.res", req: 11, error: "unavailable" });
    expect(effects(fs), `${op.op} during ${during}`).toEqual([]);
    expect([fs.files.get("/p/a.txt"), fs.files.get("/q/a.txt")]).toEqual(["p\n", "q\n"]);
  }
});

test("a folder switch during a guest's folder listing doesn't list the new folder", async () => {
  const fs = hostFs({ "/p/a.txt": "p\n", "/q/private.txt": "q\n" });
  switchFolderDuring(fs, "collab_path_inside");
  await receive("g1", { t: "fs.list", path: "", req: 12 });
  expect(sent.at(-1)!.msg).toEqual({ t: "fs.list.res", req: 12, entries: [] });
  expect(fs.calls.filter((c) => c.cmd === "list_dir")).toEqual([]);
});
  const other = fs.other;
  fs.other = (c, args) => {
    if (c === "collab_path_inside") share.forgetPeer("g1");
    return other(c, args);
  };
  await receive("g1", { t: "presence", file: "a.txt", line: 2 });
  expect(share.share.presence.g1).toBeUndefined();
  expect(sent.filter((s) => s.msg.t === "presence")).toEqual([]);
});
