// Code Together session layer (session.svelte.ts): a guest's own workspace is put aside on join
// and restored on leave. App state, editor and the other collab modules are small fakes.
import { beforeEach, expect, test, vi } from "vitest";
import { fakeFs, fakeUi } from "../../test/fakes";

type Msg = Record<string, any>;
const handlers: ((peer: string, msg: Msg) => unknown)[] = [];
const endHooks: ((wasGuest: boolean) => unknown)[] = [];
const collab = { role: "guest" as "host" | "guest" | null, status: "connected", hostPeer: "host-peer", participants: [] as unknown[] };
const broadcast = vi.fn();
const send = vi.fn(async (_peer: string, _msg: Msg) => {});
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./collab.svelte", () => ({
  collab,
  send,
  broadcast,
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void handlers.push(fn),
  sessionEndHooks: endHooks,
}));
/** The host's shared docs as the run path sees them: what each guest has open, what's unsaved. */
const shared = {
  open: new Map<string, Set<string>>(),
  unsaved: new Set<string>(),
  refused: new Set<string>(),
  arrived: true,
  flush: vi.fn(async () => true),
  clock: null as { client: number; clock: number } | null,
};
vi.mock("./share.svelte", () => ({
  REMOTE: "collab:",
  flushSharedDocs: shared.flush,
  guestDocClock: () => shared.clock,
  guestScope: () => ({
    root: "/home/g",
    live: () => app.root === "/home/g",
    check: async (rel: string) => !shared.refused.has(rel) && !rel.split("/").some((s) => s === ".." || s === ".git"),
    abs: (rel: string) => `/home/g/${rel}`,
  }),
  hostDocHasClock: () => shared.arrived,
  hostDocKeyFor: (rel: string, peer: string) => (shared.open.get(rel)?.has(peer) && !rel.startsWith("tab:") ? rel : null),
  sharedDocUnsaved: (rel: string) => shared.unsaved.has(rel),
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
const opened: [string, boolean | undefined][] = [];
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
  openFile: async (path: string, quiet?: boolean) => {
    opened.push([path, quiet]);
    if (!app.tabs.some((t) => t.path === path)) addTab(path, path.split("/").pop()!, fs.files.get(path) ?? "");
  },
  setMode: vi.fn(),
  setRoot: (r: string | null) => void (app.root = r),
}));
vi.mock("../code/runner.svelte", () => ({
  runner: { project: null },
  refreshProject: vi.fn(),
  runnerRemote: { project: null, run: null },
  fileDependent: (a: { usesFile?: boolean; cmd?: string }) => !!a.usesFile || !!a.cmd?.includes("{file}"),
  projectFor: vi.fn(),
  saveForGuestRun: vi.fn(async () => true),
  runGuestAction: vi.fn(),
}));
const task = { state: { running: false, kind: null, taskId: null, status: null } as Record<string, unknown>, interrupt: vi.fn((_id: number) => true) };
vi.mock("../terminal.svelte", () => ({
  remoteTerminal: vi.fn(() => "remote"),
  writeTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  terms: { tabs: [] },
  isTaskPty: () => false,
  setRunEcho: vi.fn(),
  taskState: () => task.state,
  interruptTask: (id: number) => task.interrupt(id),
  runningPackageTask: (id: number) => (task.state.running && task.state.taskId === id ? !!task.state.packages : null),
  writeTaskInput: vi.fn(async () => "ok"),
}));
vi.mock("../layout.svelte", () => ({ showView: vi.fn() }));
vi.mock("../editor", () => ({
  getText: (id: string) => texts.get(id) ?? "",
  replaceDocText: (id: string, text: string) => void texts.set(id, text),
}));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));

await import("./session.svelte");
// Registered once on load; later tests clear the mock's call list.
const { setRunEcho: registerEcho } = await import("../terminal.svelte");
const runEcho = vi.mocked(registerEcho).mock.calls[0][0]!;
const { runner, runnerRemote, projectFor, saveForGuestRun, runGuestAction } = await import("../code/runner.svelte");
const { guestGuard } = await import("./guard");

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

test("joining keeps a large file with unsaved edits open, out of the snapshot (#174)", async () => {
  addTab("/home/g/mid.log", "mid.log", "UNSAVED LARGE TEXT", true);
  (app.tabs[0] as { large?: boolean }).large = true;
  addTab("/home/g/clean.txt", "clean.txt", "clean\n");
  await join();
  expect(app.tabs.map((t) => t.path)).toEqual(["/home/g/mid.log"]);
  expect(localStorage.getItem("collab.guestSnapshot")).not.toContain("UNSAVED LARGE TEXT");
  expect(texts.get(app.tabs[0].id)).toBe("UNSAVED LARGE TEXT");
  expect(ui.toast).toHaveBeenCalled();
  for (const h of endHooks) await h(true);
  expect(app.tabs.find((t) => t.path === "/home/g/mid.log")?.dirty).toBe(true);
});

test("leaving a session reopens saved tabs quietly, so a large file raises no dialog (#174)", async () => {
  fs.files.set("/home/g/clean.txt", "clean\n");
  addTab("/home/g/clean.txt", "clean.txt", "clean\n");
  await join();
  opened.length = 0;
  for (const h of endHooks) await h(true);
  expect(opened).toEqual([["/home/g/clean.txt", true]]);
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

const RUN = { id: "run", label: "Run", cmd: "cargo run" };
/** The last action the host started for a guest, with the checked package argument if any. */
const expectStarted = (a: unknown, arg?: string) => {
  const call = vi.mocked(runGuestAction).mock.calls.at(-1)!;
  expect(call[0]).toEqual(a);
  expect(call[3].arg).toBe(arg);
};
const replyTo = (peer: string, id: number) => send.mock.calls.map((c) => ({ peer: c[0], msg: c[1] })).find((x) => x.peer === peer && x.msg.t === "rpc.res" && x.msg.id === id)?.msg;

function hostWith(caps: string[]) {
  collab.role = "host";
  collab.participants = [{ peer: "g1", name: "Gast", color: "#333333", role: "guest", caps }];
  (runner as { project: unknown }).project = { kind: "rust", label: "Rust", run: RUN, build: null, test: null, more: [], needs: [], root: "/home/g" };
  send.mockClear();
  vi.mocked(runGuestAction).mockReset();
  vi.mocked(projectFor).mockReset().mockResolvedValue(null);
  vi.mocked(saveForGuestRun).mockReset().mockResolvedValue(true);
  task.interrupt.mockClear();
}

test("host: a guest with `run` starts an action; without it, or with an unknown one, nothing runs", async () => {
  hostWith(["run"]);
  await receive("g1", { t: "rpc.req", id: 1, method: "run.start", params: { action: "run" } });
  expectStarted(RUN);
  expect(replyTo("g1", 1)).toMatchObject({ ok: true });

  vi.mocked(runGuestAction).mockClear();
  await receive("g1", { t: "rpc.req", id: 2, method: "run.start", params: { action: "rm -rf" } });
  expect(replyTo("g1", 2)).toMatchObject({ ok: false, error: { code: "unavailable" } });

  hostWith([]);
  await receive("g1", { t: "rpc.req", id: 3, method: "run.start", params: { action: "run" } });
  expect(replyTo("g1", 3)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: the old unchecked run message does nothing", async () => {
  hostWith([]);
  await receive("g1", { t: "run", action: "run" });
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: Stop needs `run` and names the task it means", async () => {
  hostWith(["run"]);
  await receive("g1", { t: "rpc.req", id: 4, method: "run.stop", params: { taskId: 7 } });
  expect(task.interrupt).toHaveBeenCalledWith(7);
  expect(replyTo("g1", 4)).toMatchObject({ ok: true, result: { stopped: true } });

  hostWith([]);
  await receive("g1", { t: "rpc.req", id: 5, method: "run.stop", params: { taskId: 7 } });
  expect(replyTo("g1", 5)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(task.interrupt).not.toHaveBeenCalled();
});

test("a guest joining mid-run gets the run state, also without `run`", async () => {
  hostWith([]);
  task.state = { running: true, kind: "run", taskId: 9, status: "running" };
  await receive("g1", { t: "rpc.sub", topic: "run.state" });
  expect(send).toHaveBeenCalledWith("g1", { t: "rpc.pub", topic: "run.state", payload: task.state });
  task.state = { running: false, kind: null, taskId: null, status: null };
});

test("guest: pushed run state reaches the Run bar, Stop calls the host, leaving clears it", async () => {
  collab.role = "guest";
  (collab as { myCaps?: string[] }).myCaps = ["run"];
  await join();
  await receive("host-peer", { t: "rpc.pub", topic: "run.state", payload: { running: true, kind: "run", taskId: 12, status: "running" } });
  expect(runner.remoteTask).toMatchObject({ running: true, taskId: 12 });
  send.mockClear();
  runnerRemote.stop!();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("host-peer", expect.objectContaining({ t: "rpc.req", method: "run.stop", params: { taskId: 12 } })));
  const id = send.mock.calls.find((c) => c[1].t === "rpc.req")![1].id;
  await receive("host-peer", { t: "rpc.res", id, ok: true, result: { stopped: true } });
  await receive("host-peer", { t: "rpc.pub", topic: "run.state", payload: { running: false, kind: "run", taskId: 12, status: "stopped" } });
  expect(runner.remoteTask).toMatchObject({ running: false, status: "stopped" });

  for (const h of endHooks) await h(true);
  expect(runner.remoteTask).toBeNull();
  expect(runnerRemote.stop).toBeNull();
});

test("guest: a malformed run state from the host is ignored", async () => {
  collab.role = "guest";
  for (const payload of ["x", 5, [], { running: "yes", kind: "run", taskId: 1, status: "running" }, { running: true, kind: "evil", taskId: 1, status: "running" }, { running: true, kind: "run", taskId: "1", status: "running" }, { running: true, kind: "run", taskId: 1, status: "boom" }]) {
    await receive("host-peer", { t: "rpc.pub", topic: "run.state", payload });
    expect(runner.remoteTask).toBeNull();
  }
});

// ------------------------------------------------------------------ packages

const pkgAct = (id: string, cmd: string, ask = true) => ({ id, label: `${id}…`, cmd, ...(ask ? { ask: "Package" } : {}), suggest: vi.fn(async () => [{ value: "requests", detail: "HTTP", extra: "dropped" }]) });

function hostWithPackages(kind: string, caps: string[], more: ReturnType<typeof pkgAct>[]) {
  hostWith(caps);
  (runner as { project: unknown }).project = { kind, label: kind, run: RUN, build: null, test: null, more, needs: [], root: "/home/g" };
  ui.toast.mockClear();
}
const pkgReq = (id: number, action: string, packages: unknown) => receive("g1", { t: "rpc.req", id, method: "packages.run", params: { action, packages } });

test.each([
  ["uv", "add", "uv add {}", ["requests[socks]", "numpy>=1.26,<3"], "'requests[socks]' 'numpy>=1.26,<3'"],
  ["pnpm", "add", "pnpm add {}", ["@types/node", "zod@^3.0.0"], "@types/node 'zod@^3.0.0'"],
  ["cargo", "add", "cargo add {}", ["serde@>=1,<2"], "'serde@>=1,<2'"],
])("host: %s %s runs with the checked and quoted packages, and says who did it", async (kind, id, cmd, packages, arg) => {
  const a = pkgAct(id, cmd);
  hostWithPackages(kind, ["packages"], [a]);
  await pkgReq(10, id, packages);
  expect(replyTo("g1", 10)).toMatchObject({ ok: true });
  expectStarted(a, arg);
  expect(ui.toast.mock.calls[0][0]).toContain("Gast");
  expect(ui.toast.mock.calls[0][0]).toContain(packages[0]);
});

test.each([
  ["uv", ["--index-url=https://evil.test"]],
  ["uv", ["git+https://evil.test/x.git"]],
  ["uv", ["a;id"]],
  ["uv", ["ok", "$(id)"]],
  ["uv", ["foo @ https://evil.test/x.whl"]],
  ["pnpm", ["--registry=https://evil.test"]],
  ["pnpm", ["user/repo"]],
  ["pnpm", ["zod@file:../x"]],
  ["pnpm", ["evil.tgz"]],
  ["pnpm", ["a`id`"]],
  ["cargo", ["--git=https://evil.test/x"]],
  ["cargo", ["--path=../x"]],
  ["cargo", ["serde;id"]],
  ["cargo", ["a\nid"]],
])("host: %s refuses %j and runs nothing", async (kind, packages) => {
  hostWithPackages(kind, ["packages"], [pkgAct("add", `${kind} add {}`)]);
  await pkgReq(11, "add", packages);
  expect(replyTo("g1", 11)).toMatchObject({ ok: false, error: { code: "invalid_package" } });
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: a package action pauses LaTeX auto-compile for a guest without run, before it starts", async () => {
  const changes = await import("./guestChanges");
  changes.guestChangeHooks.mayRun = (peer) => !!(collab.participants as { peer: string; caps?: string[] }[]).find((p) => p.peer === peer)?.caps?.includes("run");
  const a = pkgAct("add", "uv add {}");
  hostWithPackages("uv", ["packages"], [a]);
  const root = (runner as { project: { root: string } }).project.root;
  const where = (await import("../state.svelte")).app.root ?? root;
  changes.resumeCompiling("t", `${where}/x`);
  let pausedAtStart = false;
  vi.mocked(runGuestAction).mockImplementationOnce(async () => void (pausedAtStart = changes.isPaused(where, null)));
  await pkgReq(70, "add", ["requests"]);
  expect(replyTo("g1", 70)).toMatchObject({ ok: true });
  expect(pausedAtStart).toBe(true);
  changes.resumeCompiling("t", `${where}/x`);

  // Refused packages change nothing, and with `run` there's nothing to pause for.
  await pkgReq(71, "add", ["--registry=https://evil.test"]);
  expect(changes.isPaused(where, null)).toBe(false);
  hostWithPackages("uv", ["packages", "run"], [a]);
  await pkgReq(72, "add", ["requests"]);
  expect(changes.isPaused(where, null)).toBe(false);

  // A package action through run.start counts the same, should it ever run without `run`.
  hostWithPackages("uv", ["packages", "run"], [pkgAct("sync", "uv sync", false)]);
  changes.guestChangeHooks.mayRun = () => false;
  await receive("g1", { t: "rpc.req", id: 73, method: "run.start", params: { action: "sync" } });
  expect(replyTo("g1", 73)).toMatchObject({ ok: true });
  expect(changes.isPaused(where, null)).toBe(true);
  changes.resumeCompiling("t", `${where}/x`);
});

test("host: packages.run needs `packages`, `run` is not enough", async () => {
  hostWithPackages("uv", ["run"], [pkgAct("add", "uv add {}")]);
  await pkgReq(12, "add", ["requests"]);
  expect(replyTo("g1", 12)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(runGuestAction).not.toHaveBeenCalled();
});

test.each([
  ["uv", "sync"],
  ["uv", "lock"],
  ["pnpm", "install"],
  ["cargo", "update"],
])("host: run.start refuses %s %s without `packages`", async (kind, id) => {
  const a = pkgAct(id, `${kind} ${id}`, false);
  hostWithPackages(kind, ["run"], [a]);
  await receive("g1", { t: "rpc.req", id: 13, method: "run.start", params: { action: id } });
  expect(replyTo("g1", 13)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(runGuestAction).not.toHaveBeenCalled();

  hostWithPackages(kind, ["packages"], [a]);
  await pkgReq(14, id, []);
  expect(replyTo("g1", 14)).toMatchObject({ ok: true });
  expectStarted(a);
});

test("host: run.start can't start an action that asks for input, even with `packages`", async () => {
  hostWithPackages("uv", ["run", "packages"], [pkgAct("add", "uv add {}")]);
  await receive("g1", { t: "rpc.req", id: 15, method: "run.start", params: { action: "add" } });
  expect(replyTo("g1", 15)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: packages.run only reaches package actions", async () => {
  hostWithPackages("uv", ["packages"], [pkgAct("fmt", "uvx ruff format", false)]);
  for (const [i, id] of ["fmt", "run", "constructor", "__proto__"].entries()) {
    await pkgReq(20 + i, id, []);
    expect(replyTo("g1", 20 + i)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  }
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: an action without input takes no packages", async () => {
  hostWithPackages("uv", ["packages"], [pkgAct("sync", "uv sync", false)]);
  await pkgReq(25, "sync", ["requests"]);
  expect(replyTo("g1", 25)).toMatchObject({ ok: false, error: { code: "invalid_package" } });
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: malformed package params are refused", async () => {
  hostWithPackages("uv", ["packages"], [pkgAct("add", "uv add {}")]);
  for (const [i, packages] of ["requests", [1], [null], Array(21).fill("a"), ["a".repeat(201)]].entries()) {
    await pkgReq(30 + i, "add", packages);
    expect(replyTo("g1", 30 + i)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  }
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: uv remove finds the group, and refuses a group name that would inject", async () => {
  const a = pkgAct("remove", "uv remove {}");
  hostWithPackages("uv", ["packages"], [a]);
  fs.files.set("/home/g/pyproject.toml", '[project]\nname = "x"\ndependencies = ["requests"]\n\n[dependency-groups]\ndev = ["pytest"]\ndocs = ["mkdocs"]\n"x; touch /tmp/pwned #" = ["evil"]\n');
  await pkgReq(40, "remove", ["pytest"]);
  expectStarted(a, "--dev pytest");
  await pkgReq(41, "remove", ["mkdocs"]);
  expectStarted(a, "--group docs mkdocs");
  await pkgReq(42, "remove", ["requests"]);
  expectStarted(a, "requests");
  vi.mocked(runGuestAction).mockClear();
  await pkgReq(43, "remove", ["evil"]);
  expect(replyTo("g1", 43)).toMatchObject({ ok: false, error: { code: "invalid_group" } });
  expect(runGuestAction).not.toHaveBeenCalled();
});

test("host: guests see package actions, suggestions need `packages`", async () => {
  const a = pkgAct("add", "uv add {}");
  hostWithPackages("uv", ["packages"], [a]);
  broadcast.mockClear();
  await receive("g1", { t: "hello-ready" });
  await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
  expect(broadcast.mock.calls.at(-1)![0].project.more).toEqual([{ id: "add", label: "add…" }]);

  await receive("g1", { t: "rpc.req", id: 50, method: "packages.suggest", params: { action: "add", query: "req" } });
  expect(replyTo("g1", 50)).toMatchObject({ ok: true, result: [{ value: "requests", detail: "HTTP" }] });
  expect(replyTo("g1", 50)!.result[0].extra).toBeUndefined();
  a.suggest.mockClear();
  await receive("g1", { t: "rpc.req", id: 51, method: "packages.suggest", params: { action: "add", query: "a b;id" } });
  expect(replyTo("g1", 51)).toMatchObject({ ok: true, result: [] });
  expect(a.suggest).not.toHaveBeenCalled();

  hostWithPackages("uv", ["run"], [a]);
  await receive("g1", { t: "rpc.req", id: 52, method: "packages.suggest", params: { action: "add", query: "req" } });
  expect(replyTo("g1", 52)).toMatchObject({ ok: false, error: { code: "forbidden" } });
});

async function guestWithPackages(caps: string[], kind = "uv") {
  collab.role = "guest";
  (collab as { myCaps?: string[] }).myCaps = caps;
  guestGuard.can = (cap) => caps.includes(cap); // collab.svelte (mocked here) plugs this in
  await join();
  await receive("host-peer", { t: "session", root: "proj", mode: "code", tabs: [], active: null, project: { kind, label: kind, run: null, build: null, test: null, more: [{ id: "add", label: "Add…" }, { id: "sync", label: "Sync" }] } });
  send.mockClear();
  ui.toast.mockClear();
}
const guestReqs = () => send.mock.calls.map((c) => c[1]).filter((m) => m.t === "rpc.req" && m.method !== "packages.suggest");

test("guest: the prompt is on the guest, the host gets the action and the package list", async () => {
  await guestWithPackages(["packages"]);
  ui.prompt = vi.fn(async () => "requests  numpy>=1.26") as never;
  void runnerRemote.run!({ id: "add", label: "Add…", cmd: "x" });
  await vi.waitFor(() => expect(guestReqs()).toHaveLength(1));
  expect(ui.prompt).toHaveBeenCalled();
  expect(guestReqs()[0]).toMatchObject({ method: "packages.run", params: { action: "add", packages: ["requests", "numpy>=1.26"] } });
  await receive("host-peer", { t: "rpc.res", id: guestReqs()[0].id, ok: true, result: null });
  for (const h of endHooks) await h(true);
});

test("guest: without `packages` there is no prompt and a clear message, `run` doesn't help", async () => {
  await guestWithPackages(["run"]);
  ui.prompt = vi.fn(async () => "requests") as never;
  await runnerRemote.run!({ id: "add", label: "Add…", cmd: "x" });
  await runnerRemote.run!({ id: "sync", label: "Sync", cmd: "x" });
  expect(ui.prompt).not.toHaveBeenCalled();
  expect(guestReqs()).toEqual([]);
  expect(ui.toast).toHaveBeenCalledTimes(2);
  expect(ui.toast.mock.calls[0][1]).toBe("error");
  for (const h of endHooks) await h(true);
});

test("guest: invalid input gets a message and isn't sent", async () => {
  await guestWithPackages(["packages"]);
  ui.prompt = vi.fn(async () => "--index-url=https://evil.test") as never;
  await runnerRemote.run!({ id: "add", label: "Add…", cmd: "x" });
  expect(guestReqs()).toEqual([]);
  expect(ui.toast.mock.calls[0][1]).toBe("error");
  for (const h of endHooks) await h(true);
});

// ------------------------------------------------------------------ Stop with `packages`

const IDLE = { running: false, kind: null, taskId: null, status: null };
const stopReq = (id: number, taskId: number) => receive("g1", { t: "rpc.req", id, method: "run.stop", params: { taskId } });

test("host: `packages` stops a package task", async () => {
  hostWith(["packages"]);
  task.state = { running: true, kind: "run", taskId: 30, status: "running", packages: true };
  await stopReq(60, 30);
  expect(task.interrupt).toHaveBeenCalledWith(30);
  expect(replyTo("g1", 60)).toMatchObject({ ok: true, result: { stopped: true } });
  task.state = IDLE;
});

test("host: `packages` can't stop a run that isn't a package task", async () => {
  hostWith(["packages"]);
  task.state = { running: true, kind: "run", taskId: 31, status: "running" };
  await stopReq(61, 31);
  expect(replyTo("g1", 61)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(task.interrupt).not.toHaveBeenCalled();
  task.state = IDLE;
});

test("host: a late Stop with `packages` doesn't reach the newer run", async () => {
  hostWith(["packages"]);
  task.interrupt.mockImplementationOnce(() => false);
  task.state = { running: true, kind: "run", taskId: 33, status: "running" };
  await stopReq(62, 32); // the package task 32 is over, 33 is the host's own run
  expect(task.interrupt).toHaveBeenCalledWith(32);
  expect(task.interrupt).not.toHaveBeenCalledWith(33);
  expect(replyTo("g1", 62)).toMatchObject({ ok: true, result: { stopped: false } });
  task.state = IDLE;
});

test("host: `run` still stops any task, no right stops none", async () => {
  hostWith(["run"]);
  task.state = { running: true, kind: "run", taskId: 34, status: "running", packages: true };
  await stopReq(63, 34);
  expect(task.interrupt).toHaveBeenCalledWith(34);
  hostWith(["edit"]);
  await stopReq(64, 34);
  expect(replyTo("g1", 64)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(task.interrupt).not.toHaveBeenCalled();
  task.state = IDLE;
});

test("guest: with `packages` only, Stop calls the host for a package task and not for another", async () => {
  await guestWithPackages(["packages"]);
  await receive("host-peer", { t: "rpc.pub", topic: "run.state", payload: { running: true, kind: "run", taskId: 35, status: "running", packages: true } });
  send.mockClear();
  runnerRemote.stop!();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("host-peer", expect.objectContaining({ method: "run.stop", params: { taskId: 35 } })));
  await receive("host-peer", { t: "rpc.res", id: send.mock.calls.find((c) => c[1].t === "rpc.req")![1].id, ok: true, result: { stopped: true } });

  await receive("host-peer", { t: "rpc.pub", topic: "run.state", payload: { running: true, kind: "run", taskId: 36, status: "running" } });
  send.mockClear();
  ui.toast.mockClear();
  await runnerRemote.stop!();
  expect(send).not.toHaveBeenCalled();
  expect(ui.toast.mock.calls[0][1]).toBe("error");
  for (const h of endHooks) await h(true);
});

test("host: what the Run terminal mirrors to guests passes the debugger's filter, in order", async () => {
  const { termOut } = await import("./debugMirror");
  const enc = (x: string) => btoa(x);
  const dec = (x: string) => atob(x);
  collab.role = "host";
  collab.participants = [{ peer: "self", role: "host" }, { peer: "g1", role: "guest" }];
  broadcast.mockClear();
  termOut.filter = (b64, later) => {
    later(enc("held "));
    return enc(dec(b64).replace("/home/alice/proj/", ""));
  };
  try {
    runEcho("$ python /home/alice/proj/main.py");
    await new Promise((r) => setTimeout(r, 45));
  } finally {
    termOut.filter = null;
  }
  const sent = broadcast.mock.calls.map((c) => c[0] as Msg).filter((m) => m.t === "term.data");
  expect(sent.flatMap((m) => m.chunks as string[]).map(dec).join("")).toBe("held $ python main.py");
});

test("host: while guests are slow, Run output waits in a bounded queue and one message goes at a time (#154)", async () => {
  const { termOut } = await import("./debugMirror");
  const { TERM_LIMITS } = await import("./guestInput");
  collab.role = "host";
  collab.participants = [{ peer: "self", role: "host" }, { peer: "g1", role: "guest" }];
  broadcast.mockClear();
  const release: (() => void)[] = [];
  broadcast.mockImplementation((m: Msg) => (m.t === "term.data" ? new Promise<void>((r) => release.push(r)) : undefined));
  termOut.filter = (b64) => b64;
  const sent = () => broadcast.mock.calls.map((c) => c[0] as Msg).filter((m) => m.t === "term.data");
  try {
    runEcho("first\n");
    await vi.waitFor(() => expect(sent().length).toBe(1));
    const line = `${"x".repeat(1000)}\n`;
    for (let i = 0; i < 3000; i++) runEcho(line);
    await new Promise((r) => setTimeout(r, 45));
    expect(sent().length).toBe(1); // the first is still being written
    for (let i = 0; i < 40 && release.length; i++) {
      release.shift()!();
      await new Promise((r) => setTimeout(r));
    }
    await vi.waitFor(() => expect(release.length).toBe(0));
    const rest = sent().slice(1);
    expect(rest.filter((m) => m.skipped).length).toBe(1);
    const size = rest.flatMap((m) => m.chunks as string[]).reduce((n, c) => n + c.length, 0);
    expect(size).toBeLessThanOrEqual(TERM_LIMITS.maxBufferedOutput);
  } finally {
    termOut.filter = null;
    broadcast.mockReset();
  }
});

test("guest: skipped Run output shows one marker before what follows (#154)", async () => {
  const { writeTerminal } = await import("../terminal.svelte");
  const { t } = await import("../i18n/index.svelte");
  collab.role = "guest";
  vi.mocked(writeTerminal).mockClear();
  for (const h of handlers) await h("host-peer", { t: "term.data", skipped: true, chunks: [btoa("after")] });
  const writes = vi.mocked(writeTerminal).mock.calls.map((c) => c[1] as string);
  expect(writes.filter((w) => w.includes(t("ai.collab.shell.skipped"))).length).toBe(1);
  expect(writes[0].startsWith("\x18\x1b[0m")).toBe(true); // ends a sequence the gap left open
  expect(writes.at(-1)).toBe("after");
});

// ------------------------------------------------------------------ Run acts on the guest's file

const fileRun = (file: string | null) => ({ id: "run", label: "Run", cmd: `uv run ${file}`, usesFile: true });
const uvProject = (file: string | null) => ({ kind: "uv", label: "uv", run: file ? fileRun(file) : null, build: { id: "build", label: "Build", cmd: "uv build" }, test: null, more: [], needs: [], root: "/home/g" });

/** The host has long.py active; g1 has `open` open as shared docs. */
function hostOnLongPy(...open: string[]) {
  hostWith(["run", "edit"]);
  (runner as { project: unknown }).project = uvProject("long.py");
  addTab("/home/g/long.py", "long.py", "long\n");
  shared.open = new Map(open.map((rel) => [rel, new Set(["g1"])]));
  shared.unsaved.clear();
  shared.refused.clear();
  shared.arrived = true;
  shared.flush.mockClear();
  ui.toast.mockClear();
  vi.mocked(projectFor).mockReset().mockImplementation(async (file) => uvProject(file && file.slice("/home/g/".length)) as never);
  vi.mocked(saveForGuestRun).mockReset().mockResolvedValue(true);
  vi.mocked(runGuestAction).mockReset();
}
const runReq = (id: number, params: Msg) => receive("g1", { t: "rpc.req", id, method: "run.start", params: { action: "run", ...params } });
const answered = (id: number) => vi.waitFor(() => { const r = replyTo("g1", id); expect(r).toBeDefined(); return r!; });
const nothingRan = () => expect(runGuestAction).not.toHaveBeenCalled();

test("host: Run acts on the guest's file, not the host's, and the host's tab stays active", async () => {
  hostOnLongPy("app.py");
  const active = app.activeId;
  await runReq(100, { file: "app.py" });
  expect(await answered(100)).toMatchObject({ ok: true });
  expect(projectFor).toHaveBeenCalledWith("/home/g/app.py", "/home/g");
  const [a, , file] = vi.mocked(runGuestAction).mock.calls[0];
  expect(a.cmd).toBe("uv run app.py");
  expect(file).toBe("/home/g/app.py");
  expect(app.activeId).toBe(active);
  expect((runner as unknown as { project: { run: { cmd: string } } }).project.run.cmd).toBe("uv run long.py");
});

test("host: Build for a guest's file comes from that file's project", async () => {
  hostOnLongPy("sub/app.py");
  await receive("g1", { t: "rpc.req", id: 101, method: "run.start", params: { action: "build", file: "sub/app.py" } });
  expect(await answered(101)).toMatchObject({ ok: true });
  expect(vi.mocked(runGuestAction).mock.calls[0][0].id).toBe("build");
  expect(vi.mocked(runGuestAction).mock.calls[0][2]).toBe("/home/g/sub/app.py");
});

test.each([
  ["../secret.py"],
  ["a/../../secret.py"],
  [".git/hooks/pre-commit"],
  ["sub/.git/config"],
  ["/etc/passwd"],
  ["not-open.py"],
  ["tab:t1"],
])("host: the path %s is refused and nothing falls back to the host's file", async (file) => {
  hostOnLongPy("app.py");
  if (file.includes("..") || file.includes(".git")) shared.open.set(file, new Set(["g1"]));
  await runReq(102, { file });
  expect(await answered(102)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });
  nothingRan();
  expect(saveForGuestRun).not.toHaveBeenCalled();
});

test("host: a file another guest has open, or a symlink out of the project, is refused", async () => {
  hostOnLongPy();
  shared.open.set("other.py", new Set(["g2"]));
  await runReq(103, { file: "other.py" });
  expect(await answered(103)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });

  hostOnLongPy("link.py");
  shared.refused.add("link.py");
  await runReq(104, { file: "link.py" });
  expect(await answered(104)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });
  nothingRan();
});

test.each([["a\nrm -rf x.py"], ["a\u0003.py"], ["a\x7f.py"], ["a\u009b.py"]])("host: the name %j can't go into a command", async (file) => {
  hostOnLongPy(file);
  await runReq(105, { file });
  expect(await answered(105)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });
  nothingRan();
});

test("host: a name that is odd but quotable runs", async () => {
  const file = "it's $(id) `x` ; & a.py";
  hostOnLongPy(file);
  await runReq(106, { file });
  expect(await answered(106)).toMatchObject({ ok: true });
  expect(vi.mocked(runGuestAction).mock.calls[0][2]).toBe(`/home/g/${file}`);
});

test.each([[{ file: 5 }], [{ file: "app.py", client: 1 }], [{ file: "app.py", client: "1", clock: 2 }], [{ file: "x".repeat(4097) }]])("host: malformed run params %j do nothing", async (params) => {
  hostOnLongPy("app.py");
  await runReq(107, params);
  expect(await answered(107)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  nothingRan();
});

test("host: the shared text is on disk before the project is detected from the file", async () => {
  hostOnLongPy("app.py");
  const order: string[] = [];
  vi.mocked(saveForGuestRun).mockImplementation(async () => (order.push("tabs"), true));
  shared.flush.mockImplementationOnce(async () => (order.push("docs"), true));
  vi.mocked(projectFor).mockImplementation(async (file) => (order.push("detect"), uvProject(file!.slice("/home/g/".length)) as never));
  await runReq(108, { file: "app.py" });
  expect(await answered(108)).toMatchObject({ ok: true });
  expect(saveForGuestRun).toHaveBeenCalledWith("/home/g/app.py");
  expect(order).toEqual(["tabs", "docs", "detect"]);
});

test("host: text that couldn't be saved doesn't run an old copy", async () => {
  hostOnLongPy("app.py");
  shared.unsaved.add("app.py");
  await runReq(109, { file: "app.py" });
  expect(await answered(109)).toMatchObject({ ok: false, error: { code: "run_not_saved" } });

  hostOnLongPy("app.py");
  vi.mocked(saveForGuestRun).mockResolvedValue(false);
  await runReq(110, { file: "app.py" });
  expect(await answered(110)).toMatchObject({ ok: false, error: { code: "run_not_saved" } });
  nothingRan();
});

test("host: Run waits for the guest's last edit, and doesn't run without it", async () => {
  hostOnLongPy("app.py");
  shared.arrived = false;
  const run = runReq(111, { file: "app.py", client: 7, clock: 3 });
  await new Promise((r) => setTimeout(r, 60));
  expect(saveForGuestRun).not.toHaveBeenCalled();
  shared.arrived = true;
  await run;
  expect(await answered(111)).toMatchObject({ ok: true });
  expect(runGuestAction).toHaveBeenCalled();

  hostOnLongPy("app.py");
  shared.arrived = false;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  const late = runReq(112, { file: "app.py", client: 7, clock: 3 });
  await vi.advanceTimersByTimeAsync(2100);
  vi.useRealTimers();
  await late;
  expect(await answered(112)).toMatchObject({ ok: false, error: { code: "run_not_saved" } });
  nothingRan();
});

test("host: without a guest file, a file-bound Run never uses the host's active file", async () => {
  hostOnLongPy();
  (runner as { project: { run: unknown } }).project.run = fileRun("long.py");
  vi.mocked(projectFor).mockResolvedValue({ ...uvProject(null), run: { id: "run", label: "Run", cmd: "uv run main.py", usesFile: true } } as never);
  await runReq(113, {});
  expect(await answered(113)).toMatchObject({ ok: true });
  expect(projectFor).toHaveBeenCalledWith(null, "/home/g");
  expect(vi.mocked(runGuestAction).mock.calls[0][0].cmd).toBe("uv run main.py");
  expect(vi.mocked(runGuestAction).mock.calls[0][2]).toBeNull();

  hostOnLongPy();
  vi.mocked(projectFor).mockResolvedValue(uvProject(null) as never);
  await runReq(114, {});
  expect(await answered(114)).toMatchObject({ ok: false, error: { code: "run_needs_file" } });
  nothingRan();

  hostOnLongPy();
  (runner as { project: { run: unknown } }).project.run = { id: "run", label: "Run", cmd: "python {file}" };
  vi.mocked(projectFor).mockResolvedValue({ ...uvProject(null), run: { id: "run", label: "Run", cmd: "python {file}" } } as never);
  await runReq(115, {});
  expect(await answered(115)).toMatchObject({ ok: false, error: { code: "run_needs_file" } });
  nothingRan();
});

test("host: an action that doesn't follow a file runs as before without a guest file", async () => {
  hostOnLongPy();
  await receive("g1", { t: "rpc.req", id: 116, method: "run.start", params: { action: "build" } });
  expect(await answered(116)).toMatchObject({ ok: true });
  expect(runGuestAction).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runGuestAction).mock.calls[0][0].cmd).toBe("uv build");
  expect(vi.mocked(runGuestAction).mock.calls[0][2]).toBeNull();
  expect(projectFor).toHaveBeenCalledWith(null, "/home/g");
});

test("host: the package check uses the project of the guest's file", async () => {
  hostOnLongPy("sub/x.py");
  vi.mocked(projectFor).mockResolvedValue({ ...uvProject("sub/x.py"), more: [{ id: "sync", label: "sync", cmd: "uv sync" }] } as never);
  await receive("g1", { t: "rpc.req", id: 117, method: "run.start", params: { action: "sync", file: "sub/x.py" } });
  expect(await answered(117)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  nothingRan();
});

test("host: an action the guest's file doesn't have is refused", async () => {
  hostOnLongPy("notes.md");
  vi.mocked(projectFor).mockResolvedValue(null as never);
  await runReq(118, { file: "notes.md" });
  expect(await answered(118)).toMatchObject({ ok: false, error: { code: "run_no_action" } });
  nothingRan();
});

test("guest: Run sends its active shared file with its edit clock; an Untitled tab sends none", async () => {
  collab.role = "guest";
  guestGuard.can = () => true;
  await join();
  const run = runnerRemote.run!;
  shared.clock = { client: 9, clock: 4 };
  addTab("collab:src/app.py", "app.py", "x\n");
  send.mockClear();
  run({ id: "run", label: "Run" });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("host-peer", expect.objectContaining({ t: "rpc.req", method: "run.start", params: { action: "run", file: "src/app.py", client: 9, clock: 4 } })));

  addTab("collab:tab:t9", "Untitled", "");
  send.mockClear();
  run({ id: "run", label: "Run" });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("host-peer", expect.objectContaining({ t: "rpc.req", method: "run.start", params: { action: "run" } })));
  shared.clock = null;
  for (const h of endHooks) await h(true);
});

test.each([
  ["run_path_refused", "isn't shared"],
  ["run_needs_file", "Open a shared file"],
  ["run_not_saved", "couldn't save"],
  ["run_no_action", "isn't available"],
])("guest: the refusal %s is explained", async (code, text) => {
  collab.role = "guest";
  guestGuard.can = () => true;
  await join();
  addTab("collab:app.py", "app.py", "x\n");
  send.mockClear();
  ui.toast.mockClear();
  runnerRemote.run!({ id: "run", label: "Run" });
  await vi.waitFor(() => expect(send.mock.calls.some((c) => c[1].method === "run.start")).toBe(true));
  const id = send.mock.calls.find((c) => c[1].method === "run.start")![1].id;
  await receive("host-peer", { t: "rpc.res", id, ok: false, error: { code } });
  await vi.waitFor(() => expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining(text), "error"));
  for (const h of endHooks) await h(true);
});

// ------------------------------------------------------------------ between the click and the start

const rpc = await import("./rpc.svelte");
const participants = () => collab.participants as { peer: string; name: string; caps: string[] }[];
/** The check the host makes right before it starts the run it was asked for. */
const lastAllowed = () => vi.mocked(runGuestAction).mock.calls.at(-1)![3].allowed;

test("host: a tab switch while saving can't turn a project action into a run of the host's file", async () => {
  hostOnLongPy();
  (runner as { project: { run: unknown } }).project.run = { id: "run", label: "Run", cmd: "pnpm run dev" };
  vi.mocked(saveForGuestRun).mockImplementation(async () => {
    (runner as { project: { run: unknown } }).project.run = fileRun("host-switched-to.py");
    return true;
  });
  vi.mocked(projectFor).mockResolvedValue({ ...uvProject(null), run: { id: "run", label: "Run", cmd: "pnpm run dev" } } as never);
  await runReq(200, {});
  expect(await answered(200)).toMatchObject({ ok: true });
  expect(vi.mocked(runGuestAction).mock.calls[0][0].cmd).toBe("pnpm run dev");
  expect(projectFor).toHaveBeenCalledWith(null, "/home/g");
});

test("host: the `packages` check is about what actually launches", async () => {
  hostOnLongPy();
  (runner as { project: { kind: string; more: unknown[] } }).project.kind = "cmake";
  (runner as { project: { kind: string; more: unknown[] } }).project.more = [{ id: "sync", label: "sync", cmd: "echo harmless" }];
  vi.mocked(projectFor).mockResolvedValue({ ...uvProject(null), more: [{ id: "sync", label: "sync", cmd: "uv sync" }] } as never);
  await receive("g1", { t: "rpc.req", id: 201, method: "run.start", params: { action: "sync" } });
  expect(await answered(201)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  nothingRan();
});

test("host: losing `run` during the wait for the last edit stops the run", async () => {
  hostOnLongPy("app.py");
  shared.arrived = false;
  const run = runReq(202, { file: "app.py", client: 7, clock: 3 });
  await new Promise((r) => setTimeout(r, 40));
  rpc.setCapability("g1", "run", false);
  await run;
  expect(await answered(202)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(saveForGuestRun).not.toHaveBeenCalled();
  nothingRan();
});

test("host: leaving during the wait for the last edit stops the run, without an answer", async () => {
  hostOnLongPy("app.py");
  shared.arrived = false;
  const run = runReq(203, { file: "app.py", client: 7, clock: 3 });
  await new Promise((r) => setTimeout(r, 40));
  collab.participants = [];
  rpc.forgetRpcPeer("g1");
  await run;
  expect(replyTo("g1", 203)).toBeUndefined();
  expect(saveForGuestRun).not.toHaveBeenCalled();
  nothingRan();
});

test("host: another folder opened while resolving refuses the run", async () => {
  hostOnLongPy("app.py");
  vi.mocked(saveForGuestRun).mockImplementation(async () => {
    app.root = "/other";
    return true;
  });
  await runReq(204, { file: "app.py" });
  expect(await answered(204)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });
  expect(projectFor).not.toHaveBeenCalled();
  nothingRan();

  hostOnLongPy("app.py");
  app.root = "/home/g";
  vi.mocked(projectFor).mockImplementation(async () => {
    app.root = "/other";
    return uvProject("app.py") as never;
  });
  await runReq(205, { file: "app.py" });
  expect(await answered(205)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });
  nothingRan();
  app.root = "/home/g";
});

test("host: concurrent starts from two guests each run their own file", async () => {
  hostOnLongPy("a.py", "b.py");
  collab.participants = [...collab.participants, { peer: "g2", name: "Zwei", color: "#444444", role: "guest", caps: ["run", "edit"] }];
  shared.open.get("b.py")!.add("g2");
  shared.open.get("b.py")!.delete("g1");
  shared.open.get("a.py")!.delete("g2");
  const slow = new Map<string, () => void>();
  vi.mocked(projectFor).mockImplementation(async (file) => {
    await new Promise<void>((r) => slow.set(file!, r));
    return uvProject(file!.slice("/home/g/".length)) as never;
  });
  const one = receive("g1", { t: "rpc.req", id: 206, method: "run.start", params: { action: "run", file: "a.py" } });
  const two = receive("g2", { t: "rpc.req", id: 207, method: "run.start", params: { action: "run", file: "b.py" } });
  await vi.waitFor(() => expect(slow.size).toBe(2));
  slow.get("/home/g/b.py")!();
  slow.get("/home/g/a.py")!();
  await Promise.all([one, two]);
  const started = vi.mocked(runGuestAction).mock.calls.map((c) => [c[0].cmd, c[2]]);
  expect(started).toHaveLength(2);
  expect(started).toEqual(expect.arrayContaining([["uv run a.py", "/home/g/a.py"], ["uv run b.py", "/home/g/b.py"]]));
});

test("host: right before the start the guest, its rights, folder, file and text are checked again", async () => {
  const startedRun = async (id: number) => {
    hostOnLongPy("app.py");
    await runReq(id, { file: "app.py" });
    expect(await answered(id)).toMatchObject({ ok: true });
    ui.toast.mockClear();
    return lastAllowed();
  };
  expect(await (await startedRun(210))()).toBe(true);
  expect(ui.toast).not.toHaveBeenCalled();

  let allowed = await startedRun(211);
  rpc.setCapability("g1", "run", false);
  expect(await allowed()).toBe(false);
  expect(ui.toast).toHaveBeenCalledWith(expect.stringContaining("Gast"));

  // Left and came back under the same peer id: this run is not the new connection's.
  allowed = await startedRun(212);
  collab.participants = participants().map((p) => ({ ...p }));
  expect(await allowed()).toBe(false);

  allowed = await startedRun(213);
  shared.refused.add("app.py");
  expect(await allowed()).toBe(false);

  allowed = await startedRun(214);
  shared.open.clear();
  expect(await allowed()).toBe(false);

  allowed = await startedRun(215);
  shared.unsaved.add("app.py");
  expect(await allowed()).toBe(false);

  allowed = await startedRun(216);
  app.root = "/other";
  expect(await allowed()).toBe(false);
  app.root = "/home/g";
});

// ------------------------------------------------------------------ the guest's Run bar

const projReq = (id: number, params: unknown) => receive("g1", { t: "rpc.req", id, method: "run.project", params });

test("host: run.project answers for the guest's file with ids and labels only", async () => {
  hostOnLongPy("app.py");
  vi.mocked(projectFor).mockResolvedValue({ ...uvProject("app.py"), more: [{ id: "add", label: "Add…", cmd: "uv add {}", ask: "x" }, { id: "secret", label: "Ask", cmd: "x {}", ask: "y" }] } as never);
  await projReq(220, { file: "app.py" });
  const r = await answered(220);
  expect(projectFor).toHaveBeenCalledWith("/home/g/app.py", "/home/g");
  expect(r.result).toEqual({ kind: "uv", label: "uv", run: { id: "run", label: "Run" }, build: { id: "build", label: "Build" }, test: null, more: [{ id: "add", label: "Add…" }] });
  expect(JSON.stringify(r.result)).not.toContain("/home/g");
  expect(JSON.stringify(r.result)).not.toContain("uv run");
  expect(saveForGuestRun).not.toHaveBeenCalled();
  nothingRan();

  vi.mocked(projectFor).mockResolvedValue(null);
  await projReq(221, { file: "app.py" });
  expect(await answered(221)).toMatchObject({ ok: true, result: null });
});

test.each([["../x.py"], [".git/config"], ["not-open.py"], ["tab:t1"], ["a\nb.py"]])("host: run.project refuses %j", async (file) => {
  hostOnLongPy("app.py");
  if (file.includes("..") || file.includes(".git") || file.includes("\n")) shared.open.set(file, new Set(["g1"]));
  await projReq(222, { file });
  expect(await answered(222)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });
  expect(projectFor).not.toHaveBeenCalled();
});

test.each([[{}], [{ file: 5 }], [{ file: "x".repeat(4097) }], ["app.py"]])("host: run.project rejects malformed params %j", async (params) => {
  hostOnLongPy("app.py");
  await projReq(223, params);
  expect(await answered(223)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
});

const projectReqs = () => send.mock.calls.map((c) => c[1]).filter((m) => m.t === "rpc.req" && m.method === "run.project");
const guestProjectNow = () => runnerRemote.project!();
const INFO = (label: string, run = true) => ({ kind: "uv", label, run: run ? { id: "run", label: "Run" } : null, build: null, test: null, more: [] });

async function guestOnHostWithoutRun() {
  collab.role = "guest";
  guestGuard.can = () => true;
  await join();
  await receive("host-peer", { t: "session", root: "proj", mode: "code", tabs: [], active: null, project: INFO("host", false) });
  send.mockClear();
}
const answerProject = async (req: Msg, result: unknown) => receive("host-peer", { t: "rpc.res", id: req.id, ok: true, result });
const refreshed = async (count: number) => {
  (runnerRemote as unknown as { refresh: () => void }).refresh();
  await vi.waitFor(() => expect(projectReqs().length).toBe(count));
  return projectReqs().at(-1)!;
};

test("guest: a runnable file gets its Run button although the host's active file has none", async () => {
  await guestOnHostWithoutRun();
  expect(guestProjectNow()?.run).toBeNull();
  addTab("collab:app.py", "app.py", "x\n");
  const req = await refreshed(1);
  expect(req.params).toEqual({ file: "app.py" });
  await answerProject(req, INFO("for app.py"));
  await vi.waitFor(() => expect((runner as unknown as { project: { label: string } }).project.label).toBe("for app.py"));
  expect(guestProjectNow()?.run?.id).toBe("run");
  for (const h of endHooks) await h(true);
});

test("guest: answers are cached per file and refreshed on a tab change; a late answer can't land on another file", async () => {
  await guestOnHostWithoutRun();
  const a = addTab("collab:a.py", "a.py", "");
  await answerProject(await refreshed(1), INFO("a"));
  await vi.waitFor(() => expect(guestProjectNow()?.label).toBe("a"));

  addTab("collab:b.py", "b.py", "");
  const slow = await refreshed(2);
  app.activeId = a;
  expect(guestProjectNow()?.label).toBe("a"); // from the cache, at once
  const again = await refreshed(3);
  expect(again.params).toEqual({ file: "a.py" });
  await answerProject(slow, INFO("b, too late"));
  expect(guestProjectNow()?.label).toBe("a");
  await answerProject(again, INFO("a, updated"));
  await vi.waitFor(() => expect(guestProjectNow()?.label).toBe("a, updated"));
  for (const h of endHooks) await h(true);
});

test("guest: a file without actions hides them, a malformed answer changes nothing, leaving forgets it", async () => {
  await guestOnHostWithoutRun();
  addTab("collab:notes.md", "notes.md", "");
  await answerProject(await refreshed(1), { kind: "uv", label: "bad", run: "rm -rf", build: null, test: null, more: [] });
  await new Promise((r) => setTimeout(r, 10));
  expect(guestProjectNow()?.label).toBe("host");
  await answerProject(await refreshed(2), null);
  await vi.waitFor(() => expect(guestProjectNow()).toBeNull());
  for (const h of endHooks) await h(true);

  await guestOnHostWithoutRun();
  addTab("collab:notes.md", "notes.md", "");
  expect(guestProjectNow()?.label).toBe("host");
  for (const h of endHooks) await h(true);
});

// ------------------------------------------------------------------ packages for the guest's file

const subProject = (more: unknown[]) => ({ ...uvProject("sub/x.py"), root: "/home/g/sub", more });

test("host: a package action goes to the project of the guest's file, with its checks", async () => {
  hostOnLongPy("sub/x.py");
  participants()[0].caps = ["packages"];
  const hostAdd = pkgAct("add", "pnpm add {}");
  (runner as { project: { kind: string; more: unknown[] } }).project.kind = "pnpm";
  (runner as { project: { kind: string; more: unknown[] } }).project.more = [hostAdd];
  const add = pkgAct("add", "uv add {}");
  vi.mocked(projectFor).mockResolvedValue(subProject([add]) as never);
  const changes = await import("./guestChanges");
  changes.guestChangeHooks.mayRun = () => false;
  changes.resumeCompiling("t", "/home/g/x");

  await receive("g1", { t: "rpc.req", id: 230, method: "packages.run", params: { action: "add", packages: ["requests"], file: "sub/x.py" } });
  expect(await answered(230)).toMatchObject({ ok: true });
  expect(projectFor).toHaveBeenCalledWith("/home/g/sub/x.py", "/home/g");
  const call = vi.mocked(runGuestAction).mock.calls[0];
  expect(call[0]).toBe(add);
  expect(call[1].root).toBe("/home/g/sub");
  expect(call[3].arg).toBe("requests");
  expect(changes.isPaused("/home/g", null)).toBe(true); // noted before the task can change files
  changes.resumeCompiling("t", "/home/g/x");
  expect(await call[3].allowed()).toBe(true);
  participants()[0].caps = [];
  expect(await call[3].allowed()).toBe(false);
  participants()[0].caps = ["packages"];

  // The input is checked for the subproject's tool (a pnpm spec isn't a uv one).
  vi.mocked(runGuestAction).mockClear();
  await receive("g1", { t: "rpc.req", id: 231, method: "packages.run", params: { action: "add", packages: ["--index-url=https://evil.test"], file: "sub/x.py" } });
  expect(await answered(231)).toMatchObject({ ok: false, error: { code: "invalid_package" } });
  nothingRan();
});

test.each([["../x.py"], [".git/config"], ["not-open.py"]])("host: packages.run refuses the file %s without using the host's project", async (file) => {
  hostOnLongPy("sub/x.py");
  participants()[0].caps = ["packages"];
  (runner as { project: { more: unknown[] } }).project.more = [pkgAct("add", "uv add {}")];
  if (file !== "not-open.py") shared.open.set(file, new Set(["g1"]));
  await receive("g1", { t: "rpc.req", id: 232, method: "packages.run", params: { action: "add", packages: ["requests"], file } });
  expect(await answered(232)).toMatchObject({ ok: false, error: { code: "run_path_refused" } });
  nothingRan();
});

test("host: a subproject without that package action is refused; suggestions come from the file's project", async () => {
  hostOnLongPy("sub/x.py");
  participants()[0].caps = ["packages"];
  (runner as { project: { more: unknown[] } }).project.more = [pkgAct("add", "uv add {}")];
  vi.mocked(projectFor).mockResolvedValue(subProject([]) as never);
  await receive("g1", { t: "rpc.req", id: 233, method: "packages.run", params: { action: "add", packages: ["requests"], file: "sub/x.py" } });
  expect(await answered(233)).toMatchObject({ ok: false, error: { code: "run_no_action" } });
  nothingRan();

  const add = pkgAct("add", "uv add {}");
  vi.mocked(projectFor).mockResolvedValue(subProject([add]) as never);
  await receive("g1", { t: "rpc.req", id: 234, method: "packages.suggest", params: { action: "add", query: "req", file: "sub/x.py" } });
  expect(await answered(234)).toMatchObject({ ok: true, result: [{ value: "requests" }] });
  expect(add.suggest).toHaveBeenCalledWith("req");
});

test("guest: a package action names the file from when it was clicked, also after a tab switch in the prompt", async () => {
  await guestWithPackages(["packages"]);
  addTab("collab:sub/x.py", "x.py", "");
  ui.prompt = vi.fn(async () => {
    addTab("collab:other.py", "other.py", "");
    return "requests";
  }) as never;
  void runnerRemote.run!({ id: "add", label: "Add…", cmd: "x" });
  await vi.waitFor(() => expect(guestReqs().filter((r) => r.method === "packages.run")).toHaveLength(1));
  const req = guestReqs().find((r) => r.method === "packages.run")!;
  expect(req.params).toEqual({ action: "add", packages: ["requests"], file: "sub/x.py" });
  await receive("host-peer", { t: "rpc.res", id: req.id, ok: true, result: null });
  for (const h of endHooks) await h(true);
});
