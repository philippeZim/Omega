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
  starting: false,
  planFile: null as string | null,
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
        if (k === "starting") return () => h.starting;
        if (k === "planFile") return () => h.planFile;
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

beforeEach(async () => {
  h.collab.role = "host";
  for (const hook of h.endHooks) await hook(false);
  h.starting = false;
  h.planFile = null;
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
  expect(dbg.breakpoints["/home/alice/proj/src/main.py"].map((b) => [b.line, b.condition])).toEqual([[2, undefined], [5, "x > 1"]]);
  expect((await remote.buildBreakpoints()).files["src/main.py"]).toEqual([{ line: 2 }, { line: 5, condition: "x > 1" }]);
});

test("breakpoint paths and lists are validated", async () => {
  expect(code(await request("debug.breakpoints", { path: "../x.py", lines: [] }))).toBe("invalid_params");
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 0 }] }))).toBe("invalid_params");
  const many = Array.from({ length: mirror.DEBUG_LIMITS.bpPerFile + 1 }, (_, i) => ({ line: i + 1 }));
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: many }))).toBe("invalid_params");
  expect(code(await request("debug.breakpoints", { path: "link/x.py", lines: [{ line: 1 }] }))).toBe("unavailable");
});

test("with only `edit` a guest can carry breakpoints along, but not add or change them", async () => {
  h.collab.participants[1] = guest(["edit"]);
  dbg.breakpoints["/home/alice/proj/a.py"] = [{ line: 3, condition: "c" }];
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 4, condition: "c" }] }))).toBe("ok");
  expect(dbg.breakpoints["/home/alice/proj/a.py"][0].line).toBe(4);
  // A condition from a guest without `debug` is ignored, and it can't add an entry.
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 4, condition: "other" }] }))).toBe("ok");
  expect(dbg.breakpoints["/home/alice/proj/a.py"][0].condition).toBe("c");
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 4 }, { line: 9 }] }))).toBe("forbidden");
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

// ---------------------------------------------------------------- review: session-only guest data

const ABS = "/home/alice/proj/a.py";
const saved = () => JSON.parse(localStorage.getItem("breakpoints") ?? "{}");
const endSession = async () => {
  for (const hook of h.endHooks) await hook(false);
};

test("a guest's breakpoint and condition are never saved and go when the session ends", async () => {
  await request("debug.breakpoints", { path: "a.py", lines: [{ line: 5, condition: "evil()" }] });
  expect(dbg.breakpoints[ABS]).toHaveLength(1); // live for the adapter
  expect(localStorage.getItem("breakpoints") ?? "").not.toContain("evil");
  await endSession();
  expect(dbg.breakpoints[ABS] ?? []).toEqual([]);
  expect(localStorage.getItem("breakpoints") ?? "").not.toContain("evil");
});

test("a guest can't rewrite the condition of a host breakpoint into saved state", async () => {
  setBreakpointLines(ABS, [{ line: 3, condition: "mine" }]);
  await request("debug.breakpoints", { path: "a.py", lines: [{ line: 3, condition: "evil()" }] });
  expect(dbg.breakpoints[ABS][0].condition).toBe("evil()");
  expect(saved()[ABS]).toEqual([{ line: 3, condition: "mine" }]);
  await endSession();
  expect(dbg.breakpoints[ABS].map((b) => [b.line, b.condition])).toEqual([[3, "mine"]]);
});

test("line moves of host breakpoints from shared edits stay saved", async () => {
  setBreakpointLines(ABS, [{ line: 3, condition: "mine" }]);
  await request("debug.breakpoints", { path: "a.py", lines: [{ line: 7, condition: "mine" }] });
  expect(saved()[ABS]).toEqual([{ line: 7, condition: "mine" }]);
});

test("a guest removing a host breakpoint doesn't remove it from saved state", async () => {
  setBreakpointLines(ABS, [{ line: 3 }, { line: 8 }]);
  await request("debug.breakpoints", { path: "a.py", lines: [{ line: 8 }] });
  expect(dbg.breakpoints[ABS].map((b) => b.line)).toEqual([8]);
  expect(saved()[ABS].map((b: { line: number }) => b.line)).toEqual([3, 8]);
  await endSession();
  expect(dbg.breakpoints[ABS].map((b) => b.line)).toEqual([3, 8]);
});

test("losing the capability takes that guest's entries back, others stay", async () => {
  setBreakpointLines(ABS, [{ line: 3, condition: "mine" }]);
  await request("debug.breakpoints", { path: "a.py", lines: [{ line: 3, condition: "evil()" }, { line: 9 }] });
  rpc.setCapability(PEER, "debug", false);
  remote.syncGuestRights();
  expect(dbg.breakpoints[ABS].map((b) => [b.line, b.condition])).toEqual([[3, "mine"]]);
});

test("the host can adopt a guest's breakpoint, then it is saved", async () => {
  const { adoptBreakpoint } = await import("../debug/store.svelte");
  await request("debug.breakpoints", { path: "a.py", lines: [{ line: 5, condition: "useful" }] });
  adoptBreakpoint(ABS, 5);
  expect(saved()[ABS]).toEqual([{ line: 5, condition: "useful" }]);
  await endSession();
  expect(dbg.breakpoints[ABS].map((b) => b.condition)).toEqual(["useful"]);
});

test("the host's own edits keep a guest's entry session-only", async () => {
  await request("debug.breakpoints", { path: "a.py", lines: [{ line: 5, condition: "evil()" }] });
  // The host's editor reports the marker at its new line after a text edit.
  setBreakpointLines(ABS, [{ line: 6, condition: "evil()" }], true);
  expect(dbg.breakpoints[ABS][0].line).toBe(6);
  expect(localStorage.getItem("breakpoints") ?? "").not.toContain("evil");
  // An editor that still holds a stale marker can't turn it into a host breakpoint.
  setBreakpointLines(ABS, [{ line: 6, condition: "evil()" }, { line: 20, condition: "stale" }], true);
  expect(dbg.breakpoints[ABS]).toHaveLength(1);
});

test("a failing save neither throws nor keeps the adapter from syncing", async () => {
  const { dbgHooks } = await import("../debug/store.svelte");
  const before = dbgHooks.breakpointsChanged;
  const changed = vi.fn();
  dbgHooks.breakpointsChanged = changed;
  const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  try {
    expect(() => setBreakpointLines(ABS, [{ line: 1 }])).not.toThrow();
    expect(changed).toHaveBeenCalledWith(ABS);
  } finally {
    spy.mockRestore();
    dbgHooks.breakpointsChanged = before;
  }
});

// ---------------------------------------------------------------- review: restart and in-flight starts

test("restart is refused from idle, during a start and for a file outside the scope", async () => {
  h.planFile = "/home/alice/proj/main.py";
  dbg.status = "terminated";
  expect(code(await request("debug.control", { op: "restart" }))).toBe("no_session");
  stoppedHost();
  h.starting = true;
  expect(code(await request("debug.control", { op: "restart" }))).toBe("busy");
  h.starting = false;
  for (const file of ["/etc/evil.py", "/home/alice/proj/link/x.py", "/home/alice/other/x.py"]) {
    h.planFile = file;
    expect(code(await request("debug.control", { op: "restart" }))).toBe("unavailable");
  }
  expect(h.debug.restart).toBeUndefined();
  h.planFile = "/home/alice/proj/main.py";
  expect(code(await request("debug.control", { op: "restart" }))).toBe("ok");
  expect(h.debug.restart).toHaveBeenCalledWith("/home/alice/proj/main.py", "Bob");
});

test("a start is refused while one is in progress", async () => {
  h.starting = true;
  expect(code(await request("debug.start", { path: "src/main.py" }))).toBe("busy");
  expect(h.debug.start).toBeUndefined();
});

test("revoking the capability cancels that guest's start still in flight", async () => {
  h.debug.start = vi.fn(() => new Promise<undefined>(() => {}));
  await request("debug.start", { path: "src/main.py" });
  h.starting = true;
  rpc.setCapability(PEER, "debug", false);
  remote.syncGuestRights();
  expect(h.debug.cancelStart).toHaveBeenCalledTimes(1);
});

test("the last guest leaving cancels its start still in flight", async () => {
  h.debug.start = vi.fn(() => new Promise<undefined>(() => {}));
  await request("debug.start", { path: "src/main.py" });
  h.starting = true;
  h.collab.participants = h.collab.participants.filter((p) => p.peer !== PEER);
  remote.syncGuestRights();
  expect(h.debug.cancelStart).toHaveBeenCalledTimes(1);
});

test("the end of the session forgets a file only a guest had started", async () => {
  h.debug.forgetGuestPlan = vi.fn();
  await endSession();
  expect(h.debug.forgetGuestPlan).toHaveBeenCalled();
});

// ---------------------------------------------------------------- review: payload limits

test("breakpoints that can't all fit are left out instead of breaking the publish", async () => {
  const cond = "x".repeat(mirror.DEBUG_LIMITS.conditionChars);
  for (let f = 0; f < mirror.DEBUG_LIMITS.bpFiles; f++)
    dbg.breakpoints[`/home/alice/proj/f${f}.py`] = Array.from({ length: mirror.DEBUG_LIMITS.bpPerFile }, (_, i) => ({ line: i + 1, condition: cond }));
  const value = await remote.buildBreakpoints();
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(mirror.DEBUG_LIMITS.bpChars + 1024);
  expect(rpc.fits(JSON.stringify(value))).toBe(true);
});

test("a file with an oversized condition isn't shared in a cut form, and guests can't edit it", async () => {
  dbg.breakpoints[ABS] = [{ line: 1, condition: "y".repeat(mirror.DEBUG_LIMITS.conditionChars + 1) }];
  expect((await remote.buildBreakpoints()).files["a.py"]).toBeUndefined();
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [] }))).toBe("too_many");
  expect(dbg.breakpoints[ABS]).toHaveLength(1);
});

test("scopes are capped in the mirrored state", async () => {
  stoppedHost();
  dbg.scopes = Array.from({ length: mirror.DEBUG_LIMITS.scopes + 10 }, (_, i) => ({ name: `s${i}`, value: "", ref: i + 1, parentRef: 0, children: null, expanded: false }));
  expect((await remote.buildState()).scopes).toHaveLength(mirror.DEBUG_LIMITS.scopes);
});

test("a value that failed to publish doesn't become the snapshot", async () => {
  dbg.breakpoints[ABS] = [{ line: 1 }];
  await remote.publishDebugNow();
  const snapshot = async () => {
    rpc.forgetRpcPeer(PEER);
    h.sent.length = 0;
    for (const fn of h.handlers) await fn(PEER, { t: "rpc.sub", topic: "debug.bps" });
    return JSON.stringify(h.sent.find((x) => x.msg.t === "rpc.pub" && x.msg.topic === "debug.bps")?.msg.payload);
  };
  const good = await snapshot();
  expect(good).toContain('"line":1');
  dbg.breakpoints[ABS] = [{ line: 2 }];
  const limit = rpc.RPC_LIMITS.maxBytes;
  rpc.RPC_LIMITS.maxBytes = 2;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await remote.publishDebugNow();
  } finally {
    rpc.RPC_LIMITS.maxBytes = limit;
    warn.mockRestore();
  }
  expect(await snapshot()).toBe(good);
});

// ---------------------------------------------------------------- review: drift for `edit`-only guests

test("deleting a line with a breakpoint drops that entry and keeps the others' conditions", async () => {
  h.collab.participants[1] = guest(["edit"]);
  dbg.breakpoints[ABS] = [{ line: 3, condition: "a" }, { line: 6 }, { line: 9, condition: "c" }];
  // Line 6 was deleted: what was on 9 is now on 8.
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 3 }, { line: 8 }] }))).toBe("ok");
  expect(dbg.breakpoints[ABS].map((b) => [b.line, b.condition])).toEqual([[3, "a"], [8, "c"]]);
});

test("two markers collapsing onto one line merge deterministically", async () => {
  h.collab.participants[1] = guest(["edit"]);
  dbg.breakpoints[ABS] = [{ line: 4 }, { line: 5, condition: "c" }];
  expect(code(await request("debug.breakpoints", { path: "a.py", lines: [{ line: 4 }, { line: 4 }] }))).toBe("ok");
  expect(dbg.breakpoints[ABS].map((b) => [b.line, b.condition])).toEqual([[4, undefined]]);
});

// ---------------------------------------------------------------- review: conditions and watches

test("guests without `debug` get markers without conditions", async () => {
  dbg.breakpoints[ABS] = [{ line: 2, condition: "secret" }];
  h.collab.participants[1] = guest(["edit"]);
  for (const fn of h.handlers) await fn(PEER, { t: "rpc.sub", topic: "debug.bps" });
  for (const fn of h.handlers) await fn(PEER, { t: "rpc.sub", topic: "debug.bpsFull" });
  await remote.publishDebugNow();
  await tick();
  const toGuest = JSON.stringify(h.sent.filter((s) => s.peer === PEER && s.msg.t === "rpc.pub"));
  expect(toGuest).toContain('"line":2');
  expect(toGuest).not.toContain("secret");
});

test("guests with `debug` get the conditions, and lose them on revoke", async () => {
  dbg.breakpoints[ABS] = [{ line: 2, condition: "visible" }];
  for (const fn of h.handlers) await fn(PEER, { t: "rpc.sub", topic: "debug.bpsFull" });
  await remote.publishDebugNow();
  await tick();
  expect(JSON.stringify(h.sent.filter((s) => s.msg.topic === "debug.bpsFull"))).toContain("visible");
  asGuest();
  await fromHost({ t: "rpc.pub", topic: "debug.bps", payload: { files: { "a.py": [{ line: 2 }] } } });
  await fromHost({ t: "rpc.pub", topic: "debug.bpsFull", payload: { files: { "a.py": [{ line: 2, condition: "visible" }] } } });
  expect(dbg.breakpoints["collab:a.py"][0].condition).toBe("visible");
  await fromHost({ t: "rpc.pub", topic: "debug.bpsFull", payload: null });
  expect(dbg.breakpoints["collab:a.py"][0].condition).toBeUndefined();
});

const stoppedAt = (gen: number) => ({
  status: "stopped", label: "", stopReason: "step", actor: "", gen, threads: [], threadId: 1,
  frames: [{ id: 10, name: "f", rel: null, line: 1, column: 1, subtle: false }], frameId: 10, scopes: [], scopesVersion: gen, exec: null,
});

test("fast stepping sends one batched watch request for the latest stop", async () => {
  asGuest();
  dbg.watches = ["a", "b", "c"].map((expr) => ({ expr, value: "", ref: 0, children: null, expanded: false }));
  for (let gen = 100; gen < 110; gen++) await fromHost({ t: "rpc.pub", topic: "debug.state", payload: stoppedAt(gen) });
  await new Promise((r) => setTimeout(r, 180));
  const reqs = h.sent.filter((s) => s.msg.t === "rpc.req" && String(s.msg.method).startsWith("debug.") && /watches|evaluate/.test(s.msg.method));
  expect(reqs).toHaveLength(1);
  expect(reqs[0].msg.method).toBe("debug.watches");
  expect(reqs[0].msg.params.expressions).toEqual(["a", "b", "c"]);
  await fromHost({ t: "rpc.res", id: reqs[0].msg.id, ok: true, result: { results: [{ value: "1", ref: 0 }, { error: "nope" }, { value: "3", ref: 0 }] } });
  expect(dbg.watches.map((w) => [w.value, !!w.error])).toEqual([["1", false], ["nope", true], ["3", false]]);
  dbg.watches = [];
});

test("the watch batch is one call on the host, bounded and checked against the frame", async () => {
  stoppedHost();
  h.debug.evaluate = vi.fn(async (expression: string) => ({ result: `<${expression}>`, variablesReference: 0 }));
  const r = await request("debug.watches", { frameId: 10, expressions: ["a", "b"] });
  expect(r.result.results).toEqual([{ value: "<a>", ref: 0 }, { value: "<b>", ref: 0 }]);
  expect(code(await request("debug.watches", { frameId: 999, expressions: ["a"] }))).toBe("stale");
  const many = Array.from({ length: mirror.DEBUG_LIMITS.watches + 1 }, () => "x");
  expect(code(await request("debug.watches", { frameId: 10, expressions: many }))).toBe("invalid_params");
});
