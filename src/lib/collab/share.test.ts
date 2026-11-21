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
  sessionEndHooks: [],
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
/** A guest's RPC calls and the host's answers, as they go over the wire. */
const fsList = (peer: string, path: unknown, id: number) => receive(peer, { t: "rpc.req", id, method: "fs.list", params: { path } });
const fsOp = (peer: string, id: number, params: Msg) => receive(peer, { t: "rpc.req", id, method: "fs.op", params });
const listed = (id: number, result: unknown[] = []) => ({ t: "rpc.res", id, ok: true, result });
const refused = (id: number, code: string) => ({ t: "rpc.res", id, ok: false, error: { code } });
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
  for (const peer of ["g1", "g2"]) share.forgetPeer(peer);
  Object.assign(collab, {
    role: "host",
    status: "connected",
    participants: ["g1", "g2"].map((peer) => ({ peer, name: "Gast", color: "#333333", role: "guest", caps: ["edit", "run"] })),
  });
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
  await fsList("g1", "ext", 3);
  expect(sent.at(-1)!.msg).toEqual(listed(3));
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
  collab.participants = [{ peer: "g1", name: "Gast", color: "#333333", role: "guest", caps: ["edit"] }];
  const op = async (msg: Msg) => {
    sent.length = 0;
    await fsOp("g1", 7, msg);
    return sent.find((s) => s.msg.t === "rpc.res")!;
  };

  expect(await op({ op: "create", path: "src/new.rs" })).toEqual({ peer: "g1", msg: { t: "rpc.res", id: 7, ok: true, result: null } });
  expect(fs.files.get("/p/src/new.rs")).toBe("");
  expect((await op({ op: "create", path: "src/a.rs" })).msg.error).toEqual({ code: "exists" });

  // A guest that has the file open follows the rename.
  await receive("g1", { t: "doc.open", path: "src/a.rs" });
  expect((await op({ op: "rename", path: "src/a.rs", to: "src/b.rs" })).msg.ok).toBe(true);
  expect(fs.files.get("/p/src/b.rs")).toBe("a\n");
  expect(sent.some((s) => s.msg.t === "doc.moved" && s.msg.to === "src/b.rs")).toBe(true);

  expect((await op({ op: "delete", path: "src/b.rs" })).msg.ok).toBe(true);
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
    await fsOp("g1", 1, msg);
    expect(sent[0].msg).toEqual(refused(1, "invalid"));
  }
  expect(fs.calls.filter((c) => c.cmd !== "path_exists" && c.cmd !== "collab_path_inside" && c.cmd !== "collab_tree_has_git")).toEqual([]);
});

test("guest: New File in the shared tree creates it on the host and opens it (#133)", async () => {
  collab.role = "guest";
  ui.prompt.mockResolvedValueOnce("x.rs");
  const done = share.remoteCreate("src", false);
  await vi.waitFor(() => expect(sent.find((s) => s.msg.t === "rpc.req")).toBeTruthy());
  const req = sent.find((s) => s.msg.t === "rpc.req")!;
  expect(req).toMatchObject({ peer: "host-peer", msg: { method: "fs.op", params: { op: "create", path: "src/x.rs" } } });
  await receive("host-peer", { t: "rpc.res", id: req.msg.id, ok: true, result: null });
  await done;
  expect(sent.some((s) => s.msg.t === "doc.open" && s.msg.path === "src/x.rs")).toBe(true);

  // Errors come back as codes and are shown in the guest's language.
  ui.prompt.mockResolvedValueOnce("x.rs");
  sent.length = 0;
  const again = share.remoteCreate("src", false);
  await vi.waitFor(() => expect(sent.find((s) => s.msg.t === "rpc.req")).toBeTruthy());
  await receive("host-peer", refused(sent.find((s) => s.msg.t === "rpc.req")!.msg.id, "exists"));
  await again;
  expect(ui.toasts.at(-1)).toEqual({ text: '"x.rs" already exists there', kind: "error" });
});

const GIT_PATHS = [".git/config", ".GIT/config", ".git./config", ".git /config", "sub/.git/config", ".git\\config", "sub\\.Git\\config", ".git::$INDEX_ALLOCATION/config", "git~1/config"];

test("guests can't read or write a git folder, in any spelling", async () => {
  const fs = hostFs({ "/p/.git/config": "[core]\n", "/p/.gitignore": "x\n", "/p/a.txt": "a\n" });
  for (const path of GIT_PATHS) {
    await receive("g1", { t: "doc.open", path });
    expect(sent.at(-1)!.msg).toEqual({ t: "doc.error", path, error: "unavailable" });
    await fsList("g1", path, 2);
    expect(sent.at(-1)!.msg).toEqual(listed(2));
    for (const op of [{ op: "create", path }, { op: "delete", path }, { op: "rename", path, to: "b.txt" }, { op: "rename", path: "a.txt", to: path }]) {
      await fsOp("g1", 1, op);
      expect(sent.at(-1)!.msg).toEqual(refused(1, "invalid"));
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
  await fsList("g1", "", 4);
  expect(sent.at(-1)!.msg.result.map((e: { name: string }) => e.name)).not.toContain(".git");
  for (const op of [{ op: "delete", path: "vendor" }, { op: "rename", path: "vendor", to: "v2" }]) {
    await fsOp("g1", 5, op);
    expect(sent.at(-1)!.msg).toEqual(refused(5, "invalid"));
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
    await fsOp("g1", 9, { op, path: "a.txt" });
    expect(sent[0].msg).toEqual(refused(9, "invalid_params"));
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
    await fsOp("g1", 11, op);
    expect(sent.find((s) => s.msg.t === "rpc.res")!.msg, `${op.op} during ${during}`).toEqual(refused(11, "unavailable"));
    expect(effects(fs), `${op.op} during ${during}`).toEqual([]);
    expect([fs.files.get("/p/a.txt"), fs.files.get("/q/a.txt")]).toEqual(["p\n", "q\n"]);
  }
});

test("a folder switch during a guest's folder listing doesn't list the new folder", async () => {
  const fs = hostFs({ "/p/a.txt": "p\n", "/q/private.txt": "q\n" });
  switchFolderDuring(fs, "collab_path_inside");
  await fsList("g1", "", 12);
  expect(sent.at(-1)!.msg).toEqual(listed(12));
  expect(fs.calls.filter((c) => c.cmd === "list_dir")).toEqual([]);
});

test("a presence message still being checked when its guest leaves is dropped", async () => {
  const fs = hostFs({ "/p/a.txt": "a\n" });
  const other = fs.other;
  fs.other = (c, args) => {
    if (c === "collab_path_inside") share.forgetPeer("g1");
    return other(c, args);
  };
  await receive("g1", { t: "presence", file: "a.txt", line: 2 });
  expect(share.share.presence.g1).toBeUndefined();
  expect(sent.filter((s) => s.msg.t === "presence")).toEqual([]);
});

test("a guest that leaves loses its presence, also for a later join", async () => {
  hostFs({ "/p/a.txt": "a\n" });
  await receive("g1", { t: "presence", file: "a.txt", line: 2 });
  expect(share.share.presence.g1).toBeTruthy();
  share.follow("g1");
  share.forgetPeer("g1");
  expect(share.share.presence.g1).toBeUndefined();
  expect(share.share.following).toBeNull();
});

test("guest: someone leaving drops their presence, the host's stays", async () => {
  collab.role = "guest";
  await receive("host-peer", { t: "presence", peer: "host", file: null, line: 1, name: "H", color: "#111111" });
  await receive("host-peer", { t: "presence", peer: "g2", file: null, line: 1, name: "G", color: "#222222" });
  await receive("host-peer", { t: "participants", participants: [{ peer: "host" }, { peer: "g1" }] });
  expect(Object.keys(share.share.presence)).toEqual(["host"]);
});

test("without edit a guest's document changes are dropped; it can still read and list", async () => {
  const fs = hostFs({ "/p/a.txt": "a\n" });
  await receive("g1", { t: "doc.open", path: "a.txt" });
  (collab.participants as { caps: string[] }[])[0].caps = [];
  await guestInsert("a.txt", 0, "refused ");
  expect(guestCopy("a.txt")).toBe("a\n");

  sent.length = 0;
  await fsOp("g1", 21, { op: "delete", path: "a.txt" });
  expect(sent[0].msg).toEqual(refused(21, "forbidden"));
  expect(fs.files.has("/p/a.txt")).toBe(true);
  await fsList("g1", "", 22);
  expect(sent.at(-1)!.msg.result.map((e: { name: string }) => e.name)).toContain("a.txt");
});

test("a file system error reaches the guest as a code, without the host's path", async () => {
  hostFs({});
  const { fsApi } = await import("../api");
  const create = vi.spyOn(fsApi, "createFile").mockRejectedValueOnce(new Error("EACCES: /home/secret/p/new.txt"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await fsOp("g1", 23, { op: "create", path: "new.txt" });
  const errors = sent.filter((s) => s.msg.t === "rpc.res");
  expect(errors.at(-1)!.msg).toEqual(refused(23, "failed"));
  expect(JSON.stringify(errors)).not.toContain("/home/secret");
  create.mockRestore();
  log.mockRestore();
});

test("guest without edit: the editor refuses local changes, also direct ones, and takes the host's", async () => {
  const { guestGuard } = await import("./guard");
  const { ySyncAnnotation } = await import("y-codemirror.next");
  collab.role = "guest";
  guestGuard.can = () => false;
  try {
    const h = new Y.Doc();
    h.getText("content").insert(0, "text");
    await receive("host-peer", { t: "doc.state", path: "ro.txt", name: "ro.txt", update: b64(Y.encodeStateAsUpdate(h)) });
    const tab = await vi.waitFor(() => {
      const x = app.tabs.find((y) => y.path === "collab:ro.txt");
      if (!x || !bindings.has(x.id)) throw new Error("not open yet");
      return x;
    });
    const state = EditorState.create({ doc: "text", extensions: bindings.get(tab.id) as any });
    expect(state.readOnly).toBe(true);
    expect(state.update({ changes: { from: 0, insert: "local " } }).state.doc.toString()).toBe("text");
    const fromHost = state.update({ changes: { from: 0, insert: "host " }, annotations: ySyncAnnotation.of({} as never) });
    expect(fromHost.state.doc.toString()).toBe("host text");

    // A host edit while this tab is in the background goes through the same filter.
    texts.set(tab.id, "text");
    const { applyChanges } = await import("../editor");
    vi.mocked(applyChanges).mockClear();
    h.getText("content").insert(0, "bg ");
    await receive("host-peer", { t: "doc.update", path: "ro.txt", update: b64(Y.encodeStateAsUpdate(h)) });
    const spec = vi.mocked(applyChanges).mock.calls[0][1];
    expect(state.update(spec).state.doc.toString()).toBe("bg text");
  } finally {
    guestGuard.can = () => true;
  }
});

test("a guest removed while its doc.open is being checked gets neither the state nor later updates", async () => {
  const fs = hostFs({ "/p/a.txt": "secret\n" });
  const other = fs.other;
  fs.other = (cmd, args) => {
    if (cmd === "collab_path_inside") {
      collab.participants = (collab.participants as { peer: string }[]).filter((p) => p.peer !== "g1");
      share.forgetPeer("g1");
    }
    return other(cmd, args);
  };
  await receive("g1", { t: "doc.open", path: "a.txt" });
  fs.other = other;
  await receive("g2", { t: "doc.open", path: "a.txt" });
  await guestInsert("a.txt", 0, "later ");
  expect(sent.filter((s) => s.peer === "g1")).toEqual([]);
});

test("removing a guest takes it off every shared doc", async () => {
  hostFs({ "/p/a.txt": "a\n", "/p/b.txt": "b\n" });
  await receive("g1", { t: "doc.open", path: "a.txt" });
  await receive("g1", { t: "doc.open", path: "b.txt" });
  share.forgetPeer("g1");
  sent.length = 0;
  await receive("g2", { t: "doc.open", path: "a.txt" });
  await guestInsert("a.txt", 0, "x");
  expect(sent.filter((s) => s.peer === "g1")).toEqual([]);
});

test("a file too large for the transport gives the guest a clear error and keeps the connection", async () => {
  const { RPC_LIMITS } = await import("./rpc.svelte");
  hostFs({ "/p/big.txt": "x".repeat(5000), "/p/small.txt": "s\n" });
  const cap = RPC_LIMITS.maxBytes;
  RPC_LIMITS.maxBytes = 1000;
  try {
    await receive("g1", { t: "doc.open", path: "big.txt" });
    expect(sent.map((s) => s.msg)).toEqual([{ t: "doc.error", path: "big.txt", error: "too_large" }]);
    await receive("g1", { t: "doc.open", path: "small.txt" });
    expect(guestCopy("small.txt")).toBe("s\n");
  } finally {
    RPC_LIMITS.maxBytes = cap;
  }
  collab.role = "guest";
  await receive("host-peer", { t: "doc.error", path: "big.txt", error: "too_large" });
  expect(ui.toasts.at(-1)?.text).toContain("too much data");
});

test("guest: a malformed folder listing from the host is an empty or filtered list", async () => {
  collab.role = "guest";
  for (const [result, expected] of [
    ["nope", []],
    [{ length: 3 }, []],
    [[{ name: 1, rel: "a", is_dir: false }, null, { name: "ok", rel: "ok", is_dir: true }], [{ name: "ok", rel: "ok", is_dir: true }]],
  ] as const) {
    sent.length = 0;
    const p = share.listRemote("");
    await receive("host-peer", { t: "rpc.res", id: sent.at(-1)!.msg.id, ok: true, result });
    expect(await p).toEqual(expected);
  }
});

// ------------------------------------------------------------------ project search for guests

const { replaceInFiles, SEARCH_LIMITS } = await import("./projectSearch.svelte");
const { setCapability } = await import("./rpc.svelte");

/** Literal replace, as the backend plans it: UTF-16 offsets into the text it was given. */
function literalPlan(text: string, query: string, replacement: string) {
  const edits: [number, number, string][] = [];
  for (let i = text.indexOf(query); i >= 0; i = text.indexOf(query, i + query.length)) edits.push([i, i + query.length, replacement]);
  return { edits, count: edits.length, version: ver(text) };
}

/** The fake backend's text version. */
const ver = (text: string) => `v:${text}`;

/** The host's file system plus the search backend's commands; `backend` answers the searches. */
function searchFs(initial: Record<string, string>, backend: (cmd: string, args: Msg) => unknown = () => null) {
  const fs = hostFs(initial);
  const other = fs.other;
  const calls: string[] = [];
  fs.other = (cmd, args) => {
    if (!cmd.startsWith("guest_")) return other(cmd, args);
    calls.push(cmd);
    if (cmd === "guest_read_text") return fs.files.get(`${args.root}/${args.rel}`) ?? null;
    if (cmd === "guest_replace_plan") {
      const r = args.replace as Msg;
      const text = args.text as string;
      const same = r.expectVersion ? r.expectVersion === ver(text) : r.expectLine === ver(text.split("\n")[r.line - 1] ?? "");
      if (!same) throw "changed";
      return literalPlan(text, r.query, r.replacement);
    }
    if (cmd === "guest_write_check") return null;
    if (cmd === "guest_write_text") {
      const path = `${args.root}/${args.rel}`;
      if (args.expected !== ver(fs.files.get(path) ?? "")) throw "changed";
      fs.files.set(path, args.content as string);
      return null;
    }
    return backend(cmd, args as Msg);
  };
  return { fs, calls };
}

const query = (q: string, extra: Msg = {}) => ({ query: q, caseSensitive: true, wholeWord: false, regex: false, mask: "", folder: "", maxResults: 100, ...extra });
const replaceReq = (id: number, file: string, seen: string, q = "old", replacement = "new") => receive("g1", { t: "rpc.req", id, method: "search.replace", params: { query: query(q), replacement, file, expect: { version: ver(seen) } } });
const answer = (id: number) => sent.find((s) => s.peer === "g1" && s.msg.t === "rpc.res" && s.msg.id === id)?.msg;

test("guest Replace in an open file changes the shared doc: live for everyone, unsaved text kept, disk untouched", async () => {
  const { fs } = searchFs({ "/p/a.txt": "old on disk\n" });
  app.tabs.push({ id: "t1", path: "/p/a.txt", name: "a.txt" });
  texts.set("t1", "unsaved old text\n");
  await receive("g1", { t: "doc.open", path: "a.txt" });
  await receive("g2", { t: "doc.open", path: "a.txt" });

  await replaceReq(700, "a.txt", "unsaved old text\n");

  expect(answer(700)).toMatchObject({ ok: true, result: { count: 1 } });
  expect(guestCopy("a.txt")).toBe("unsaved new text\n");
  const g2 = new Y.Doc();
  for (const { peer, msg } of sent) if (peer === "g2" && msg.path === "a.txt" && msg.update && msg.t !== "aw") Y.applyUpdate(g2, unb64(msg.update));
  expect(g2.getText("content").toString()).toBe("unsaved new text\n");
  expect(fs.files.get("/p/a.txt")).toBe("old on disk\n");
});

test("guest Replace in a file nobody has open writes it to disk", async () => {
  const { fs } = searchFs({ "/p/b.txt": "old old\n" });
  await replaceReq(701, "b.txt", "old old\n");
  expect(answer(701)).toMatchObject({ ok: true, result: { count: 2 } });
  expect(fs.files.get("/p/b.txt")).toBe("new new\n");
});

test("guest Replace needs `edit`", async () => {
  const { fs, calls } = searchFs({ "/p/b.txt": "old\n" });
  (collab.participants[0] as { caps: string[] }).caps = ["run"];
  await replaceReq(702, "b.txt", "old\n");
  expect(answer(702)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(calls).toEqual([]);
  expect(fs.files.get("/p/b.txt")).toBe("old\n");
});

test("guest Replace refuses paths in git folders and through escaping symlinks", async () => {
  const { fs } = searchFs({ "/p/.git/config": "old\n", "/p/ext/x.txt": "old\n" });
  await replaceReq(703, ".git/config", "old\n");
  await replaceReq(704, "ext/x.txt", "old\n");
  await replaceReq(705, "../x.txt", "old\n");
  for (const id of [703, 704, 705]) expect(answer(id)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(fs.files.get("/p/.git/config")).toBe("old\n");
  expect(fs.files.get("/p/ext/x.txt")).toBe("old\n");
});

test("taking `edit` away during a Replace stops it before anything changes", async () => {
  const { fs } = searchFs({ "/p/b.txt": "old\n" });
  const other = fs.other;
  let release = () => {};
  let planning = false;
  const held = new Promise<void>((r) => (release = r));
  fs.other = (cmd, args) => {
    if (cmd !== "guest_replace_plan") return other(cmd, args);
    planning = true;
    return held.then(() => other(cmd, args));
  };

  const run = replaceReq(706, "b.txt", "old\n");
  await vi.waitFor(() => expect(planning).toBe(true));
  setCapability("g1", "edit", false);
  release();
  await run;

  expect(answer(706)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(fs.files.get("/p/b.txt")).toBe("old\n");
});

test("a Replace on text that changed while it was planned refuses instead of using stale offsets", async () => {
  const { fs } = searchFs({ "/p/a.txt": "old\n" });
  await receive("g1", { t: "doc.open", path: "a.txt" });
  const other = fs.other;
  let first = true;
  const g = new Y.Doc();
  fs.other = async (cmd, args) => {
    const r = await other(cmd, args);
    if (cmd === "guest_replace_plan" && first) {
      first = false;
      await guestInsert("a.txt", 0, "xx ", g);
    }
    return r;
  };
  await replaceReq(707, "a.txt", "old\n");
  expect(answer(707)).toMatchObject({ ok: false, error: { code: "changed" } });
  expect(guestCopy("a.txt", g)).toBe("xx old\n");
});

test("guest search results hold only what guests may see, and truncation is passed on", async () => {
  searchFs({}, (cmd) =>
    cmd === "guest_search_text"
      ? { hits: ["src/a.txt", ".git/config", "sub/.GIT/x", "/etc/passwd", "../up.txt"].map((file) => ({ file, line: 1, ranges: [[0, 1]], text: "x" })), files: 5, total: 5, truncated: true }
      : null,
  );
  await receive("g1", { t: "rpc.req", id: 710, method: "search.text", params: query("x") });
  const res = answer(710)!;
  expect(res.result.hits.map((h: { file: string }) => h.file)).toEqual(["src/a.txt"]);
  expect(res.result.truncated).toBe(true);
});

test("the guest's file list drops git paths and absolute paths", async () => {
  searchFs({}, (cmd) => (cmd === "guest_list_files" ? { files: ["a.txt", ".git/HEAD", "x/.Git/config", "/etc/passwd"], truncated: true } : null));
  await receive("g1", { t: "rpc.req", id: 711, method: "search.list", params: {} });
  expect(answer(711)).toMatchObject({ ok: true, result: { files: ["a.txt"], truncated: true } });
});

test("an open-files search with no readable file finds nothing instead of walking the project", async () => {
  const { calls } = searchFs({});
  await receive("g1", { t: "rpc.req", id: 712, method: "search.text", params: query("x", { files: [".git/config", "ext/x", "../y"] }) });
  expect(answer(712)).toMatchObject({ ok: true, result: { hits: [], total: 0 } });
  expect(calls).toEqual([]);
});

test("a search folder outside what guests may see is refused", async () => {
  const { calls } = searchFs({});
  await receive("g1", { t: "rpc.req", id: 713, method: "search.text", params: query("x", { folder: "ext" }) });
  expect(answer(713)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(calls).toEqual([]);
});

test("the guest's search sees unsaved text of open files", async () => {
  let seen: Msg = {};
  searchFs({ "/p/a.txt": "disk\n" }, (cmd, args) => {
    if (cmd === "guest_search_text") seen = args.query as Msg;
    return { hits: [], files: 0, total: 0, truncated: false };
  });
  app.tabs.push({ id: "t1", path: "/p/a.txt", name: "a.txt" });
  texts.set("t1", "unsaved\n");
  await receive("g1", { t: "rpc.req", id: 714, method: "search.text", params: query("x") });
  expect(seen.overlay).toEqual({ "a.txt": "unsaved\n" });
});

test("cancelling a guest's search cancels it in the backend", async () => {
  let finish: (v: unknown) => void = () => {};
  const cancelled: unknown[] = [];
  const { fs, calls } = searchFs({}, (cmd) => (cmd === "guest_search_text" ? new Promise((r) => (finish = r)) : null));
  const other = fs.other;
  fs.other = (cmd, args) => {
    if (cmd === "guest_search_cancel") cancelled.push(args.token);
    return other(cmd, args);
  };
  const run = receive("g1", { t: "rpc.req", id: 715, method: "search.text", params: query("x") });
  await vi.waitFor(() => expect(calls).toContain("guest_search_text"));
  await receive("g1", { t: "rpc.cancel", id: 715 });
  await vi.waitFor(() => expect(cancelled).toHaveLength(1));
  finish({ hits: [], files: 0, total: 0, truncated: false });
  await run;
});

test("guest Replace reports each file: done, failed, and where a revoked right stopped it", async () => {
  searchFs({});
  Object.assign(collab, { role: "guest" });
  const run = replaceInFiles(query("old") as never, "new", ["a", "b", "c", "d"].map((n) => ({ file: `collab:${n}.txt`, version: "v" })));
  const reply = async (result: Msg) => {
    await vi.waitFor(() => expect(sent.filter((s) => s.msg.t === "rpc.req" && !s.msg.done).length).toBe(1));
    const req = sent.find((s) => s.msg.t === "rpc.req" && !s.msg.done)!.msg;
    req.done = true;
    await receive("host-peer", { t: "rpc.res", id: req.id, ...result });
    return req.params.file;
  };
  expect(await reply({ ok: true, result: { count: 2 } })).toBe("a.txt");
  expect(await reply({ ok: false, error: { code: "unreadable" } })).toBe("b.txt");
  expect(await reply({ ok: false, error: { code: "forbidden" } })).toBe("c.txt");
  const report = await run;
  expect(report).toMatchObject({ replaced: 2, changed: 1, done: 2 });
  expect(report.errors.map((e) => e.file)).toEqual(["b.txt"]);
  expect(report.stopped).toBeTruthy();
  expect(sent.filter((s) => s.msg.t === "rpc.req")).toHaveLength(3); // d.txt was never tried
});

test("Replace on one hit refuses when that line isn't what the guest saw, and leaves the file alone", async () => {
  const { fs } = searchFs({ "/p/b.txt": "keep\nold now different\n" });
  await receive("g1", { t: "rpc.req", id: 720, method: "search.replace", params: { query: query("old"), replacement: "new", file: "b.txt", expect: { line: 2, lineVersion: ver("old seen") } } });
  expect(answer(720)).toMatchObject({ ok: false, error: { code: "changed" } });
  expect(fs.files.get("/p/b.txt")).toBe("keep\nold now different\n");
  await receive("g1", { t: "rpc.req", id: 721, method: "search.replace", params: { query: query("old"), replacement: "new", file: "b.txt", expect: { line: 2, lineVersion: ver("old now different") } } });
  expect(answer(721)).toMatchObject({ ok: true, result: { count: 1 } });
  expect(fs.files.get("/p/b.txt")).toBe("keep\nnew now different\n");
});

test("a Replace without an expectation is refused as invalid", async () => {
  const { fs } = searchFs({ "/p/b.txt": "old\n" });
  await receive("g1", { t: "rpc.req", id: 722, method: "search.replace", params: { query: query("old"), replacement: "new", file: "b.txt" } });
  expect(answer(722)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  expect(fs.files.get("/p/b.txt")).toBe("old\n");
});

test("a doc opened while a Replace is being planned gets the change as a live edit, not a disk write", async () => {
  const { fs } = searchFs({ "/p/b.txt": "old\n" });
  const other = fs.other;
  let first = true;
  fs.other = async (cmd, args) => {
    const r = await other(cmd, args);
    if (cmd === "guest_replace_plan" && first) {
      first = false;
      await receive("g1", { t: "doc.open", path: "b.txt" });
    }
    return r;
  };
  await replaceReq(723, "b.txt", "old\n");
  expect(answer(723)).toMatchObject({ ok: true, result: { count: 1 } });
  expect(guestCopy("b.txt")).toBe("new\n");
  expect(fs.files.get("/p/b.txt")).toBe("old\n"); // the doc's write comes later, through its own path
});

test("a file with a second hard link is refused before anything changes", async () => {
  const { fs } = searchFs({ "/p/b.txt": "old\n" });
  const other = fs.other;
  fs.other = (cmd, args) => {
    if (cmd === "guest_write_check") throw "hardlinked";
    return other(cmd, args);
  };
  await replaceReq(724, "b.txt", "old\n");
  expect(answer(724)).toMatchObject({ ok: false, error: { code: "hardlinked" } });
  expect(fs.files.get("/p/b.txt")).toBe("old\n");
});

test("an older search still being checked can't cancel the newer one", async () => {
  const cancelled: unknown[] = [];
  const tokens: Record<string, unknown> = {};
  const { fs } = searchFs({}, (cmd, args) => {
    if (cmd === "guest_search_text") tokens[(args.query as Msg).query] = args.token;
    return { hits: [], files: 0, total: 0, truncated: false, versions: {} };
  });
  const other = fs.other;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  fs.other = (cmd, args) => {
    if (cmd === "guest_search_cancel") cancelled.push(args.token);
    if (cmd === "collab_path_inside" && String(args.path).endsWith("/slow")) return held.then(() => true);
    return other(cmd, args);
  };
  const older = receive("g1", { t: "rpc.req", id: 725, method: "search.text", params: query("older", { folder: "slow" }) });
  await receive("g1", { t: "rpc.req", id: 726, method: "search.text", params: query("newer") });
  expect(answer(726)).toMatchObject({ ok: true });
  release();
  await older;
  expect(tokens.older).toBeUndefined(); // it never reached the backend
  expect(cancelled).not.toContain(tokens.newer);
});

test("live text over the limit is left out of the search, skipped and reported as truncated", async () => {
  let seen: Msg = {};
  searchFs({ "/p/big.txt": "disk\n", "/p/a.txt": "disk\n" }, (cmd, args) => {
    if (cmd === "guest_search_text") seen = args.query as Msg;
    return { hits: [], files: 0, total: 0, truncated: false, versions: {} };
  });
  app.tabs.push({ id: "t1", path: "/p/big.txt", name: "big.txt" }, { id: "t2", path: "/p/a.txt", name: "a.txt" });
  texts.set("t1", "x".repeat(SEARCH_LIMITS.liveFile + 1));
  texts.set("t2", "small\n");
  await receive("g1", { t: "rpc.req", id: 727, method: "search.text", params: query("x") });
  expect(Object.keys(seen.overlay)).toEqual(["a.txt"]);
  expect(seen.omit).toEqual(["big.txt"]);
  expect(answer(727)).toMatchObject({ ok: true, result: { truncated: true } });

  await receive("g1", { t: "rpc.req", id: 728, method: "search.read", params: { file: "big.txt" } });
  expect(answer(728)).toMatchObject({ ok: false, error: { code: "too_large" } });
});

test("one guest can only have a few reads running at once", async () => {
  const { fs } = searchFs({ "/p/a.txt": "text\n" });
  const other = fs.other;
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  fs.other = (cmd, args) => (cmd === "guest_read_text" ? held.then(() => other(cmd, args)) : other(cmd, args));
  const runs = Array.from({ length: SEARCH_LIMITS.reads }, (_, i) => receive("g1", { t: "rpc.req", id: 730 + i, method: "search.read", params: { file: "a.txt" } }));
  await vi.waitFor(() => expect(fs.calls.filter((c) => c.cmd === "guest_read_text")).toHaveLength(SEARCH_LIMITS.reads));
  await receive("g1", { t: "rpc.req", id: 739, method: "search.read", params: { file: "a.txt" } });
  expect(answer(739)).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  release();
  await Promise.all(runs);
  expect(answer(730)).toMatchObject({ ok: true, result: "text\n" });
});

test("naming a hidden or ignored file reads it, like doc.open; git folders and escapes stay refused", async () => {
  searchFs({ "/p/.env": "A=1\n", "/p/.git/config": "secret\n", "/p/ext/x": "secret\n" });
  await receive("g1", { t: "rpc.req", id: 740, method: "search.read", params: { file: ".env" } });
  await receive("g1", { t: "rpc.req", id: 741, method: "search.read", params: { file: ".git/config" } });
  await receive("g1", { t: "rpc.req", id: 742, method: "search.read", params: { file: "ext/x" } });
  expect(answer(740)).toMatchObject({ ok: true, result: "A=1\n" });
  expect(answer(741)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(answer(742)).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

/** A guest with a host doc behind it: the guest's updates reach `host`, RPC calls are answered. */
async function guestWithDoc(path: string, text: string) {
  const host = new Y.Doc();
  host.getText("content").insert(0, text);
  Object.assign(collab, { role: "guest" });
  await receive("host-peer", { t: "doc.state", path, name: path, update: b64(Y.encodeStateAsUpdate(host)) });
  await vi.waitFor(() => expect(bindings.has(app.tabs.find((x) => x.path === `collab:${path}`)?.id ?? "")).toBe(true));
  const pull = () => {
    for (const { peer, msg } of sent) if (peer === "host-peer" && msg.t === "doc.update" && msg.path === path) Y.applyUpdate(host, unb64(msg.update));
    return host.getText("content").toString();
  };
  return { host, pull };
}

/** Answers the guest's RPC calls until `run` settles. */
async function serving<T>(run: Promise<T>, reply: (req: Msg) => Msg) {
  let finished = false;
  const out = run.finally(() => (finished = true));
  const answered = new Set<number>();
  while (!finished) {
    for (const { msg } of [...sent]) {
      if (msg.t !== "rpc.req" || answered.has(msg.id)) continue;
      answered.add(msg.id);
      await receive("host-peer", { t: "rpc.res", id: msg.id, ...reply(msg) });
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  return out;
}

const yes = (req: Msg) => ({ ok: true, result: req.method === "search.applied" ? true : null });

test("a guest's Replace in a doc it has open is on its undo stack, and undo reaches the host", async () => {
  searchFs({});
  const { pull } = await guestWithDoc("a.txt", "old text\n");
  const tabId = app.tabs.find((x) => x.path === "collab:a.txt")!.id;
  const report = await serving(replaceInFiles(query("old") as never, "new", [{ file: "collab:a.txt", version: ver("old text\n") }]), yes);
  expect(report).toMatchObject({ replaced: 1, changed: 1, errors: [] });
  expect(pull()).toBe("new text\n");
  runAction(tabId, "collab.undo");
  expect(pull()).toBe("old text\n");
  runAction(tabId, "collab.redo");
  expect(pull()).toBe("new text\n");
});

test("a guest's Replace the host never confirms is reported, not counted as done", async () => {
  searchFs({});
  await guestWithDoc("a.txt", "old\n");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let report: Awaited<ReturnType<typeof replaceInFiles>> | undefined;
    const run = replaceInFiles(query("old") as never, "new", [{ file: "collab:a.txt", version: ver("old\n") }]).then((r) => (report = r));
    const answered = new Set<number>();
    for (let i = 0; i < 300 && !report; i++) {
      for (const { msg } of [...sent]) {
        if (msg.t !== "rpc.req" || answered.has(msg.id)) continue;
        answered.add(msg.id);
        await receive("host-peer", { t: "rpc.res", id: msg.id, ok: true, result: msg.method === "search.applied" ? false : null });
      }
      await vi.advanceTimersByTimeAsync(20);
    }
    await run;
    expect(report).toMatchObject({ replaced: 0, changed: 0 });
    expect(report!.errors.map((e) => e.file)).toEqual(["a.txt"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a file the guest changed after the search is refused and reported in its own doc", async () => {
  searchFs({});
  const { pull } = await guestWithDoc("a.txt", "old but edited\n");
  const report = await serving(replaceInFiles(query("old") as never, "new", [{ file: "collab:a.txt", version: ver("old as seen\n") }]), yes);
  expect(report).toMatchObject({ replaced: 0, changed: 0 });
  expect(report.errors).toHaveLength(1);
  expect(pull()).toBe("old but edited\n");
});

test("the Find preview edits the shared doc without a tab, and lets go of it afterwards", async () => {
  const { EditorView } = await import("@codemirror/view");
  searchFs({});
  Object.assign(collab, { role: "guest" });
  const onDoc = vi.fn();
  const stop = share.guestPreviewDoc("p.txt", onDoc);
  expect(sent.some((s) => s.msg.t === "doc.open" && s.msg.path === "p.txt")).toBe(true);
  const host = new Y.Doc();
  host.getText("content").insert(0, "hello\n");
  await receive("host-peer", { t: "doc.state", path: "p.txt", update: b64(Y.encodeStateAsUpdate(host)) });
  expect(app.tabs).toEqual([]);
  const [ext, text] = onDoc.mock.calls[0];
  expect(text).toBe("hello\n");

  const view = new EditorView({ state: EditorState.create({ doc: text, extensions: ext }) });
  view.dispatch({ changes: { from: 0, insert: "X" } });
  for (const { msg } of sent) if (msg.t === "doc.update" && msg.path === "p.txt") Y.applyUpdate(host, unb64(msg.update));
  expect(host.getText("content").toString()).toBe("Xhello\n");
  view.destroy();

  stop();
  expect(sent.some((s) => s.msg.t === "doc.close" && s.msg.path === "p.txt")).toBe(true);
  expect(share.guestHasDoc("p.txt")).toBe(false);
});

test("a preview closed before the host answers opens no tab and releases the doc", async () => {
  searchFs({});
  Object.assign(collab, { role: "guest" });
  const stop = share.guestPreviewDoc("late.txt", vi.fn());
  stop();
  const host = new Y.Doc();
  host.getText("content").insert(0, "x");
  await receive("host-peer", { t: "doc.state", path: "late.txt", update: b64(Y.encodeStateAsUpdate(host)) });
  expect(app.tabs).toEqual([]);
  expect(share.guestHasDoc("late.txt")).toBe(false);
  expect(sent.some((s) => s.msg.t === "doc.close" && s.msg.path === "late.txt")).toBe(true);
});

test("before git replaces files, pending shared text is written; a failed write is reported", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = hostFs({ "/p/a.txt": "original\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    await guestInsert("a.txt", 0, "Y");
    expect(share.sharedDocUnsaved("a.txt")).toBe(true);
    fs.failWrite = "disk full";
    expect(await share.flushSharedDocs()).toBe(false);
    expect(fs.files.get("/p/a.txt")).toBe("original\n");
    fs.failWrite = null;
    expect(await share.flushSharedDocs()).toBe(true);
    expect(fs.files.get("/p/a.txt")).toBe("Yoriginal\n");
    expect(share.sharedDocUnsaved("a.txt")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("after a branch switch open docs show the new text to everybody", async () => {
  const fs = hostFs({ "/p/a.txt": "on main\n" });
  await receive("g1", { t: "doc.open", path: "a.txt" });
  fs.files.set("/p/a.txt", "on feature\n");
  expect(await share.reloadSharedDocs()).toEqual([]);
  expect(guestCopy("a.txt")).toBe("on feature\n");
});

test("text typed while git ran survives the reload and is reported", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const fs = hostFs({ "/p/a.txt": "on main\n" });
    await receive("g1", { t: "doc.open", path: "a.txt" });
    const g = await guestInsert("a.txt", 0, "Y");
    fs.files.set("/p/a.txt", "on feature\n");
    expect(await share.reloadSharedDocs()).toEqual(["a.txt"]);
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.files.get("/p/a.txt")).toBe("Yon main\n");
    expect(guestCopy("a.txt", g)).toBe("Yon main\n");
  } finally {
    vi.useRealTimers();
  }
});

test("guest: a chunk reverted in the diff reaches the host, unless the file changed meanwhile", async () => {
  collab.role = "guest";
  const h = new Y.Doc();
  h.getText("content").insert(0, "one\ntwo\n");
  await receive("host-peer", { t: "doc.state", path: "d.txt", name: "d.txt", update: b64(Y.encodeStateAsUpdate(h)) });
  await vi.waitFor(() => expect(share.sharedDocOpen("d.txt")).toBe(true));
  const { ChangeSet } = await import("@codemirror/state");
  sent.length = 0;
  expect(share.editSharedDoc("d.txt", "stale text", ChangeSet.of({ from: 0, to: 3, insert: "1" }, 10))).toBe(false);
  expect(sent).toEqual([]);
  expect(share.editSharedDoc("d.txt", "one\ntwo\n", ChangeSet.of([{ from: 0, to: 3, insert: "1" }, { from: 4, to: 7, insert: "2" }], 8))).toBe(true);
  const update = sent.find((s) => s.peer === "host-peer" && s.msg.t === "doc.update")!.msg.update;
  Y.applyUpdate(h, unb64(update));
  expect(h.getText("content").toString()).toBe("1\n2\n");
});
