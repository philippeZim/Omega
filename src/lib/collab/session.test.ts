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
}));
vi.mock("../layout.svelte", () => ({ showView: vi.fn() }));
vi.mock("../editor", () => ({
  getText: (id: string) => texts.get(id) ?? "",
  replaceDocText: (id: string, text: string) => void texts.set(id, text),
}));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));

await import("./session.svelte");
const { runner, runAction, runnerRemote } = await import("../code/runner.svelte");
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
const replyTo = (peer: string, id: number) => send.mock.calls.map((c) => ({ peer: c[0], msg: c[1] })).find((x) => x.peer === peer && x.msg.t === "rpc.res" && x.msg.id === id)?.msg;

function hostWith(caps: string[]) {
  collab.role = "host";
  collab.participants = [{ peer: "g1", name: "Gast", color: "#333333", role: "guest", caps }];
  (runner as { project: unknown }).project = { kind: "rust", label: "Rust", run: RUN, build: null, test: null, more: [], needs: [], root: "/home/g" };
  send.mockClear();
  vi.mocked(runAction).mockClear();
  task.interrupt.mockClear();
}

test("host: a guest with `run` starts an action; without it, or with an unknown one, nothing runs", async () => {
  hostWith(["run"]);
  await receive("g1", { t: "rpc.req", id: 1, method: "run.start", params: { action: "run" } });
  expect(runAction).toHaveBeenCalledWith(RUN);
  expect(replyTo("g1", 1)).toMatchObject({ ok: true });

  vi.mocked(runAction).mockClear();
  await receive("g1", { t: "rpc.req", id: 2, method: "run.start", params: { action: "rm -rf" } });
  expect(replyTo("g1", 2)).toMatchObject({ ok: false, error: { code: "unavailable" } });

  hostWith([]);
  await receive("g1", { t: "rpc.req", id: 3, method: "run.start", params: { action: "run" } });
  expect(replyTo("g1", 3)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(runAction).not.toHaveBeenCalled();
});

test("host: the old unchecked run message does nothing", async () => {
  hostWith([]);
  await receive("g1", { t: "run", action: "run" });
  expect(runAction).not.toHaveBeenCalled();
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
  expect(runAction).toHaveBeenCalledWith(a, arg);
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
  expect(runAction).not.toHaveBeenCalled();
});

test("host: packages.run needs `packages`, `run` is not enough", async () => {
  hostWithPackages("uv", ["run"], [pkgAct("add", "uv add {}")]);
  await pkgReq(12, "add", ["requests"]);
  expect(replyTo("g1", 12)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(runAction).not.toHaveBeenCalled();
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
  expect(runAction).not.toHaveBeenCalled();

  hostWithPackages(kind, ["packages"], [a]);
  await pkgReq(14, id, []);
  expect(replyTo("g1", 14)).toMatchObject({ ok: true });
  expect(runAction).toHaveBeenCalledWith(a, undefined);
});

test("host: run.start can't start an action that asks for input, even with `packages`", async () => {
  hostWithPackages("uv", ["run", "packages"], [pkgAct("add", "uv add {}")]);
  await receive("g1", { t: "rpc.req", id: 15, method: "run.start", params: { action: "add" } });
  expect(replyTo("g1", 15)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(runAction).not.toHaveBeenCalled();
});

test("host: packages.run only reaches package actions", async () => {
  hostWithPackages("uv", ["packages"], [pkgAct("fmt", "uvx ruff format", false)]);
  for (const [i, id] of ["fmt", "run", "constructor", "__proto__"].entries()) {
    await pkgReq(20 + i, id, []);
    expect(replyTo("g1", 20 + i)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  }
  expect(runAction).not.toHaveBeenCalled();
});

test("host: an action without input takes no packages", async () => {
  hostWithPackages("uv", ["packages"], [pkgAct("sync", "uv sync", false)]);
  await pkgReq(25, "sync", ["requests"]);
  expect(replyTo("g1", 25)).toMatchObject({ ok: false, error: { code: "invalid_package" } });
  expect(runAction).not.toHaveBeenCalled();
});

test("host: malformed package params are refused", async () => {
  hostWithPackages("uv", ["packages"], [pkgAct("add", "uv add {}")]);
  for (const [i, packages] of ["requests", [1], [null], Array(21).fill("a"), ["a".repeat(201)]].entries()) {
    await pkgReq(30 + i, "add", packages);
    expect(replyTo("g1", 30 + i)).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  }
  expect(runAction).not.toHaveBeenCalled();
});

test("host: uv remove finds the group, and refuses a group name that would inject", async () => {
  const a = pkgAct("remove", "uv remove {}");
  hostWithPackages("uv", ["packages"], [a]);
  fs.files.set("/home/g/pyproject.toml", '[project]\nname = "x"\ndependencies = ["requests"]\n\n[dependency-groups]\ndev = ["pytest"]\ndocs = ["mkdocs"]\n"x; touch /tmp/pwned #" = ["evil"]\n');
  await pkgReq(40, "remove", ["pytest"]);
  expect(runAction).toHaveBeenLastCalledWith(a, "--dev pytest");
  await pkgReq(41, "remove", ["mkdocs"]);
  expect(runAction).toHaveBeenLastCalledWith(a, "--group docs mkdocs");
  await pkgReq(42, "remove", ["requests"]);
  expect(runAction).toHaveBeenLastCalledWith(a, "requests");
  vi.mocked(runAction).mockClear();
  await pkgReq(43, "remove", ["evil"]);
  expect(replyTo("g1", 43)).toMatchObject({ ok: false, error: { code: "invalid_group" } });
  expect(runAction).not.toHaveBeenCalled();
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
