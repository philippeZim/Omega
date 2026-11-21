// Code Together debugging: the real RPC layer and store, a fake transport and a fake debug session.
import { beforeEach, expect, test, vi } from "vitest";
import { fakeUi } from "../../test/fakes";

type Msg = Record<string, any>;
const h = vi.hoisted(() => ({
  handlers: [] as ((peer: string, msg: Record<string, any>) => unknown)[],
  endHooks: [] as ((wasGuest: boolean) => unknown)[],
  sent: [] as { peer: string; msg: Record<string, any> }[],
  collab: { role: "host" as "host" | "guest" | null, status: "connected", hostPeer: "host-peer" as string | null, participants: [] as any[], myCaps: [] as string[], me: { name: "me", color: "#000" } },
  app: { root: "/home/alice/proj" as string | null, tabs: [] as any[], activeId: null as string | null, mode: "code" },
  active: null as { path: string } | null,
  gen: 1,
  debug: {} as Record<string, ReturnType<typeof vi.fn>>,
  openRemote: null as any,
}));
vi.mock("./collab.svelte", () => ({
  collab: h.collab,
  send: async (peer: string, msg: Msg) => void h.sent.push({ peer, msg: JSON.parse(JSON.stringify(msg)) }),
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void h.handlers.push(fn),
  sessionEndHooks: h.endHooks,
}));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));
vi.mock("../api", () => ({ fsApi: { exists: async () => true, homeDir: async () => "/home/alice" } }));
vi.mock("../layout.svelte", () => ({ showView: vi.fn() }));
vi.mock("../state.svelte", () => ({ app: h.app, activeTab: () => h.active, setMode: vi.fn() }));
vi.mock("./share.svelte", () => {
  const root = () => h.app.root!;
  return {
    REMOTE: "collab:",
    isRemote: (p: string | null | undefined) => !!p && p.startsWith("collab:"),
    openRemote: (...a: unknown[]) => h.openRemote(...a),
    flushBackgroundDocs: async () => {},
    guestScope: () =>
      h.app.root
        ? {
            root: root(),
            live: () => true,
            check: async (rel: string) => !rel.split("/").includes("..") && !rel.startsWith("link/"),
            abs: (rel: string) => `${root()}/${rel}`,
            rel: (abs: string) => (abs.startsWith(`${root()}/`) ? abs.slice(root().length + 1) : null),
          }
        : null,
  };
});
vi.mock("../debug/debugger.svelte", () => ({
  stopLocal: vi.fn(async () => {}),
  hostDebug: new Proxy(
    {},
    {
      get: (_t, k: string) => {
        if (k === "gen") return () => h.gen;
        if (k === "localLive") return () => false;
        if (k === "canRestart") return () => true;
        return (h.debug[k] ??= vi.fn(async () => undefined));
      },
    },
  ),
}));

const rpc = await import("./rpc.svelte");
const { dbg, saveBreakpoints, setBreakpointLines, dbgRemote } = await import("../debug/store.svelte");
const mirror = await import("./debugMirror");
const remote = await import("./debugRemote.svelte");

const PEER = "guest-1";
const guest = (caps: string[]) => ({ peer: PEER, name: "Bob", color: "#fff", role: "guest", caps });
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

let nextId = 1;
/** A guest's request as the host receives it. */
async function request(method: string, params: unknown) {
  const id = nextId++;
  for (const fn of h.handlers) await fn(PEER, { t: "rpc.req", id, method, params });
  await tick();
  const res = h.sent.find((s) => s.msg.t === "rpc.res" && s.msg.id === id)?.msg;
  return res!;
}
const code = (r: Msg) => (r.ok ? "ok" : r.error.code);

function stoppedHost() {
  Object.assign(dbg, {
    status: "stopped",
    label: "Python · /home/alice/proj/main.py",
    stopReason: "breakpoint",
    threads: [{ id: 1, name: "MainThread" }],
    threadId: 1,
    frames: [
      { id: 10, name: "work", path: "/home/alice/proj/src/main.py", line: 3, column: 1, subtle: false },
      { id: 11, name: "lib_call", path: "/usr/lib/python3/runpy.py", line: 88, column: 1, subtle: true },
      { id: 12, name: "linked", path: "/home/alice/proj/link/x.py", line: 1, column: 1, subtle: false },
    ],
    frameId: 10,
    scopes: [{ name: "Locals", value: "", ref: 7, parentRef: 0, children: null, expanded: true }],
    exec: { path: "/home/alice/proj/src/main.py", line: 3 },
  });
}

beforeEach(() => {
  h.sent.length = 0;
  h.debug = {};
  h.gen++;
  h.active = null;
  h.openRemote = vi.fn();
  h.app.root = "/home/alice/proj";
  Object.assign(h.collab, { role: "host", status: "connected", hostPeer: "host-peer", myCaps: [] });
  h.collab.participants = [{ peer: "self", name: "Alice", color: "#000", role: "host" }, guest(["debug", "edit"])];
  ui.toasts.length = 0;
  localStorage.clear();
  Object.assign(dbg, { status: "idle", label: "", stopReason: "", actor: "", threads: [], threadId: null, frames: [], frameId: null, scopes: [], exec: null, console: [], breakpoints: {} });
  rpc.forgetRpcPeer(PEER);
});

// ---------------------------------------------------------------- capability

test("without the debug capability every control and inspection call is refused", async () => {
  h.collab.participants[1] = guest(["edit"]);
  stoppedHost();
  for (const [method, params] of [
    ["debug.start", { path: "src/main.py" }],
    ["debug.control", { op: "continue" }],
    ["debug.frame", { id: 10 }],
    ["debug.variables", { ref: 7 }],
    ["debug.evaluate", { expression: "1+1", context: "repl", frameId: 10 }],
  ] as const)
    expect(code(await request(method, params))).toBe("forbidden");
  expect(Object.values(h.debug).every((f) => f.mock.calls.length === 0)).toBe(true);
});

test("a guest with the capability controls the session, and the host is told who started it", async () => {
  stoppedHost();
  expect(code(await request("debug.control", { op: "next" }))).toBe("ok");
  expect(h.debug.step).toHaveBeenCalledWith("next", "Bob");
  dbg.status = "idle";
  expect(code(await request("debug.start", { path: "src/main.py" }))).toBe("ok");
  expect(h.debug.start).toHaveBeenCalledWith("/home/alice/proj/src/main.py", "Bob");
  expect(ui.toasts.some((x) => x.text.includes("Bob"))).toBe(true);
});

test("revoking the capability ends that guest's control but not the host's session", async () => {
  stoppedHost();
  expect(code(await request("debug.control", { op: "next" }))).toBe("ok");
  rpc.setCapability(PEER, "debug", false);
  expect(code(await request("debug.control", { op: "continue" }))).toBe("forbidden");
  expect(h.debug.stop).toBeUndefined();
  expect(dbg.status).toBe("stopped");
});

test("guests can't reach anything but the typed methods or name a program to run", async () => {
  stoppedHost();
  expect(code(await request("debug.request", { command: "launch" }))).toBe("unknown_method");
  expect(code(await request("debug.control", { op: "launch" }))).toBe("invalid_params");
  for (const path of ["/etc/passwd", "../x.py", "a/../../x.py", "tab:1", "C:\\x.py", "a\\b.py", ""]) expect(code(await request("debug.start", { path }))).toBe("invalid_params");
  // Only the path is taken from the request: extra fields never reach the session.
  dbg.status = "idle";
  await request("debug.start", { path: "src/main.py", cmd: "rm", args: ["-rf"], env: { A: "1" }, cwd: "/" });
  expect(h.debug.start).toHaveBeenCalledWith("/home/alice/proj/src/main.py", "Bob");
  // A symlink out of the project fails the scope check.
  expect(code(await request("debug.start", { path: "link/x.py" }))).toBe("unavailable");
});

// ---------------------------------------------------------------- stale references

test("frame and variable references are checked against the host's current state", async () => {
  stoppedHost();
  await remote.buildState(); // hands out the scope reference
  h.debug.variables = vi.fn(async () => [{ name: "x", value: "1", variablesReference: 8 }]);
  expect(code(await request("debug.variables", { ref: 999 }))).toBe("stale");
  expect(h.debug.variables).not.toHaveBeenCalled();
  expect(code(await request("debug.variables", { ref: 7 }))).toBe("ok");
  expect(code(await request("debug.variables", { ref: 8 }))).toBe("ok");
  expect(code(await request("debug.frame", { id: 999 }))).toBe("stale");
  expect(code(await request("debug.evaluate", { expression: "x", context: "watch", frameId: 999 }))).toBe("stale");

  h.gen++; // the program moved on
  const before = h.debug.variables.mock.calls.length;
  expect(code(await request("debug.variables", { ref: 7 }))).toBe("stale");
  expect(code(await request("debug.setVariable", { ref: 7, name: "x", value: "2" }))).toBe("stale");
  expect(h.debug.variables.mock.calls.length).toBe(before);
});

test("a reply that arrives after the program moved on fails cleanly", async () => {
  stoppedHost();
  await remote.buildState();
  h.debug.variables = vi.fn(async () => {
    h.gen++;
    return [{ name: "x", value: "1", variablesReference: 0 }];
  });
  expect(code(await request("debug.variables", { ref: 7 }))).toBe("stale");
});

test("evaluation and stepping need a stopped program", async () => {
  stoppedHost();
  dbg.status = "running";
  expect(code(await request("debug.control", { op: "next" }))).toBe("not_stopped");
  expect(code(await request("debug.evaluate", { expression: "x", context: "repl", frameId: 10 }))).toBe("not_stopped");
});

test("variable expansion is bounded", async () => {
  stoppedHost();
  await remote.buildState();
  h.debug.variables = vi.fn(async () => Array.from({ length: mirror.DEBUG_LIMITS.children + 50 }, (_, i) => ({ name: `v${i}`, value: "1", variablesReference: 0 })));
  const r = await request("debug.variables", { ref: 7 });
  expect(r.result.vars).toHaveLength(mirror.DEBUG_LIMITS.children);
  expect(r.result.truncated).toBe(true);
});

// ---------------------------------------------------------------- path scrubbing

test("scrubPaths removes the project and home folders only where they are whole paths", () => {
  const s = (x: string) => mirror.scrubPaths(x, "/home/alice/proj", "/home/alice");
  expect(s('File "/home/alice/proj/src/a.py", line 3')).toBe('File "src/a.py", line 3');
  expect(s("in /home/alice/.local/lib/x.py")).toBe("in ~/.local/lib/x.py");
  expect(s("file:///home/alice/proj/a.js:1")).toBe("a.js:1");
  expect(s("cwd: /home/alice/proj")).toBe("cwd: .");
  // Neighbours of the project stay what they are.
  expect(s("/home/alice/proj2/a.py")).toBe("~/proj2/a.py");
  expect(s("/mnt/home/alice/proj/a.py")).toBe("/mnt/home/alice/proj/a.py");
  expect(mirror.scrubPaths("C:\\Users\\al\\proj\\a.py", "C:/Users/al/proj", null)).toBe("a.py");
});

test("a path split across terminal chunks is still scrubbed, and nothing is lost", () => {
  const scrubber = new mirror.StreamScrubber("/home/alice/proj", "/home/alice");
  const enc = new TextEncoder();
  let out = scrubber.push(enc.encode("run /home/al"));
  out += scrubber.push(enc.encode("ice/proj/main.py äö\n/home/alice/pr"));
  out += scrubber.push(enc.encode("oj2/x /tmp/ok /ho"));
  out += scrubber.flush();
  expect(out).toBe("run main.py äö\n~/proj2/x /tmp/ok /ho");
});

test("the mirrored state holds no absolute host paths, and outside frames are only a name", async () => {
  stoppedHost();
  const state = await remote.buildState();
  expect(JSON.stringify(state)).not.toContain("/home/alice");
  expect(JSON.stringify(state)).not.toContain("/usr/lib");
  expect(state.frames.map((f) => f.rel)).toEqual(["src/main.py", null, null]);
  expect(state.frames[1]).toMatchObject({ name: "lib_call", subtle: true });
  expect(state.exec).toEqual({ rel: "src/main.py", line: 3 });
});

test("variable values and results stay exactly what the program holds", async () => {
  stoppedHost();
  await remote.buildState();
  const value = "'/home/alice/proj/data.csv'";
  h.debug.variables = vi.fn(async () => [{ name: "p", value, variablesReference: 0 }]);
  h.debug.evaluate = vi.fn(async () => ({ result: value, variablesReference: 0 }));
  expect((await request("debug.variables", { ref: 7 })).result.vars[0].value).toBe(value);
  expect((await request("debug.evaluate", { expression: "p", context: "watch", frameId: 10 })).result.value).toBe(value);
});

test("an evaluation error is scrubbed", async () => {
  stoppedHost();
  h.debug.evaluate = vi.fn(async () => {
    throw new Error('File "/home/alice/proj/a.py" not found');
  });
  const r = await request("debug.evaluate", { expression: "x", context: "watch", frameId: 10 });
  expect(r.result.error).toBe('File "a.py" not found');
});

// ---------------------------------------------------------------- shared breakpoints

test("a guest's breakpoints land on the host's file with their condition", async () => {
  const lines = [{ line: 5, condition: "x > 1" }, { line: 2 }];
  expect(code(await request("debug.breakpoints", { path: "src/main.py", lines }))).toBe("ok");
  expect(dbg.breakpoints["/home/alice/proj/src/main.py"]).toEqual([
    { line: 2, verified: undefined },
    { line: 5, condition: "x > 1", verified: undefined },
  ]);
  expect((await remote.buildBreakpoints()).files["src/main.py"]).toEqual([{ line: 2 }, { line: 5, condition: "x > 1" }]);
});

test("breakpoint paths and lists are validated", async () => {
  expect(code(await request("debug.breakpoints", { path: "../x.py", lines: [] }))).toBe("invalid_params");
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 0 }] }))).toBe("invalid_params");
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 1 }, { line: 1 }] }))).toBe("invalid_params");
  const many = Array.from({ length: mirror.DEBUG_LIMITS.bpPerFile + 1 }, (_, i) => ({ line: i + 1 }));
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: many }))).toBe("invalid_params");
  expect(code(await request("debug.breakpoints", { path: "link/x.py", lines: [{ line: 1 }] }))).toBe("unavailable");
});

test("with only `edit` a guest can carry breakpoints along, but not add or change them", async () => {
  h.collab.participants[1] = guest(["edit"]);
  dbg.breakpoints["/home/alice/proj/a.py"] = [{ line: 3, condition: "c" }];
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 4, condition: "c" }] }))).toBe("ok");
  expect(dbg.breakpoints["/home/alice/proj/a.py"][0].line).toBe(4);
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 4, condition: "other" }] }))).toBe("forbidden");
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [] }))).toBe("forbidden");
  h.collab.participants[1] = guest([]);
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 9, condition: "c" }] }))).toBe("forbidden");
});

test("files outside the project are not shared", async () => {
  dbg.breakpoints["/etc/secret.py"] = [{ line: 1 }];
  dbg.breakpoints["/home/alice/proj/link/x.py"] = [{ line: 1 }];
  dbg.breakpoints["/home/alice/proj/ok.py"] = [{ line: 1, verified: true }];
  expect((await remote.buildBreakpoints()).files).toEqual({ "ok.py": [{ line: 1, verified: true }] });
});

// ---------------------------------------------------------------- guest side

function asGuest() {
  Object.assign(h.collab, { role: "guest", status: "connected", hostPeer: "host-peer", myCaps: ["debug", "edit"] });
}
const fromHost = async (msg: Msg) => {
  for (const fn of h.handlers) await fn("host-peer", msg);
  await tick();
};

test("a guest's own breakpoints stay apart from the session's and survive it", async () => {
  dbg.breakpoints["/mine/own.py"] = [{ line: 7 }];
  saveBreakpoints();
  asGuest();
  await fromHost({ t: "rpc.pub", topic: "debug.bps", payload: { files: { "src/a.py": [{ line: 2, verified: true }] } } });
  expect(dbg.breakpoints["collab:src/a.py"]).toEqual([{ line: 2, verified: true }]);
  expect(dbg.breakpoints["/mine/own.py"]).toEqual([{ line: 7 }]);

  setBreakpointLines("/mine/own.py", [{ line: 8 }]);
  expect(JSON.parse(localStorage.getItem("breakpoints")!)).toEqual({ "/mine/own.py": [{ line: 8 }] });

  for (const hook of h.endHooks) await hook(true);
  expect(Object.keys(dbg.breakpoints)).toEqual(["/mine/own.py"]);
});

test("a change from the host replaces the guest's copy of that file", async () => {
  asGuest();
  await fromHost({ t: "rpc.pub", topic: "debug.bps", payload: { files: { "a.py": [{ line: 2 }], "b.py": [{ line: 1 }] } } });
  await fromHost({ t: "rpc.pub", topic: "debug.bps", payload: { files: { "a.py": [{ line: 3 }] } } });
  expect(dbg.breakpoints["collab:a.py"]).toEqual([{ line: 3 }]);
  expect(dbg.breakpoints["collab:b.py"]).toBeUndefined();
});

test("a refused breakpoint edit goes back to the host's list", async () => {
  asGuest();
  await fromHost({ t: "rpc.pub", topic: "debug.bps", payload: { files: { "a.py": [{ line: 2 }] } } });
  dbg.breakpoints["collab:a.py"] = [{ line: 2 }, { line: 9 }];
  dbgRemote.impl!.breakpointsChanged("collab:a.py");
  await tick();
  const req = h.sent.find((s) => s.msg.t === "rpc.req" && s.msg.method === "debug.breakpoints")!;
  expect(req.msg.params).toEqual({ path: "a.py", lines: [{ line: 2 }, { line: 9 }] });
  await fromHost({ t: "rpc.res", id: req.msg.id, ok: false, error: { code: "forbidden" } });
  expect(dbg.breakpoints["collab:a.py"]).toEqual([{ line: 2 }]);
});

test("the mirrored state shows the host's stop and opens the shared tab", async () => {
  asGuest();
  await fromHost({
    t: "rpc.pub",
    topic: "debug.state",
    payload: {
      status: "stopped", label: "Python", stopReason: "breakpoint", actor: "Bob", gen: 5,
      threads: [{ id: 1, name: "Main" }], threadId: 1,
      frames: [{ id: 10, name: "work", rel: "src/a.py", line: 3, column: 1, subtle: false }, { id: 11, name: "lib", rel: null, line: 9, column: 1, subtle: true }],
      frameId: 10, scopes: [], scopesVersion: 1, exec: { rel: "src/a.py", line: 3 },
    },
  });
  expect(dbg.status).toBe("stopped");
  expect(dbg.exec).toEqual({ path: "collab:src/a.py", line: 3 });
  expect(dbg.frames.map((f) => f.path)).toEqual(["collab:src/a.py", null]);
  expect(h.openRemote).toHaveBeenCalledWith("src/a.py", 3);
  // Capability gone: the mirror empties, the session on the host is none of its business.
  await fromHost({ t: "rpc.pub", topic: "debug.state", payload: null });
  expect(dbg.status).toBe("idle");
  expect(dbg.frames).toEqual([]);
});
