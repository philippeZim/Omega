// Level 1: guests typing into the host's running program.
import { beforeEach, expect, test, vi } from "vitest";
import { fakeUi } from "../../test/fakes";

type Msg = Record<string, any>;
const h = vi.hoisted(() => ({
  handlers: [] as ((peer: string, msg: Record<string, any>) => unknown)[],
  endHooks: [] as ((wasGuest: boolean) => unknown)[],
  sent: [] as { peer: string; msg: Record<string, any> }[],
  collab: { role: "host" as "host" | "guest", status: "connected", hostPeer: "host-peer", participants: [] as any[], myCaps: [] as string[] },
  task: { id: 7 as number | null, packages: false },
  write: vi.fn(async (_id: number, _data: string) => "ok"),
  remoteTask: null as any,
}));
vi.mock("./collab.svelte", () => ({
  collab: h.collab,
  send: async (peer: string, msg: Msg) => void h.sent.push({ peer, msg }),
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void h.handlers.push(fn),
  sessionEndHooks: h.endHooks,
}));
vi.mock("../terminal.svelte", () => ({
  runningPackageTask: (id: number) => (h.task.id === id ? h.task.packages : null),
  writeTaskInput: h.write,
}));
vi.mock("../code/runner.svelte", () => ({
  runner: { get remoteTask() { return h.remoteTask; } },
}));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));

const { guestGuard } = await import("./guard");
const { setCapability } = await import("./rpc.svelte");
const { typeIntoHostRun } = await import("./runInput.svelte");

let id = 0;
async function input(peer: string, params: unknown) {
  const rid = ++id;
  for (const fn of h.handlers) await fn(peer, { t: "rpc.req", id: rid, method: "run.input", params });
  await vi.waitFor(() => expect(h.sent.some((s) => s.msg.t === "rpc.res" && s.msg.id === rid)).toBe(true));
  return h.sent.find((s) => s.msg.t === "rpc.res" && s.msg.id === rid)!.msg;
}
const guest = (peer: string, caps: string[]) => ({ peer, name: peer, color: "#333", role: "guest", caps });

beforeEach(() => {
  h.sent.length = 0;
  h.write.mockReset();
  h.write.mockResolvedValue("ok");
  Object.assign(h.task, { id: 7, packages: false });
  Object.assign(h.collab, { role: "host", status: "connected", hostPeer: "host-peer", myCaps: [], participants: [{ peer: "self", role: "host" }, guest("g1", ["run"]), guest("g2", ["edit"])] });
  guestGuard.can = (c) => h.collab.myCaps.includes(c);
  h.remoteTask = null;
  ui.reset();
});

test("input reaches the task it names", async () => {
  expect((await input("g1", { taskId: 7, data: "Ada\r" })).ok).toBe(true);
  expect(h.write).toHaveBeenCalledWith(7, "Ada\r");
});

test("a wrong or finished task id never reaches a PTY", async () => {
  const r = await input("g1", { taskId: 6, data: "rm -rf\r" });
  expect(r.error.code).toBe("task_ended");
  h.task.id = null;
  expect((await input("g1", { taskId: 7, data: "late\r" })).error.code).toBe("task_ended");
  expect(h.write).not.toHaveBeenCalled();
});

test("the task ending between check and write is reported, not retried", async () => {
  h.write.mockResolvedValue("ended");
  expect((await input("g1", { taskId: 7, data: "x" })).error.code).toBe("task_ended");
});

test("without `run`, and after it's revoked, input is refused", async () => {
  expect((await input("g2", { taskId: 7, data: "x" })).error.code).toBe("forbidden");
  setCapability("g1", "run", false);
  expect((await input("g1", { taskId: 7, data: "x" })).error.code).toBe("forbidden");
  expect(h.write).not.toHaveBeenCalled();
});

test("a package task only takes input from guests with `packages`", async () => {
  h.task.packages = true;
  expect((await input("g1", { taskId: 7, data: "y\r" })).error.code).toBe("forbidden");
  h.collab.participants[1].caps = ["run", "packages"];
  expect((await input("g1", { taskId: 7, data: "y\r" })).ok).toBe(true);
});

test("the host cleans the input itself and refuses what's too large", async () => {
  await input("g1", { taskId: 7, data: "a\x03\x1b]0;evil\x07b" });
  expect(h.write).toHaveBeenLastCalledWith(7, "ab");
  h.write.mockClear();
  expect((await input("g1", { taskId: 7, data: "\x1b]0;evil\x07" })).ok).toBe(true);
  expect(h.write).not.toHaveBeenCalled();
  expect((await input("g1", { taskId: 7, data: "x".repeat(4097) })).error.code).toBe("invalid_params");
  for (const bad of [{ taskId: "7", data: "x" }, { taskId: 7, data: 1 }, { taskId: 7, data: "" }, null]) expect((await input("g1", bad)).error.code).toBe("invalid_params");
});

test("a full input queue is reported as busy", async () => {
  h.write.mockResolvedValue("busy");
  expect((await input("g1", { taskId: 7, data: "x" })).error.code).toBe("input_busy");
});

// ------------------------------------------------------------------ guest

const asGuest = (caps: string[]) => Object.assign(h.collab, { role: "guest", myCaps: caps });
const reqs = () => h.sent.filter((s) => s.msg.t === "rpc.req").map((s) => s.msg);

test("guest: typing goes out with the running task's id", async () => {
  asGuest(["run"]);
  h.remoteTask = { running: true, taskId: 9 };
  typeIntoHostRun("hi\r", vi.fn());
  expect(reqs()[0]).toMatchObject({ method: "run.input", params: { taskId: 9, data: "hi\r" } });
  for (const p of reqs()) for (const fn of h.handlers) await fn("host-peer", { t: "rpc.res", id: p.id, ok: true, result: null });
});

test("guest: Ctrl+C is the Stop action and is never sent as input", async () => {
  asGuest(["run"]);
  h.remoteTask = { running: true, taskId: 10 };
  const stop = vi.fn();
  typeIntoHostRun("\x03", stop);
  expect(stop).toHaveBeenCalledOnce();
  expect(reqs()).toEqual([]);
});

test("guest: nothing is sent while no task runs or without `run`", () => {
  asGuest(["run"]);
  h.remoteTask = { running: false, taskId: 10 };
  const stop = vi.fn();
  typeIntoHostRun("x\x03", stop);
  expect(stop).not.toHaveBeenCalled();
  asGuest([]);
  h.remoteTask = { running: true, taskId: 11 };
  typeIntoHostRun("x", stop);
  expect(reqs()).toEqual([]);
  expect(ui.toast).toHaveBeenCalled();
});
