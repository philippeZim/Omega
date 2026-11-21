// Level 2: a granted shell on the host, driven through the real RPC layer.
import { beforeEach, expect, test, vi } from "vitest";
import { fakeUi } from "../../test/fakes";

type Msg = Record<string, any>;
const h = vi.hoisted(() => ({
  handlers: [] as ((peer: string, msg: Record<string, any>) => unknown)[],
  endHooks: [] as ((wasGuest: boolean) => unknown)[],
  goneHooks: [] as ((peer: string) => void)[],
  events: new Map<string, (e: { payload: any }) => void>(),
  sent: [] as { peer: string; msg: Record<string, any> }[],
  collab: { role: "host" as "host" | "guest", status: "connected", hostPeer: "host-peer", participants: [] as any[], myCaps: [] as string[], startCaps: [] as string[] },
  tabs: [] as { id: string; onClose?: () => void }[],
  killed: [] as string[],
  spawn: vi.fn(async (..._a: unknown[]) => {}),
  write: vi.fn(async (_id: string, _d: string) => "ok"),
  resize: vi.fn(),
  setStart: vi.fn(),
  n: 0,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, cb: (e: { payload: any }) => void) => (h.events.set(name, cb), () => {}) }));
vi.mock("./collab.svelte", () => ({
  collab: h.collab,
  send: async (peer: string, msg: Msg) => void h.sent.push({ peer, msg }),
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void h.handlers.push(fn),
  sessionEndHooks: h.endHooks,
  peerGoneHooks: h.goneHooks,
  setStartCapability: h.setStart,
}));
vi.mock("../terminal.svelte", () => {
  const close = (id: string) => {
    const i = h.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [tab] = h.tabs.splice(i, 1);
    h.killed.push(id);
    tab.onClose?.();
  };
  const add = (onClose?: () => void) => {
    const id = `tab${++h.n}`;
    h.tabs.push({ id, onClose });
    return id;
  };
  return {
    terms: { get tabs() { return h.tabs; }, active: null },
    closeTerminal: close,
    openGuestShellView: (_title: string, _c: number, _r: number, onClose: () => void) => add(onClose),
    remoteTerminal: (_t: string, _i: unknown, o: { onClose?: () => void }) => add(o.onClose),
    spawnGuestShell: h.spawn,
    writeGuestShell: h.write,
    resizeGuestShell: h.resize,
    terminalSize: () => ({ cols: 80, rows: 24 }),
    markTerminalExited: vi.fn(),
    writeTerminal: vi.fn(),
  };
});
vi.mock("../layout.svelte", () => ({ showView: vi.fn() }));
vi.mock("../state.svelte", () => ({ app: { root: "/project" } }));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));

const { setCapability } = await import("./rpc.svelte");
const { TERM_LIMITS } = await import("./guestInput");
const { endGuestShell, guestShells, requestCapability, requestStartCapability } = await import("./guestShell.svelte");

let rid = 0;
async function rpc(peer: string, method: string, params: unknown) {
  const id = ++rid;
  for (const fn of h.handlers) await fn(peer, { t: "rpc.req", id, method, params });
  await vi.waitFor(() => expect(h.sent.some((s) => s.msg.t === "rpc.res" && s.msg.id === id)).toBe(true));
  return h.sent.find((s) => s.msg.t === "rpc.res" && s.msg.id === id)!.msg;
}
const openShell = async (peer = "g1") => (await rpc(peer, "shell.open", { cols: 80, rows: 24 })).result.id as string;
const guest = (peer: string, caps: string[]) => ({ peer, name: peer, color: "#333", role: "guest", caps });

beforeEach(async () => {
  for (const fn of h.endHooks) await fn(false);
  h.sent.length = 0;
  h.killed.length = 0;
  h.tabs.length = 0;
  for (const f of [h.spawn, h.write, h.resize, h.setStart]) f.mockClear();
  h.write.mockResolvedValue("ok");
  h.spawn.mockImplementation(async () => {});
  ui.reset();
  Object.assign(h.collab, { role: "host", status: "connected", myCaps: [], participants: [{ peer: "self", role: "host", name: "H" }, guest("g1", ["run", "terminal"]), guest("g2", ["run", "terminal"]), guest("g3", ["run"])] });
});

test("turning `terminal` on needs the confirmation, which says what it means", async () => {
  const p = h.collab.participants[3];
  setCapability("g3", "terminal", true);
  expect(p.caps).not.toContain("terminal");

  ui.confirm.mockResolvedValueOnce(false);
  await requestCapability("g3", "terminal", true);
  expect(p.caps).not.toContain("terminal");

  ui.confirm.mockResolvedValueOnce(true);
  await requestCapability("g3", "terminal", true);
  expect(p.caps).toContain("terminal");
  const [title, body] = ui.confirm.mock.calls.at(-1) as unknown as string[];
  expect(title).toContain("full control of this computer");
  expect(body).toContain("your user account");
  expect(body).toContain("not limited to the project");
});

test("other capabilities and turning `terminal` off don't ask", async () => {
  await requestCapability("g1", "terminal", false);
  await requestCapability("g3", "git", false);
  expect(ui.confirm).not.toHaveBeenCalled();
  expect(h.collab.participants[1].caps).not.toContain("terminal");
});

test("the start right for `terminal` needs the same confirmation", async () => {
  ui.confirm.mockResolvedValueOnce(false);
  await requestStartCapability("terminal", true);
  expect(h.setStart).not.toHaveBeenCalled();
  ui.confirm.mockResolvedValueOnce(true);
  await requestStartCapability("terminal", true);
  expect(h.setStart).toHaveBeenCalledWith("terminal", true, { confirmed: true });
});

test("a shell starts in the project root and shows up in the indicator", async () => {
  const id = await openShell();
  expect(h.spawn).toHaveBeenCalledWith(id, "/project", 80, 24);
  expect(guestShells.list).toMatchObject([{ id, peer: "g1", name: "g1" }]);
});

test("without `terminal` no shell starts", async () => {
  expect((await rpc("g3", "shell.open", { cols: 80, rows: 24 })).error.code).toBe("forbidden");
  expect(h.spawn).not.toHaveBeenCalled();
});

test("sizes are validated on open and resize", async () => {
  expect((await rpc("g1", "shell.open", { cols: 9999, rows: 24 })).error.code).toBe("invalid_params");
  const id = await openShell();
  expect((await rpc("g1", "shell.resize", { id, cols: 80, rows: 0 })).error.code).toBe("invalid_params");
  expect(h.resize).not.toHaveBeenCalled();
  expect((await rpc("g1", "shell.resize", { id, cols: 100, rows: 30 })).ok).toBe(true);
  expect(h.resize).toHaveBeenCalledWith(id, 100, 30);
});

test("shells are bounded per guest and in total, also for parallel requests", async () => {
  const results = await Promise.all(Array.from({ length: TERM_LIMITS.shellsPerGuest + 2 }, () => rpc("g1", "shell.open", { cols: 80, rows: 24 })));
  expect(results.filter((r) => r.ok).length).toBe(TERM_LIMITS.shellsPerGuest);
  expect(results.filter((r) => r.error?.code === "shell_limit").length).toBe(2);

  h.collab.participants.push(...["a", "b", "c", "d"].map((x) => guest(x, ["terminal"])));
  const more = [];
  for (const x of ["g2", "g2", "a", "a", "b", "b"]) more.push(await rpc(x, "shell.open", { cols: 80, rows: 24 }));
  expect(guestShells.list.length).toBe(TERM_LIMITS.shellsTotal);
  expect(more.at(-1)!.error.code).toBe("shell_limit");
});

test("a guest can't reach another guest's shell", async () => {
  const id = await openShell("g1");
  expect((await rpc("g2", "shell.input", { id, data: "id\r" })).error.code).toBe("shell_ended");
  expect((await rpc("g2", "shell.resize", { id, cols: 90, rows: 30 })).error.code).toBe("shell_ended");
  await rpc("g2", "shell.close", { id });
  expect(h.write).not.toHaveBeenCalled();
  expect(h.killed).toEqual([]);
  await rpc("g1", "shell.input", { id, data: "id\r" });
  expect(h.write).toHaveBeenCalledWith(id, "id\r");
});

test("revoking `terminal` kills the guest's shells and no others, and later input is refused", async () => {
  const a = await openShell("g1");
  const b = await openShell("g2");
  setCapability("g1", "terminal", false);
  expect(h.killed).toEqual([a]);
  expect(guestShells.list.map((s) => s.id)).toEqual([b]);
  expect(h.sent.some((s) => s.peer === "g1" && s.msg.t === "shell.exit" && s.msg.id === a)).toBe(true);
  expect((await rpc("g1", "shell.input", { id: a, data: "x" })).error.code).toBe("forbidden");
});

test("a guest being kicked or leaving kills its shell at once", async () => {
  const a = await openShell("g1");
  for (const fn of h.goneHooks) fn("g1");
  expect(h.killed).toEqual([a]);
  expect(guestShells.list).toEqual([]);
});

test("the end of the session kills every shell", async () => {
  const a = await openShell("g1");
  const b = await openShell("g2");
  for (const fn of h.endHooks) await fn(false);
  expect(h.killed.sort()).toEqual([a, b].sort());
  expect(guestShells.list).toEqual([]);
});

test("the host's End button and closing its view both end the shell", async () => {
  const a = await openShell("g1");
  endGuestShell(a);
  expect(h.killed).toEqual([a]);
  const b = await openShell("g1");
  h.tabs.find((t) => t.id === b)!.onClose?.();
  expect(guestShells.list).toEqual([]);
  expect(h.sent.some((s) => s.msg.t === "shell.exit" && s.msg.id === b)).toBe(true);
});

test("losing the capability while the shell starts leaves nothing behind", async () => {
  let started: () => void = () => {};
  h.spawn.mockImplementationOnce(() => new Promise<void>((r) => (started = r)));
  const pending = rpc("g1", "shell.open", { cols: 80, rows: 24 });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
  setCapability("g1", "terminal", false);
  started();
  expect((await pending).error.code).toBe("forbidden");
  expect(guestShells.list).toEqual([]);
  expect(h.tabs).toEqual([]);
});

test("output goes only to its guest, stays bounded, and marks what was skipped", async () => {
  vi.useFakeTimers();
  try {
    const pending = rpc("g1", "shell.open", { cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(100);
    const id = (await pending).result.id;
    h.sent.length = 0;
    const chunk = "A".repeat(20_000);
    for (let i = 0; i < 200; i++) h.events.get("pty-data")!({ payload: { id, data: chunk } });
    await vi.advanceTimersByTimeAsync(100);
    const out = h.sent.filter((s) => s.msg.t === "shell.data");
    expect(out.every((s) => s.peer === "g1")).toBe(true);
    expect(out.every((s) => JSON.stringify(s.msg).length < TERM_LIMITS.maxOutputMessage + 1000)).toBe(true);
    expect(out.reduce((n, s) => n + s.msg.chunks.join("").length, 0)).toBeLessThanOrEqual(TERM_LIMITS.maxBufferedOutput);
    expect(out[0].msg.skipped).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a shell that exits by itself clears the indicator and tells the guest", async () => {
  const id = await openShell("g1");
  h.events.get("pty-exit")!({ payload: { id, code: 0 } });
  expect(guestShells.list).toEqual([]);
  expect(h.sent.some((s) => s.msg.t === "shell.exit" && s.msg.id === id)).toBe(true);
});
