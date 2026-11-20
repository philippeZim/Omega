// Regression tests for #5: the control MCP `save` tool reported success before writing and even
// when saving failed.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { deferred, flush } from "../../test/fakes";

type FakeTab = { id: string; path: string | null; name: string; dirty: boolean };
const h = vi.hoisted(() => ({
  app: { tabs: [] as FakeTab[], activeId: null as string | null, root: null as string | null, mode: "text" },
  save: (_id?: string | null): Promise<boolean> => Promise.resolve(true),
}));

vi.mock("../state.svelte", () => ({
  app: h.app,
  activeTab: () => h.app.tabs.find((t) => t.id === h.app.activeId) ?? null,
  save: (id?: string | null) => h.save(id),
  openFile: vi.fn(),
  setMode: vi.fn(),
  setRoot: vi.fn(),
}));
vi.mock("../ui.svelte", async () => ({ ui: (await import("../../test/fakes")).fakeUi() }));
vi.mock("../editor", async () => (await import("../../test/fakes")).fakeEditor());
vi.mock("./snapshot", () => ({ snapshotPng: vi.fn() }));
vi.mock("../commands.svelte", () => ({
  COMMANDS: [],
  keysFor: () => [],
  runCommand: vi.fn(),
  availableCommands: () => [],
  palette: { open: false, tab: "" },
  isTerminalShortcut: () => false,
}));
vi.mock("../keys", () => ({ formatKey: String }));
vi.mock("../git/git.svelte", () => ({ git: {} }));
vi.mock("../debug/store.svelte", () => ({ dbg: {} }));
vi.mock("../collab/collab.svelte", () => ({ collab: {} }));
vi.mock("../terminal.svelte", () => ({
  terms: [],
  readTerminal: vi.fn(),
  runCommand: vi.fn(),
  newTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  toggleSplit: vi.fn(),
}));
vi.mock("../layout.svelte", () => ({
  layout: { zones: {} },
  ZONES: [],
  VIEWS: [],
  visibleViews: vi.fn(),
  activeView: vi.fn(),
  zoneShown: vi.fn(),
  isShown: vi.fn(),
  available: vi.fn(),
  showView: vi.fn(),
  hideView: vi.fn(),
  focusView: vi.fn(),
  moveView: vi.fn(),
  setOpen: vi.fn(),
  resetLayout: vi.fn(),
}));
vi.mock("../code/runner.svelte", () => ({ runner: {} }));
vi.mock("../search/search.svelte", () => ({ find: {} }));
vi.mock("../settings.svelte", () => ({ settings: {} }));
vi.mock("../report.svelte", () => ({ report: { open: false } }));

// The module wraps console.* at import time; undo that after each test.
const origConsole = { error: console.error, warn: console.warn, log: console.log, info: console.info };
let replies: { call: number; result: any }[];
let saveTool: { run: (args: Record<string, any>) => unknown };

beforeEach(async () => {
  replies = [];
  mockIPC(
    (cmd, args: any) => {
      if (cmd === "mcp_reply") replies.push(args);
      return null;
    },
    { shouldMockEvents: true },
  );
  h.app.tabs = [
    { id: "a", path: "/p/a.txt", name: "a.txt", dirty: true },
    { id: "b", path: "/p/b.txt", name: "b.txt", dirty: false },
    { id: "c", path: null, name: "Untitled 1", dirty: true },
  ];
  h.app.activeId = "a";
  vi.resetModules(); // fresh module → its mcp-call listener registers on this test's event mock
  const mod = await import("./control.svelte");
  saveTool = mod.TOOLS.find((t) => t.name === "save")!;
});
afterEach(() => Object.assign(console, origConsole));

describe("control MCP save tool (#5)", () => {
  test("saves the active tab and reports success", async () => {
    const save = vi.fn(async () => true);
    h.save = save;
    expect(await saveTool.run({})).toBe("gespeichert");
    expect(save.mock.calls).toEqual([["a"]]);
  });

  test("throws when no tab is active", async () => {
    const save = vi.fn(async () => true);
    h.save = save;
    h.app.activeId = null;
    await expect(saveTool.run({})).rejects.toThrow("Kein Tab aktiv");
    expect(save).not.toHaveBeenCalled();
  });

  test("throws when save() returns false", async () => {
    h.save = async () => false;
    await expect(saveTool.run({})).rejects.toThrow("/p/a.txt");
  });

  test("does not report success before the write finished", async () => {
    const d = deferred<boolean>();
    h.save = () => d.promise;
    let done = false;
    const p = Promise.resolve(saveTool.run({})).then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    d.resolve(true);
    await p;
    expect(done).toBe(true);
  });

  test("all: saves only dirty tabs", async () => {
    const save = vi.fn(async () => true);
    h.save = save;
    expect(await saveTool.run({ all: true })).toBe("gespeichert");
    expect(save.mock.calls).toEqual([["a"], ["c"]]);
  });

  test("all: a failing tab makes the call fail (named in the error)", async () => {
    h.save = async (id) => id !== "c";
    await expect(saveTool.run({ all: true })).rejects.toThrow("Untitled 1");
  });

  test("all with nothing dirty succeeds without saving", async () => {
    const save = vi.fn(async () => true);
    h.save = save;
    for (const t of h.app.tabs) t.dirty = false;
    expect(await saveTool.run({ all: true })).toBe("gespeichert");
    expect(save).not.toHaveBeenCalled();
  });

  test("mcp-call event: success is replied via mcp_reply", async () => {
    h.save = async () => true;
    await emit("mcp-call", { call: 7, name: "save", args: {} });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual({ call: 7, result: { content: [{ type: "text", text: "gespeichert" }] } });
  });

  test("mcp-call event: a failed save is replied as an error", async () => {
    h.save = async () => false;
    await emit("mcp-call", { call: 8, name: "save", args: {} });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0].call).toBe(8);
    expect(replies[0].result.isError).toBe(true);
    expect(replies[0].result.content[0].text).toContain("/p/a.txt");
  });

  test("mcp-call event: unknown tool is an error", async () => {
    await emit("mcp-call", { call: 9, name: "nope", args: {} });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0].result.isError).toBe(true);
  });
});
