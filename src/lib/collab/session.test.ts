// Code Together session layer (session.svelte.ts): a guest's own workspace is put aside on join
// and restored on leave. App state, editor and the other collab modules are small fakes.
import { beforeEach, expect, test, vi } from "vitest";
import { fakeFs, fakeUi } from "../../test/fakes";

type Msg = Record<string, any>;
const handlers: ((peer: string, msg: Msg) => unknown)[] = [];
const endHooks: ((wasGuest: boolean) => unknown)[] = [];
const collab = { role: "guest" as "host" | "guest" | null, status: "connected", hostPeer: "host-peer", participants: [] as unknown[] };
const broadcast = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./collab.svelte", () => ({
  collab,
  send: vi.fn(),
  broadcast,
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void handlers.push(fn),
  sessionEndHooks: endHooks,
}));
vi.mock("./share.svelte", () => ({
  share: { hostRoot: "", hostHasRoot: true, hostTabs: [], treeGen: 0 },
  // Like the real one: Untitled by id, project files by relative path, anything else hidden.
  hostKeyChecked: async (tab: { id: string; path: string | null }) =>
    !tab.path ? `tab:${tab.id}` : tab.path.startsWith("/home/g/") ? tab.path.slice("/home/g/".length) : null,
  syncSharedTabs: vi.fn(),
  openRemote: vi.fn(),
  isRemote: (p: string | null) => !!p && p.startsWith("collab:"),
}));

type Tab = { id: string; path: string | null; name: string; dirty: boolean };
const texts = new Map<string, string>();
const app = { root: "/home/g" as string | null, tabs: [] as Tab[], activeId: null as string | null, mode: "text" };
let seq = 0;
const addTab = (path: string | null, name: string, text: string, dirty = false) => {
  const id = `t${++seq}`;
  app.tabs.push({ id, path, name, dirty });
  texts.set(id, text);
  app.activeId = id;
  return id;
};
let fs: ReturnType<typeof fakeFs>;
vi.mock("../state.svelte", () => ({
  app,
  activeTab: () => app.tabs.find((t) => t.id === app.activeId) ?? null,
  activate: (id: string) => void (app.activeId = id),
  closeTab: async (id: string) => {
    app.tabs = app.tabs.filter((t) => t.id !== id);
  },
  // The guest's file can't be saved (read-only): autosave leaves dirty tabs dirty.
  flushAutosave: async () => {},
  newFile: () => addTab(null, "Untitled", ""),
  openFile: async (path: string) => {
    if (!app.tabs.some((t) => t.path === path)) addTab(path, path.split("/").pop()!, fs.files.get(path) ?? "");
  },
  setMode: vi.fn(),
  setRoot: (r: string | null) => void (app.root = r),
}));
vi.mock("../code/runner.svelte", () => ({ runner: { project: null }, runAction: vi.fn(), refreshProject: vi.fn(), runnerRemote: { project: null, run: null } }));
vi.mock("../terminal.svelte", () => ({ remoteTerminal: vi.fn(), writeTerminal: vi.fn(), closeTerminal: vi.fn(), terms: { tabs: [] }, isTaskPty: () => false, setRunEcho: vi.fn() }));
vi.mock("../layout.svelte", () => ({ showView: vi.fn() }));
vi.mock("../editor", () => ({
  getText: (id: string) => texts.get(id) ?? "",
  replaceDocText: (id: string, text: string) => void texts.set(id, text),
}));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));

await import("./session.svelte");

async function receive(peer: string, msg: Msg) {
  for (const h of handlers) await h(peer, msg);
}
/** The host's first session announcement (the guest's workspace is put aside asynchronously). */
async function join() {
  await receive("host-peer", { t: "session", root: "proj", mode: "code", tabs: [], active: null, project: null });
  await vi.waitFor(() => expect(localStorage.getItem("collab.guestSnapshot")).not.toBeNull());
  await vi.waitFor(() => expect(app.root).toBeNull());
}

beforeEach(() => {
  fs = fakeFs({ "/home/g/ro.txt": "readonly original\n" });
  Object.assign(app, { root: "/home/g", tabs: [], activeId: null });
  texts.clear();
  collab.role = "guest";
});

test("joining keeps unsaved edits of a file whose autosave failed, leaving brings them back (#129)", async () => {
  addTab("/home/g/ro.txt", "ro.txt", "UNSAVED GUEST WORK readonly original\n", true);
  addTab("/home/g/clean.txt", "clean.txt", "clean\n");
  fs.files.set("/home/g/clean.txt", "clean\n");

  await join();
  expect(app.tabs).toEqual([]);

  for (const h of endHooks) await h(true);
  const ro = app.tabs.find((t) => t.path === "/home/g/ro.txt")!;
  expect(texts.get(ro.id)).toBe("UNSAVED GUEST WORK readonly original\n");
  expect(ro.dirty).toBe(true);
  const clean = app.tabs.find((t) => t.path === "/home/g/clean.txt")!;
  expect(texts.get(clean.id)).toBe("clean\n");
  expect(clean.dirty).toBe(false);
});

test("unsaved edits of a file that is gone after leaving come back in a new tab (#129)", async () => {
  addTab("/home/g/ro.txt", "ro.txt", "my edits\n", true);
  await join();
  fs.files.delete("/home/g/ro.txt");

  for (const h of endHooks) await h(true);
  expect(app.tabs).toHaveLength(1);
  expect(app.tabs[0]).toMatchObject({ path: null, name: "ro.txt", dirty: true });
  expect(texts.get(app.tabs[0].id)).toBe("my edits\n");
});

test("host announces project files and Untitled tabs, not files outside the project", async () => {
  collab.role = "host";
  broadcast.mockClear();
  addTab("/home/g/a.txt", "a.txt", "a\n");
  const untitled = addTab(null, "Untitled", "");
  addTab("/etc/secret.conf", "secret.conf", "secret\n");
  await receive("g1", { t: "hello-ready" });
  await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
  const s = broadcast.mock.calls.at(-1)![0];
  expect(s.tabs).toEqual([
    { key: "a.txt", name: "a.txt" },
    { key: `tab:${untitled}`, name: "Untitled" },
  ]);
  // The outside file is the active tab: neither its name nor a key goes out.
  expect(s.active).toBeNull();
  expect(JSON.stringify(s)).not.toContain("secret");
});
