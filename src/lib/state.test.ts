// Regression tests for #2 (external changes overwritten on save), #3/#4 (what reaches write_file)
// and #6 (New File truncated existing files). The editor and dialogs are faked; the file system is
// an in-memory map behind mockIPC (see src/test/fakes.ts).
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { deferred, fakeFs, flush, type FakeEditor, type FakeFs, type FakeUi } from "../test/fakes";

vi.mock("./editor", async () => (await import("../test/fakes")).fakeEditor());
vi.mock("./ui.svelte", async () => ({ ui: (await import("../test/fakes")).fakeUi() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null), save: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }),
}));
vi.mock("./latex/controller.svelte", () => ({ schedule: vi.fn() }));
vi.mock("./code/lspExtension", () => ({ setLspHooks: vi.fn() }));
vi.mock("./code/lsp.svelte", () => ({ allClients: () => [], fileUri: (p: string) => "file://" + p }));
vi.mock("./markdown/livePreview", () => ({ setLinkHandler: vi.fn(), resolvePath: vi.fn() }));
vi.mock("./modes", () => ({ modeForExtension: () => null }));
vi.mock("./fsWatch.svelte", () => ({ onFilesChanged: vi.fn(), watchRoot: vi.fn() }));
vi.mock("./i18n/index.svelte", () => ({ t: (k: string, p?: object) => (p ? `${k} ${JSON.stringify(p)}` : k) }));

let fs: FakeFs;
let ed: FakeEditor;
let ui: FakeUi;
let st: typeof import("./state.svelte");

async function setup(files: Record<string, string>) {
  vi.resetModules();
  fs = fakeFs(files);
  ed = (await import("./editor")) as unknown as FakeEditor;
  ui = ((await import("./ui.svelte")) as unknown as { ui: FakeUi }).ui;
  // Mocked modules survive vi.resetModules(): start from a clean fake.
  ed.reset();
  ui.reset();
  st = await import("./state.svelte");
}

async function open(path: string) {
  await st.openFile(path);
  const tab = st.app.tabs.find((t) => t.path === path);
  if (!tab) throw new Error("tab not opened");
  return tab;
}

const writes = () => fs.calls.filter((c) => c.cmd === "write_file").map((c) => c.args);

// The first import of state.svelte transforms its whole dependency graph, which takes seconds on
// a loaded machine. Do it once here, so it doesn't count against the first test's timeout (a timed
// out test keeps running and writes into the next test's fakes). Later imports after
// vi.resetModules() reuse the transform cache.
beforeAll(async () => {
  await import("./state.svelte");
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("syncFromDisk (#2)", () => {
  test("clean tab reloads from disk, keeping the new line ending", async () => {
    await setup({ "/p/a.txt": "one\n" });
    const tab = await open("/p/a.txt");
    fs.files.set("/p/a.txt", "two\r\nthree\r\n");
    await st.syncFromDisk();
    expect(ed.getText(tab.id)).toBe("two\nthree\n");
    expect(ed.savedText(tab.id)).toBe("two\nthree\n");
    expect(tab.dirty).toBe(false);
    expect(tab.eol).toBe("\r\n");
    expect(ui.choose).not.toHaveBeenCalled();
  });

  test("only the given paths are checked", async () => {
    await setup({ "/p/a.txt": "a", "/p/b.txt": "b" });
    const a = await open("/p/a.txt");
    const b = await open("/p/b.txt");
    fs.files.set("/p/a.txt", "A");
    fs.files.set("/p/b.txt", "B");
    await st.syncFromDisk(["/p/b.txt"]);
    expect(ed.getText(a.id)).toBe("a");
    expect(ed.getText(b.id)).toBe("B");
  });

  test("disk unchanged except line endings: buffer untouched, eol updated", async () => {
    await setup({ "/p/a.txt": "x\ny\n" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "x\ny\nmine");
    fs.files.set("/p/a.txt", "x\r\ny\r\n");
    await st.syncFromDisk();
    expect(ed.getText(tab.id)).toBe("x\ny\nmine");
    expect(tab.dirty).toBe(true);
    expect(tab.eol).toBe("\r\n");
    expect(ui.choose).not.toHaveBeenCalled();
  });

  test("dirty tab whose text equals the new disk content is just marked saved", async () => {
    await setup({ "/p/a.txt": "old" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "new");
    expect(tab.dirty).toBe(true);
    fs.files.set("/p/a.txt", "new");
    await st.syncFromDisk();
    expect(tab.dirty).toBe(false);
    expect(ed.savedText(tab.id)).toBe("new");
    expect(ui.choose).not.toHaveBeenCalled();
  });

  test("dirty tab differing from disk asks once; repeated syncs don't ask again", async () => {
    await setup({ "/p/a.txt": "old" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "mine");
    fs.files.set("/p/a.txt", "theirs");
    await st.syncFromDisk();
    await flush();
    await st.syncFromDisk();
    await st.syncFromDisk(["/p/a.txt"]);
    await flush();
    expect(ui.choose).toHaveBeenCalledTimes(1);
    expect(ed.getText(tab.id)).toBe("mine"); // never overwritten silently
    expect(writes()).toEqual([]);
  });

  test("conflict answered 'reload' loads the disk version", async () => {
    await setup({ "/p/a.txt": "old" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "mine");
    fs.files.set("/p/a.txt", "theirs\r\n");
    await st.syncFromDisk();
    await flush();
    ui.answer("reload");
    await flush();
    expect(ed.getText(tab.id)).toBe("theirs\n");
    expect(tab.dirty).toBe(false);
    expect(tab.eol).toBe("\r\n");
    expect(writes()).toEqual([]);
  });

  test("conflict answered 'keep' overwrites the file with the buffer", async () => {
    await setup({ "/p/a.txt": "old" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "mine");
    fs.files.set("/p/a.txt", "theirs");
    await st.syncFromDisk();
    await flush();
    ui.answer("keep");
    await flush();
    expect(fs.files.get("/p/a.txt")).toBe("mine");
    expect(tab.dirty).toBe(false);
  });

  test("conflict dismissed: buffer stays dirty, asked again on the next sync", async () => {
    await setup({ "/p/a.txt": "old" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "mine");
    fs.files.set("/p/a.txt", "theirs");
    await st.syncFromDisk();
    await flush();
    ui.answer(null);
    await flush();
    expect(tab.dirty).toBe(true);
    expect(fs.files.get("/p/a.txt")).toBe("theirs");
    await st.syncFromDisk();
    await flush();
    expect(ui.choose).toHaveBeenCalledTimes(2);
  });

  test("two conflicting tabs are asked one after the other (queued)", async () => {
    await setup({ "/p/a.txt": "a", "/p/b.txt": "b" });
    const a = await open("/p/a.txt");
    const b = await open("/p/b.txt");
    ed.type(a.id, "a mine");
    ed.type(b.id, "b mine");
    fs.files.set("/p/a.txt", "a theirs");
    fs.files.set("/p/b.txt", "b theirs");
    await st.syncFromDisk();
    await flush();
    expect(ui.choose).toHaveBeenCalledTimes(1);
    expect(ui.choose.mock.calls[0][0]).toContain("a.txt");
    ui.answer("reload");
    await flush();
    expect(ed.getText(a.id)).toBe("a theirs");
    expect(ui.choose).toHaveBeenCalledTimes(2);
    expect(ui.choose.mock.calls[1][0]).toContain("b.txt");
    ui.answer("keep");
    await flush();
    expect(fs.files.get("/p/b.txt")).toBe("b mine");
  });

  test("a call during a running sync is not lost: it sets syncAgain and every tab is rechecked", async () => {
    await setup({ "/p/a.txt": "a", "/p/b.txt": "b" });
    const a = await open("/p/a.txt");
    const b = await open("/p/b.txt");
    const gate = deferred();
    fs.beforeRead = (p) => (p === "/p/a.txt" ? gate.promise : undefined);
    const first = st.syncFromDisk(["/p/a.txt"]);
    await flush();
    // While the first run waits for a.txt, b.txt changes and its event arrives.
    fs.files.set("/p/b.txt", "B");
    await st.syncFromDisk(["/p/b.txt"]); // returns immediately (run in progress)
    expect(ed.getText(b.id)).toBe("b");
    fs.beforeRead = () => {};
    gate.resolve();
    await first;
    expect(ed.getText(b.id)).toBe("B");
    expect(ed.getText(a.id)).toBe("a");
  });

  test("a tab that is being written is skipped", async () => {
    await setup({ "/p/a.txt": "old" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "mine");
    const gate = deferred();
    fs.beforeWrite = () => gate.promise;
    const saving = st.save(tab.id);
    await flush();
    expect(fs.calls.some((c) => c.cmd === "write_file")).toBe(true);
    fs.files.set("/p/a.txt", "half-written");
    await st.syncFromDisk();
    await flush();
    expect(ui.choose).not.toHaveBeenCalled();
    expect(ed.getText(tab.id)).toBe("mine");
    gate.resolve();
    expect(await saving).toBe(true);
    expect(fs.files.get("/p/a.txt")).toBe("mine");
    expect(tab.dirty).toBe(false);
  });

  test("deleted file: buffer kept", async () => {
    await setup({ "/p/a.txt": "a" });
    const tab = await open("/p/a.txt");
    fs.files.delete("/p/a.txt");
    await st.syncFromDisk();
    expect(ed.getText(tab.id)).toBe("a");
    expect(st.app.tabs).toHaveLength(1);
  });
});

describe("save()", () => {
  test("plain save writes the buffer and marks the tab saved", async () => {
    await setup({ "/p/a.txt": "a" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "b");
    const saved = vi.fn();
    window.addEventListener("omega:saved", saved);
    expect(await st.save(tab.id)).toBe(true);
    window.removeEventListener("omega:saved", saved);
    expect(writes()).toEqual([{ path: "/p/a.txt", content: "b" }]);
    expect(tab.dirty).toBe(false);
    expect(ed.savedText(tab.id)).toBe("b");
    expect(saved).toHaveBeenCalledTimes(1);
  });

  test("refuses to overwrite a file changed on disk; asks instead (#2)", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "hello!");
    fs.files.set("/p/a.txt", "changed externally\n");
    const res = st.save(tab.id);
    await flush();
    expect(ui.choose).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
    ui.answer(null);
    expect(await res).toBe(false);
    expect(fs.files.get("/p/a.txt")).toBe("changed externally\n");
  });

  test("a save while the question is open returns false without asking again", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "hello!");
    fs.files.set("/p/a.txt", "other");
    void st.save(tab.id);
    await flush();
    expect(await st.save(tab.id)).toBe(false);
    expect(ui.choose).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
  });

  test("'keep' passes overwrite=true and writes", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "hello!");
    fs.files.set("/p/a.txt", "other");
    const res = st.save(tab.id);
    await flush();
    ui.answer("keep");
    expect(await res).toBe(true);
    expect(fs.files.get("/p/a.txt")).toBe("hello!");
    expect(ui.choose).toHaveBeenCalledTimes(1);
  });

  test("explicit overwrite=true skips the disk check", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "mine");
    fs.files.set("/p/a.txt", "other");
    expect(await st.save(tab.id, false, true)).toBe(true);
    expect(fs.files.get("/p/a.txt")).toBe("mine");
    expect(ui.choose).not.toHaveBeenCalled();
  });

  test("disk already equal to the buffer: writes without asking", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "same");
    fs.files.set("/p/a.txt", "same");
    expect(await st.save(tab.id)).toBe(true);
    expect(ui.choose).not.toHaveBeenCalled();
  });

  test("file deleted on disk: written again (nothing to protect)", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "x");
    fs.files.delete("/p/a.txt");
    expect(await st.save(tab.id)).toBe(true);
    expect(fs.files.get("/p/a.txt")).toBe("x");
  });

  test("never writes without a live document", async () => {
    await setup({ "/p/a.txt": "content" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "content2");
    ed.dropLive = true;
    expect(await st.save(tab.id)).toBe(false);
    expect(writes()).toEqual([]);
    expect(fs.files.get("/p/a.txt")).toBe("content");
  });

  test("failed write: error toast, returns false, tab stays dirty", async () => {
    await setup({ "/p/a.txt": "a" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "b");
    fs.failWrite = "disk full";
    expect(await st.save(tab.id)).toBe(false);
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining("disk full"), "error");
    expect(tab.dirty).toBe(true);
    expect(ed.savedText(tab.id)).toBe("a");
  });

  test("CRLF file is written back as CRLF (#4)", async () => {
    await setup({ "/p/crlf.txt": "line1\r\nline2\r\n" });
    const tab = await open("/p/crlf.txt");
    expect(tab.eol).toBe("\r\n");
    expect(ed.getText(tab.id)).toBe("line1\nline2\n");
    ed.type(tab.id, "line1x\nline2\n");
    expect(await st.save(tab.id)).toBe(true);
    expect(writes()).toEqual([{ path: "/p/crlf.txt", content: "line1x\r\nline2\r\n" }]);
    // The CRLF file on disk is not seen as an external change afterwards.
    ed.type(tab.id, "line1x\nline2\nline3\n");
    expect(await st.save(tab.id)).toBe(true);
    expect(fs.files.get("/p/crlf.txt")).toBe("line1x\r\nline2\r\nline3\r\n");
    expect(ui.choose).not.toHaveBeenCalled();
  });

  test("LF file stays LF", async () => {
    await setup({ "/p/lf.txt": "a\nb\n" });
    const tab = await open("/p/lf.txt");
    ed.type(tab.id, "a\nb\nc\n");
    await st.save(tab.id);
    expect(fs.files.get("/p/lf.txt")).toBe("a\nb\nc\n");
  });

  test("lone surrogate in the buffer: save succeeds with U+FFFD (#3)", async () => {
    await setup({ "/p/e.txt": "emoji 😀 x" });
    const tab = await open("/p/e.txt");
    ed.type(tab.id, "emoji \uD83DY\uDE00 x");
    expect(await st.save(tab.id)).toBe(true);
    expect(fs.files.get("/p/e.txt")).toBe("emoji �Y� x");
  });

  // After saving a buffer with a lone surrogate, the saved snapshot keeps the surrogate while
  // the disk holds U+FFFD; the next save (or focus sync) must not see an "external change".
  test("next save after a lone-surrogate save does not report a false conflict (#21)", async () => {
    await setup({ "/p/e.txt": "emoji 😀 x" });
    const tab = await open("/p/e.txt");
    ed.type(tab.id, "emoji \uD83DY\uDE00 x");
    expect(await st.save(tab.id)).toBe(true);
    ed.type(tab.id, "emoji \uD83DY\uDE00 x!");
    ui.nextChoice = null; // a dialog, if shown, is dismissed
    expect(await st.save(tab.id)).toBe(true);
    expect(ui.choose).not.toHaveBeenCalled();
    expect(fs.files.get("/p/e.txt")).toBe("emoji �Y� x!");
  });

  test("focus sync on a dirty tab after a lone-surrogate save asks nothing (#21)", async () => {
    await setup({ "/p/e.txt": "emoji 😀 x" });
    const tab = await open("/p/e.txt");
    ed.type(tab.id, "emoji \uD83DY\uDE00 x");
    expect(await st.save(tab.id)).toBe(true);
    ed.type(tab.id, "emoji \uD83DY\uDE00 x!");
    await st.syncFromDisk();
    await flush();
    expect(ui.choose).not.toHaveBeenCalled();
    expect(ed.getText(tab.id)).toBe("emoji \uD83DY\uDE00 x!");
  });

  test("autosave writes shortly after typing stops", async () => {
    await setup({ "/p/a.txt": "a" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "ab");
    await vi.advanceTimersByTimeAsync(500);
    expect(writes()).toEqual([]);
    ed.type(tab.id, "abc"); // restarts the timer
    await vi.advanceTimersByTimeAsync(500);
    expect(writes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(writes()).toEqual([{ path: "/p/a.txt", content: "abc" }]);
    expect(tab.dirty).toBe(false);
  });

  test("autosave does not overwrite an external change (#2)", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "hello!");
    fs.files.set("/p/a.txt", "changed externally\n");
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(ui.choose).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
    expect(fs.files.get("/p/a.txt")).toBe("changed externally\n");
  });
});

describe("createEntry: New File (#6)", () => {
  test("creates a new file with create_file (never write_file) and opens it", async () => {
    await setup({});
    expect(await st.createEntry("/p", "new.txt", false)).toBe(true);
    await flush();
    expect(fs.calls.find((c) => c.cmd === "create_file")?.args).toEqual({ path: "/p/new.txt" });
    expect(writes()).toEqual([]);
    expect(st.app.tabs.map((t) => t.path)).toEqual(["/p/new.txt"]);
  });

  test("existing name: file untouched, 'already exists' toast, nothing opened", async () => {
    await setup({ "/p/main.c": "int main() { return 0; }\n" });
    const before = st.app.treeVersion;
    expect(await st.createEntry("/p", "main.c", false)).toBe(false);
    await flush();
    expect(fs.files.get("/p/main.c")).toBe("int main() { return 0; }\n");
    expect(writes()).toEqual([]);
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining("code.existsAlready"), "error");
    expect(ui.toast.mock.calls[0][0]).toContain("main.c");
    expect(st.app.tabs).toHaveLength(0);
    expect(st.app.treeVersion).toBe(before);
  });

  test("other create errors are shown as is", async () => {
    await setup({});
    // create_file fails for a reason other than "exists" (path_exists stays false).
    mockIPC((cmd) => {
      if (cmd === "create_file") throw "Permission denied (os error 13)";
      if (cmd === "path_exists") return false;
      return null;
    });
    expect(await st.createEntry("/p", "x.txt", false)).toBe(false);
    expect(ui.toast).toHaveBeenCalledWith("Permission denied (os error 13)", "error");
  });

  test("New Folder uses create_dir", async () => {
    await setup({});
    expect(await st.createEntry("/p", "sub", true)).toBe(true);
    expect(fs.calls.map((c) => c.cmd)).toContain("create_dir");
    expect(fs.calls.map((c) => c.cmd)).not.toContain("create_file");
    expect(st.app.tabs).toHaveLength(0);
  });
});

describe("createEntry: names that leave the folder (#35)", () => {
  test.each(["../escape.txt", "a/../../x.txt", "/abs.txt", "trailing/", "a//b.txt", ".", ".."])(
    "rejects %s with a translated toast and creates nothing",
    async (name) => {
      await setup({});
      expect(await st.createEntry("/p", name, false)).toBe(false);
      expect(await st.createEntry("/p", name, true)).toBe(false);
      const cmds = fs.calls.map((c) => c.cmd);
      expect(cmds).not.toContain("create_file");
      expect(cmds).not.toContain("create_dir");
      expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining("app.invalidEntryName"), "error");
      expect(st.app.tabs).toHaveLength(0);
    },
  );

  test("sub/inner.txt is still allowed", async () => {
    await setup({});
    expect(await st.createEntry("/p", "sub/inner.txt", false)).toBe(true);
    expect(fs.calls.find((c) => c.cmd === "create_file")?.args).toEqual({ path: "/p/sub/inner.txt" });
  });

  test("inRoot resolves .. segments", async () => {
    await setup({});
    expect(st.inRoot("/p/../escape.txt", "/p")).toBe(false);
    expect(st.inRoot("/p/sub/../a.txt", "/p")).toBe(true);
    expect(st.inRoot("/p/./a.txt", "/p")).toBe(true);
    expect(st.resolveDots("/..")).toBe("/");
    expect(st.resolveDots("C:/a/..")).toBe("C:/");
  });

  test("openFile normalises .. in the tab path", async () => {
    await setup({ "/x.txt": "hi" });
    await st.openFile("/p/../x.txt");
    expect(st.app.tabs.map((t) => t.path)).toEqual(["/x.txt"]);
  });
});

describe("Markdown heading anchor links (#42)", () => {
  async function linkHandler() {
    const lp = (await import("./markdown/livePreview")) as unknown as {
      setLinkHandler: { mock: { calls: [(href: string, from: string | null) => Promise<void>][] } };
      resolvePath: { mockImplementation(fn: (href: string) => string): void };
    };
    lp.resolvePath.mockImplementation((href) => "/p/" + href.split("#")[0]);
    return lp.setLinkHandler.mock.calls.at(-1)![0];
  }
  /** Minimal CodeMirror view over the fake editor's text of the active tab. */
  function fakeView() {
    const dispatch = vi.fn();
    const view = {
      state: {
        doc: {
          line: (n: number) => {
            const lines = ed.getText(st.app.activeId!).split("\n");
            return { from: lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0) };
          },
        },
      },
      dispatch,
      focus: vi.fn(),
    };
    (ed as unknown as { getView: () => unknown }).getView = () => view;
    return dispatch;
  }
  afterEach(() => {
    (ed as unknown as { getView: () => unknown }).getView = () => null;
  });

  test("[x](#sec-two) moves the cursor to the heading", async () => {
    await setup({ "/p/a.md": "# T\n\n## Sec two\n\n[jump](#sec-two)" });
    await open("/p/a.md");
    const dispatch = fakeView();
    await (await linkHandler())("#sec-two", "/p/a.md");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ selection: { anchor: 5 } }));
  });

  test("unknown anchor: toast instead of silence", async () => {
    await setup({ "/p/a.md": "# T" });
    await open("/p/a.md");
    const dispatch = fakeView();
    await (await linkHandler())("#nope", "/p/a.md");
    expect(dispatch).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining("app.headingNotFound"), "error");
  });

  test("other.md#second opens the file and jumps to the heading", async () => {
    await setup({ "/p/a.md": "[x](second.md#second)", "/p/second.md": "intro\n\n# Second" });
    await open("/p/a.md");
    const dispatch = fakeView();
    await (await linkHandler())("second.md#second", "/p/a.md");
    expect(st.activeTab()?.path).toBe("/p/second.md");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ selection: { anchor: 7 } }));
  });
});

describe("file deleted outside Omega (#32)", () => {
  test("clean tab: marked deleted and dirty, closing asks first", async () => {
    await setup({ "/p/a.txt": "keep me" });
    const tab = await open("/p/a.txt");
    fs.files.delete("/p/a.txt");
    await st.syncFromDisk();
    expect(tab.deleted).toBe(true);
    expect(tab.dirty).toBe(true);
    expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining("app.deletedOnDisk"));
    ui.choose.mockResolvedValueOnce("cancel");
    await st.closeTab(tab.id);
    expect(ui.choose).toHaveBeenCalledTimes(1);
    expect(st.app.tabs).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(fs.files.has("/p/a.txt")).toBe(false);
  });

  test("dirty tab: autosave does not recreate the file, Ctrl+S does", async () => {
    await setup({ "/p/a.txt": "hello" });
    const tab = await open("/p/a.txt");
    ed.type(tab.id, "hello!");
    fs.files.delete("/p/a.txt"); // before the watcher noticed
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(fs.files.has("/p/a.txt")).toBe(false);
    expect(tab.deleted).toBe(true);
    await st.flushAutosave();
    expect(fs.files.has("/p/a.txt")).toBe(false);
    expect(await st.save(tab.id)).toBe(true);
    expect(fs.files.get("/p/a.txt")).toBe("hello!");
    expect(tab.deleted).toBe(false);
    expect(tab.dirty).toBe(false);
  });

  test("file comes back unchanged: the mark is cleared", async () => {
    await setup({ "/p/a.txt": "same" });
    const tab = await open("/p/a.txt");
    fs.files.delete("/p/a.txt");
    await st.syncFromDisk();
    fs.files.set("/p/a.txt", "same");
    await st.syncFromDisk();
    expect(tab.deleted).toBe(false);
    expect(tab.dirty).toBe(false);
  });
});
