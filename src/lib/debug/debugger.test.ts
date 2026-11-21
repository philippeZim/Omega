import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

// ---------------------------------------------------------------- heavy imports, stubbed

const m = vi.hoisted(() => ({
  tab: { id: "t1", path: "/p/main.py", dirty: false } as { id: string; path: string | null; dirty: boolean },
  plan: null as any,
  openFile: null as any,
  toast: null as any,
  runCommand: null as any,
  /** Holds proc_spawn open until resolved. */
  spawnGate: null as Promise<unknown> | null,
  /** proc_spawn fails with this message. */
  spawnFail: null as string | null,
  /** proc_connect makes the connecting session the fake adapter's. */
  adoptConnect: false,
  /** Holds a proc_connect that isn't adopted open until resolved. */
  connectGate: null as Promise<unknown> | null,
  /** proc_send to this id fails, as it does for a killed adapter. */
  sendFail: null as string | null,
}));

vi.mock("../state.svelte", () => ({
  app: { tabs: [], root: "/p", mode: "code" },
  activeTab: () => m.tab,
  openFile: (...a: any[]) => m.openFile(...a),
  save: async () => {},
  setMode: () => {},
  inRoot: (p: string, root: string | null) => !!root && (p === root || p.startsWith(root.replace(/\/?$/, "/"))),
}));
vi.mock("../ui.svelte", () => ({ ui: { toast: (...a: any[]) => m.toast(...a), confirm: async () => true } }));
vi.mock("../editor", () => ({ getView: () => null }));
vi.mock("../terminal.svelte", () => ({
  runCommand: (...a: any[]) => m.runCommand(...a),
  shellQuote: (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s}'`),
}));
vi.mock("../layout.svelte", () => ({ showView: () => {} }));
vi.mock("../collab/collab.svelte", () => ({ collab: { role: null, status: "idle" } }));
vi.mock("./adapters", () => ({ planFor: async () => m.plan }));
vi.mock("./editorExt", () => ({ debugRefresh: { of: () => null } }));

// ---------------------------------------------------------------- scripted fake adapter

type Handler = (args: any, req: any) => any;

class FakeAdapter {
  id: string | null = null;
  requests: any[] = [];
  /** command → body (or function returning the body; throw to fail the request). */
  replies: Record<string, Handler> = {};
  /** Called after the response for a command was sent. */
  after: Record<string, (req: any) => void> = {};
  noReply = new Set<string>();

  event(event: string, body: any = {}) {
    return emit("proc-msg", { id: this.id, msg: JSON.stringify({ seq: 1000, type: "event", event, body }) });
  }
  exit() {
    return emit("proc-exit", this.id);
  }
  commands() {
    return this.requests.map((r) => r.command);
  }
  last(command: string) {
    return [...this.requests].reverse().find((r) => r.command === command);
  }

  onSend(raw: string) {
    const req = JSON.parse(raw);
    if (req.type !== "request") return;
    this.requests.push(req);
    if (this.noReply.has(req.command)) return;
    setTimeout(async () => {
      let res: any;
      try {
        const h = this.replies[req.command];
        res = { success: true, body: h ? h(req.arguments ?? {}, req) : {} };
      } catch (e) {
        res = { success: false, message: String(e) };
      }
      await emit("proc-msg", { id: this.id, msg: JSON.stringify({ seq: 2000, type: "response", request_seq: req.seq, command: req.command, ...res }) });
      this.after[req.command]?.(req);
    }, 0);
  }
}

let fake: FakeAdapter;
let ipc: [string, any][];
let D: typeof import("./debugger.svelte");
let S: typeof import("./store.svelte");

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  fake = new FakeAdapter();
  ipc = [];
  m.tab = { id: "t1", path: "/p/main.py", dirty: false };
  m.plan = { label: "Python", cwd: "/p", adapter: { kind: "stdio", cmd: "python", args: ["-m", "debugpy.adapter"] }, launch: { type: "python", request: "launch", program: "/p/main.py" } };
  m.openFile = vi.fn(async () => {});
  m.toast = vi.fn();
  m.runCommand = vi.fn();
  m.spawnGate = null;
  m.spawnFail = null;
  m.adoptConnect = false;
  m.connectGate = null;
  m.sendFail = null;
  mockIPC(
    (cmd, args: any) => {
      ipc.push([cmd, args]);
      if (cmd === "proc_spawn") {
        fake.id = args.id;
        if (m.spawnFail) return Promise.reject(new Error(m.spawnFail));
        if (m.spawnGate) return m.spawnGate;
      }
      if (cmd === "proc_connect") {
        if (m.adoptConnect) fake.id = args.id;
        else if (m.connectGate) return m.connectGate;
      }
      if (cmd === "proc_send" && args.id === m.sendFail) return Promise.reject(new Error("proc:not_connected"));
      if (cmd === "proc_send" && args.id === fake.id) fake.onSend(args.msg);
      return null;
    },
    { shouldMockEvents: true },
  );
  vi.resetModules();
  S = await import("./store.svelte");
  D = await import("./debugger.svelte");
  await settle();

  let varsCall = 0;
  fake.replies = {
    initialize: () => ({ supportsConfigurationDoneRequest: true, supportsSetVariable: true, exceptionBreakpointFilters: [{ filter: "uncaught", default: true }, { filter: "raised" }] }),
    setBreakpoints: (a) => ({ breakpoints: a.breakpoints.map((b: any) => ({ verified: b.line !== 99, line: b.line })) }),
    threads: () => ({ threads: [{ id: 1, name: "MainThread" }] }),
    stackTrace: () => ({
      stackFrames: [
        { id: 10, name: "runpy", line: 5, column: 1, source: { path: "/usr/lib/runpy.py", presentationHint: "deemphasize" } },
        { id: 11, name: "main", line: 3, column: 2, source: { path: "/p/main.py" } },
        { id: 12, name: "<frozen>", line: 0, column: 0 },
      ],
    }),
    scopes: () => ({ scopes: [{ name: "Locals", variablesReference: 100 }, { name: "Globals", variablesReference: 200, expensive: true }] }),
    variables: (a) => {
      if (a.variablesReference !== 100) return { variables: [] };
      varsCall++;
      return {
        variables: [
          { name: "x", value: varsCall === 1 ? "1" : "2", type: "int", variablesReference: 0, evaluateName: "x" },
          { name: "y", value: "'a'", type: "str", variablesReference: 0 },
          { name: "obj", value: "Obj()", variablesReference: 300 },
        ],
      };
    },
    evaluate: (a) => ({ result: `<${a.expression}>`, variablesReference: 0 }),
  };
  // The program hits a breakpoint once configuration is done.
  fake.after.configurationDone = () => fake.event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
  fake.after.initialize = () => fake.event("initialized");
});

async function startAndStop() {
  S.dbg.breakpoints["/p/main.py"] = [{ line: 3 }, { line: 99, condition: "x > 1" }];
  await D.startDebugging();
  await vi.waitFor(() => {
    expect(S.dbg.status).toBe("stopped");
    expect(S.dbg.scopes[0]?.children?.length).toBe(3);
  });
}

describe("debugger controller with a fake adapter", () => {
  test("initialize → launch → initialized → configure → stopped loads threads, frames and variables", async () => {
    await startAndStop();

    expect(ipc.find(([c]) => c === "proc_spawn")?.[1]).toMatchObject({ cmd: "python", args: ["-m", "debugpy.adapter"], cwd: "/p" });
    const cmds = fake.commands();
    expect(cmds.slice(0, 2)).toEqual(["initialize", "launch"]);
    expect(cmds.indexOf("setBreakpoints")).toBeLessThan(cmds.indexOf("configurationDone"));
    expect(cmds.indexOf("setExceptionBreakpoints")).toBeLessThan(cmds.indexOf("configurationDone"));
    expect(cmds.slice(cmds.indexOf("configurationDone") + 1)).toEqual(["threads", "stackTrace", "scopes", "variables"]);

    expect(fake.last("initialize").arguments).toMatchObject({ adapterID: "python", linesStartAt1: true, supportsRunInTerminalRequest: true });
    expect(fake.last("launch").arguments).toEqual(m.plan.launch);
    expect(fake.last("setBreakpoints").arguments).toMatchObject({
      source: { path: "/p/main.py", name: "main.py" },
      breakpoints: [{ line: 3 }, { line: 99, condition: "x > 1" }],
      lines: [3, 99],
    });
    expect(fake.last("setExceptionBreakpoints").arguments).toEqual({ filters: ["uncaught"] });
    expect(S.dbg.breakpoints["/p/main.py"].map((b) => b.verified)).toEqual([true, false]);

    expect(S.dbg.stopReason).toBe("breakpoint");
    expect(S.dbg.threads).toEqual([{ id: 1, name: "MainThread" }]);
    expect(S.dbg.threadId).toBe(1);
    expect(S.dbg.frames).toEqual([
      { id: 10, name: "runpy", path: "/usr/lib/runpy.py", line: 5, column: 1, subtle: true },
      { id: 11, name: "main", path: "/p/main.py", line: 3, column: 2, subtle: false },
      { id: 12, name: "<frozen>", path: null, line: 0, column: 0, subtle: true },
    ]);
    // The first non-subtle frame is selected.
    expect(S.dbg.frameId).toBe(11);
    expect(fake.last("scopes").arguments).toEqual({ frameId: 11 });
    expect(S.dbg.exec).toEqual({ path: "/p/main.py", line: 3 });
    expect(m.openFile).not.toHaveBeenCalled(); // already the active tab

    // Only the first cheap scope is expanded.
    expect(S.dbg.scopes.map((s) => [s.name, s.ref, s.expanded])).toEqual([["Locals", 100, true], ["Globals", 200, false]]);
    expect(fake.requests.filter((r) => r.command === "variables").map((r) => r.arguments.variablesReference)).toEqual([100]);
    expect(S.dbg.scopes[0].children!.map((v) => [v.name, v.value, v.type, v.ref, v.parentRef])).toEqual([
      ["x", "1", "int", 0, 100],
      ["y", "'a'", "str", 0, 100],
      ["obj", "Obj()", undefined, 300, 100],
    ]);
    // Nothing is "changed" on the first stop.
    expect(S.dbg.scopes[0].children!.some((v) => v.changed)).toBe(false);
  });

  test("restart stops and starts a new session even if the adapter supports restart (#101)", async () => {
    const init = fake.replies.initialize;
    fake.replies.initialize = (a, r) => ({ ...init(a, r), supportsRestartRequest: true });
    await startAndStop();
    const first = fake.id;
    await D.restartDebugging();
    expect(fake.commands()).not.toContain("restart");
    expect(fake.commands()).toContain("disconnect");
    expect(ipc.some(([c, a]) => c === "proc_kill" && a.id === first)).toBe(true);
    await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
    expect(fake.id).not.toBe(first);
    expect(ipc.filter(([c]) => c === "proc_spawn").length).toBe(2);
  });

  test("only breakpoints of the open project are sent to the adapter (#104)", async () => {
    S.dbg.breakpoints["/other/main.rs"] = [{ line: 8 }];
    S.dbg.breakpoints["/p2/x.py"] = [{ line: 1 }];
    await startAndStop();
    const paths = fake.requests.filter((r) => r.command === "setBreakpoints").map((r) => r.arguments.source.path);
    expect(paths).toEqual(["/p/main.py"]);
    expect(D.inProject("/p/sub/a.py")).toBe(true);
    expect(D.inProject("/other/main.rs")).toBe(false);
  });

  test("selecting a frame in another file opens it", async () => {
    await startAndStop();
    await D.selectFrame(S.dbg.frames[0]);
    expect(m.openFile).toHaveBeenCalledWith("/usr/lib/runpy.py");
    expect(S.dbg.exec).toEqual({ path: "/usr/lib/runpy.py", line: 5 });
    await D.selectFrame(S.dbg.frames[2]);
    expect(S.dbg.exec).toBeNull();
  });

  test("markChanged flags values that differ from the previous stop", async () => {
    await startAndStop();
    fake.after.continue = () => fake.event("stopped", { reason: "step", threadId: 1 });
    await D.continueRun();
    expect(fake.last("continue").arguments).toEqual({ threadId: 1 });
    await vi.waitFor(() => {
      expect(S.dbg.stopReason).toBe("step");
      expect(S.dbg.scopes[0]?.children?.length).toBe(3);
    });
    const vars = Object.fromEntries(S.dbg.scopes[0].children!.map((v) => [v.name, v]));
    expect(vars.x.value).toBe("2");
    expect(vars.x.changed).toBe(true);
    expect(vars.y.changed).toBe(false);
    expect(vars.obj.changed).toBe(false);
    expect(S.dbg.scopes[0].changed).toBe(false);
  });

  test("stepping is ignored unless stopped; continued event sets running", async () => {
    await startAndStop();
    await fake.event("continued", { threadId: 1 });
    expect(S.dbg.status).toBe("running");
    expect(S.dbg.exec).toBeNull();
    const n = fake.requests.length;
    await D.stepOver();
    expect(fake.requests.length).toBe(n);
  });

  // Regression: step() set status "running" before sending the request and never restored it
  // when the adapter rejected it, so every step/continue button was ignored afterwards.
  test("a rejected step request leaves the session stopped", async () => {
    await startAndStop();
    const exec = { ...S.dbg.exec! };
    fake.replies.next = () => { throw new Error("cannot step here"); };
    await D.stepOver();
    expect(S.dbg.console.some((l) => l.kind === "error" && l.text.includes("cannot step here"))).toBe(true);
    expect(S.dbg.status).toBe("stopped");
    expect(S.dbg.exec).toEqual(exec);
    // Stepping works again.
    delete fake.replies.next;
    await D.stepOver();
    expect(fake.requests.filter((r) => r.command === "next").length).toBe(2);
  });

  test("a rejected step does not overwrite a continued event that arrived first", async () => {
    await startAndStop();
    fake.noReply.add("continue");
    const done = D.continueRun();
    await vi.waitFor(() => expect(fake.last("continue")).toBeTruthy());
    const v = S.dbg.version;
    await fake.event("continued", { threadId: 1 });
    expect(S.dbg.version).toBeGreaterThan(v); // the continued event was handled first
    await emit("proc-msg", {
      id: fake.id,
      msg: JSON.stringify({ seq: 3000, type: "response", request_seq: fake.last("continue").seq, command: "continue", success: false, message: "late failure" }),
    });
    await done;
    expect(S.dbg.console.some((l) => l.kind === "error" && l.text.includes("late failure"))).toBe(true);
    expect(S.dbg.status).toBe("running");
    expect(S.dbg.exec).toBeNull();
  });

  test("a rejected step keeps an execution line set in the meantime", async () => {
    await startAndStop();
    fake.noReply.add("next");
    const done = D.stepOver();
    await vi.waitFor(() => expect(fake.last("next")).toBeTruthy());
    await D.selectFrame(S.dbg.frames[0]);
    await emit("proc-msg", {
      id: fake.id,
      msg: JSON.stringify({ seq: 3000, type: "response", request_seq: fake.last("next").seq, command: "next", success: false, message: "nope" }),
    });
    await done;
    expect(S.dbg.status).toBe("stopped");
    expect(S.dbg.exec).toEqual({ path: "/usr/lib/runpy.py", line: 5 });
  });

  test("a timed-out step stays running so Pause still works", async () => {
    await startAndStop();
    fake.noReply.add("next");
    vi.useFakeTimers();
    try {
      const done = D.stepOver();
      await vi.advanceTimersByTimeAsync(30_001);
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(S.dbg.console.some((l) => l.kind === "error" && l.text.includes("next"))).toBe(true);
    expect(S.dbg.status).toBe("running");
    await D.pause();
    expect(fake.last("pause")).toBeTruthy();
  });

  test("watches and REPL evaluate in the selected frame", async () => {
    await startAndStop();
    D.addWatch("  x + 1 ");
    await vi.waitFor(() => expect(S.dbg.watches[0]?.value).toBe("<x + 1>"));
    expect(fake.last("evaluate").arguments).toEqual({ expression: "x + 1", frameId: 11, context: "watch" });
    expect(JSON.parse(localStorage.getItem("watches")!)).toEqual(["x + 1"]);

    await D.replEval("len(y)");
    expect(S.dbg.console.slice(-2)).toEqual([
      { text: "› len(y)", kind: "input" },
      { text: "<len(y)>", kind: "result" },
    ]);
    expect(await D.hoverValue("y")).toBe("<y>");
  });

  test("a REPL assignment refreshes Variables and keeps expanded nodes open (#103)", async () => {
    await startAndStop();
    await D.toggleNode(S.dbg.scopes[0].children![2]); // expand obj
    fake.replies.variables = (a) => ({
      variables:
        a.variablesReference === 100
          ? [{ name: "x", value: "42", type: "int", variablesReference: 0 }, { name: "obj", value: "Obj()", variablesReference: 300 }]
          : a.variablesReference === 300 ? [{ name: "a", value: "1", variablesReference: 0 }] : [],
    });
    await D.replEval("x = 42");
    const vars = Object.fromEntries(S.dbg.scopes[0].children!.map((v) => [v.name, v]));
    expect(vars.x).toMatchObject({ value: "42", changed: true });
    expect(vars.obj.expanded).toBe(true);
    expect(vars.obj.children!.map((c) => c.name)).toEqual(["a"]);
    expect(S.dbg.scopes[1].expanded).toBe(false);
  });

  test("setVariable updates the node and marks it changed", async () => {
    await startAndStop();
    fake.replies.setVariable = (a) => ({ value: `${a.value}!` });
    const x = S.dbg.scopes[0].children![0];
    await D.setVariable(x, "5");
    expect(fake.last("setVariable").arguments).toEqual({ variablesReference: 100, name: "x", value: "5" });
    expect(S.dbg.scopes[0].children![0]).toMatchObject({ value: "5!", changed: true });
  });

  test("expanding a structured variable fetches its children", async () => {
    await startAndStop();
    fake.replies.variables = (a) => ({ variables: a.variablesReference === 300 ? [{ name: "a", value: "1", variablesReference: 0 }] : [] });
    const obj = S.dbg.scopes[0].children![2];
    await D.toggleNode(obj);
    expect(obj.expanded).toBe(true);
    expect(obj.children!.map((c) => [c.name, c.parentRef])).toEqual([["a", 300]]);
    await D.toggleNode(obj);
    expect(obj.expanded).toBe(false);
    expect(fake.requests.filter((r) => r.command === "variables" && r.arguments.variablesReference === 300).length).toBe(1);
  });

  test("output events go to the debug console", async () => {
    await startAndStop();
    await fake.event("output", { category: "stdout", output: "hello\n" });
    await fake.event("output", { category: "stderr", output: "oops\n" });
    await fake.event("output", { category: "telemetry", output: "ignored" });
    expect(S.dbg.console.slice(-2)).toEqual([
      { text: "hello", kind: "out" },
      { text: "oops", kind: "err" },
    ]);
  });

  test("stopping on an exception logs type and message from exceptionInfo (#107)", async () => {
    const init = fake.replies.initialize;
    fake.replies.initialize = (a, r) => ({ ...init(a, r), supportsExceptionInfoRequest: true });
    fake.replies.exceptionInfo = () => ({ exceptionId: "KeyError", description: "'zz'", breakMode: "unhandled" });
    fake.after.configurationDone = () => fake.event("stopped", { reason: "exception", text: "KeyError", threadId: 1 });
    await D.startDebugging();
    await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
    await vi.waitFor(() => expect(S.dbg.console.filter((l) => l.kind === "error").map((l) => l.text)).toEqual(["Exception: KeyError: 'zz'"]));
    expect(fake.last("exceptionInfo").arguments).toEqual({ threadId: 1 });
  });

  test("without exceptionInfo support the stopped event's text and description are used", async () => {
    fake.after.configurationDone = () => fake.event("stopped", { reason: "exception", text: "panic", description: "index out of bounds", threadId: 1 });
    await D.startDebugging();
    await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
    expect(fake.commands()).not.toContain("exceptionInfo");
    await vi.waitFor(() => expect(S.dbg.console.filter((l) => l.kind === "error").map((l) => l.text)).toEqual(["Exception: panic: index out of bounds"]));
  });

  test("runInTerminal reverse request runs the command in the Run tab and answers success", async () => {
    await startAndStop();
    const sends: any[] = [];
    const prev = fake.onSend.bind(fake);
    fake.onSend = (raw) => { sends.push(JSON.parse(raw)); prev(raw); };
    await emit("proc-msg", {
      id: fake.id,
      msg: JSON.stringify({ seq: 77, type: "request", command: "runInTerminal", arguments: { cwd: "/p", args: ["python", "my file.py"], env: { A: "1", B: null } } }),
    });
    await vi.waitFor(() => expect(sends.find((s) => s.type === "response")).toBeTruthy());
    expect(m.runCommand).toHaveBeenCalledWith("env A=1 -u B python 'my file.py'", "/p", "Debug: Python", false);
    expect(sends.find((s) => s.type === "response")).toMatchObject({ request_seq: 77, command: "runInTerminal", success: true });
  });

  test("proc-exit of the adapter cleans up the store", async () => {
    await startAndStop();
    S.dbg.watches.push({ expr: "x", value: "1", ref: 5, children: [], expanded: true });
    await fake.exit();
    expect(S.dbg.status).toBe("terminated");
    expect(S.dbg.threads).toEqual([]);
    expect(S.dbg.frames).toEqual([]);
    expect(S.dbg.scopes).toEqual([]);
    expect(S.dbg.frameId).toBeNull();
    expect(S.dbg.exec).toBeNull();
    expect(S.dbg.watches.at(-1)).toMatchObject({ value: "", children: null });
    // Breakpoints survive a session.
    expect(S.dbg.breakpoints["/p/main.py"].length).toBe(2);
    // No session any more: stepping does nothing, evaluate rejects.
    await expect(D.evaluate("x", "repl")).rejects.toThrow();
  });

  test("terminated event disconnects and kills the adapter", async () => {
    await startAndStop();
    await fake.event("terminated");
    await vi.waitFor(() => expect(S.dbg.status).toBe("terminated"));
    expect(fake.last("disconnect").arguments).toEqual({ terminateDebuggee: true, restart: false });
    expect(ipc.some(([c, a]) => c === "proc_kill" && a.id === fake.id)).toBe(true);
    expect(S.dbg.frames).toEqual([]);
  });

  test("a failing launch logs the error and ends the session", async () => {
    fake.replies.launch = () => { throw new Error("program not found"); };
    fake.after.initialize = () => {}; // no initialized event
    await D.startDebugging();
    await vi.waitFor(() => expect(S.dbg.status).toBe("terminated"));
    expect(S.dbg.console.some((l) => l.kind === "error" && l.text.includes("program not found"))).toBe(true);
  });

  test("planFor failure ends in terminated without spawning", async () => {
    m.plan = null;
    vi.doMock("./adapters", () => ({ planFor: async () => { throw new Error("no debugger for .xyz"); } }));
    vi.resetModules();
    S = await import("./store.svelte");
    D = await import("./debugger.svelte");
    await D.startDebugging();
    expect(S.dbg.status).toBe("terminated");
    expect(S.dbg.console.at(-1)).toEqual({ text: "no debugger for .xyz", kind: "error" });
    expect(ipc.some(([c]) => c === "proc_spawn")).toBe(false);
    vi.doMock("./adapters", () => ({ planFor: async () => m.plan })); // back to the file's own mock
  });

  test("without a saved file it only toasts", async () => {
    m.tab = { id: "t2", path: null, dirty: false };
    await D.startDebugging();
    expect(m.toast).toHaveBeenCalledWith(expect.any(String), "error");
    expect(S.dbg.status).toBe("idle");
  });
});

describe("a stop or a second start during a start", () => {
  const deferred = <T = void>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const spawns = () => ipc.filter(([c]) => c === "proc_spawn").length;
  // The fake adapter answers on a timer: let the last replies land before the environment goes.
  afterEach(() => new Promise((r) => setTimeout(r, 10)));

  test("stop while the plan is prepared launches nothing", async () => {
    const plan = m.plan;
    const gate = deferred<any>();
    m.plan = gate.promise;
    const start = D.startDebugging();
    await vi.waitFor(() => expect(S.dbg.status).toBe("starting"));
    await D.stopDebugging();
    gate.resolve(plan);
    await start;
    await settle();
    expect(spawns()).toBe(0);
    expect(S.dbg.status).toBe("terminated");
  });

  test("two overlapping starts run one adapter", async () => {
    const plan = m.plan;
    const gate = deferred<any>();
    m.plan = gate.promise;
    const first = D.startDebugging();
    const second = D.startDebugging();
    gate.resolve(plan);
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
    expect(spawns()).toBe(1);
    expect(fake.commands().filter((c) => c === "launch")).toHaveLength(1);
  });

  test("stop while the adapter is spawning kills it and sends no launch", async () => {
    const gate = deferred<unknown>();
    m.spawnGate = gate.promise;
    const start = D.startDebugging();
    await vi.waitFor(() => expect(spawns()).toBe(1));
    await D.stopDebugging();
    const killsBefore = ipc.filter(([c, a]) => c === "proc_kill" && a.id === fake.id).length;
    gate.resolve(null);
    await start;
    await settle();
    expect(ipc.filter(([c, a]) => c === "proc_kill" && a.id === fake.id).length).toBeGreaterThan(killsBefore);
    expect(fake.commands()).not.toContain("launch");
    expect(S.dbg.status).toBe("terminated");
  });

  test("a stop during a restart doesn't start it again", async () => {
    await startAndStop();
    fake.noReply.add("disconnect");
    const restart = D.hostDebug.restart("/p/main.py", "Bob");
    await vi.waitFor(() => expect(fake.commands()).toContain("disconnect"));
    const spawned = spawns();
    const stop = D.stopLocal();
    await fake.exit();
    await Promise.all([restart, stop]);
    await settle();
    expect(spawns()).toBe(spawned);
  });

  describe("the adapter sends terminated while it is disconnected", () => {
    const launches = () => fake.commands().filter((c) => c === "launch").length;
    const disconnects = () => fake.commands().filter((c) => c === "disconnect").length;
    const terminateOnDisconnect = () => {
      fake.replies.disconnect = () => {
        void fake.event("terminated");
        return {};
      };
    };
    /** Holds the disconnect open, with `terminated` already delivered. */
    async function holdDisconnect() {
      fake.noReply.add("disconnect");
      await vi.waitFor(() => expect(fake.commands()).toContain("disconnect"));
      await fake.event("terminated");
    }
    const newSessionStopped = async (first: string | null) => {
      await vi.waitFor(() => {
        expect(fake.id).not.toBe(first);
        expect(S.dbg.status).toBe("stopped");
      });
    };

    test("host restart ends the old session and starts one new session at the breakpoint", async () => {
      await startAndStop();
      const first = fake.id;
      terminateOnDisconnect();
      await D.restartDebugging();
      await newSessionStopped(first);
      expect(spawns()).toBe(2);
      expect(launches()).toBe(2);
      expect(disconnects()).toBe(1);
      expect(ipc.some(([c, a]) => c === "proc_kill" && a.id === first)).toBe(true);
      expect(fake.requests.filter((r) => r.command === "setBreakpoints")).toHaveLength(2);
      expect(fake.last("launch").arguments.program).toBe("/p/main.py");
      expect(S.dbg.stopReason).toBe("breakpoint");
      expect(D.hostDebug.starting()).toBe(false);
    });

    test("guest restart starts one new session for the same file, under the guest's name", async () => {
      await D.hostDebug.start("/p/main.py", "Bob");
      await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
      const first = fake.id;
      terminateOnDisconnect();
      await D.hostDebug.restart("/p/main.py", "Bob");
      await newSessionStopped(first);
      expect(spawns()).toBe(2);
      expect(disconnects()).toBe(1);
      expect(S.dbg.actor).toBe("Bob");
      expect(D.hostDebug.planFile()).toBe("/p/main.py");
      expect(m.openFile).not.toHaveBeenCalled();
    });

    test("a Stop during a restart wins", async () => {
      await startAndStop();
      const restart = D.restartDebugging();
      await holdDisconnect();
      const stop = D.stopDebugging();
      await fake.exit();
      await Promise.all([restart, stop]);
      await settle();
      expect(spawns()).toBe(1);
      expect(S.dbg.status).toBe("terminated");
      expect(D.hostDebug.starting()).toBe(false);
    });

    test("a Start during a restart leaves exactly one new session", async () => {
      await startAndStop();
      const first = fake.id;
      fake.noReply.add("disconnect");
      const restart = D.restartDebugging();
      await vi.waitFor(() => expect(fake.commands()).toContain("disconnect"));
      const start = D.startDebugging();
      await fake.event("terminated"); // must not cancel the Start that is waiting for the teardown
      fake.noReply.delete("disconnect");
      await fake.exit();
      await Promise.all([restart, start]);
      await newSessionStopped(first);
      expect(spawns()).toBe(2);
      expect(launches()).toBe(2);
    });

    test("Start on a running session replaces it", async () => {
      await startAndStop();
      const first = fake.id;
      terminateOnDisconnect();
      await D.startDebugging();
      await newSessionStopped(first);
      expect(spawns()).toBe(2);
      expect(disconnects()).toBe(1);
    });

    test("a guest's Start on a running session replaces it", async () => {
      await startAndStop();
      const first = fake.id;
      terminateOnDisconnect();
      await D.hostDebug.start("/p/main.py", "Bob");
      await newSessionStopped(first);
      expect(spawns()).toBe(2);
      expect(S.dbg.actor).toBe("Bob");
    });

    test("a session that ends on its own is cleaned up and not started again", async () => {
      await startAndStop();
      await fake.event("terminated");
      await vi.waitFor(() => expect(S.dbg.status).toBe("terminated"));
      await settle();
      expect(disconnects()).toBe(1);
      expect(ipc.some(([c, a]) => c === "proc_kill" && a.id === fake.id)).toBe(true);
      expect(spawns()).toBe(1);
      expect(S.dbg.frames).toEqual([]);
    });

    test("a late terminated from the old session leaves the new one alone", async () => {
      await startAndStop();
      const first = fake.id;
      await D.restartDebugging();
      await newSessionStopped(first);
      const n = disconnects();
      await emit("proc-msg", { id: first, msg: JSON.stringify({ seq: 5000, type: "event", event: "terminated", body: {} }) });
      await settle();
      expect(S.dbg.status).toBe("stopped");
      expect(disconnects()).toBe(n);
    });

    test("a guest's restart can still be cancelled while the old session closes", async () => {
      await D.hostDebug.start("/p/main.py", "Bob");
      await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
      const restart = D.hostDebug.restart("/p/main.py", "Bob");
      await holdDisconnect();
      expect(D.hostDebug.starting()).toBe(true);
      const cancel = D.hostDebug.cancelStart();
      await fake.exit();
      await Promise.all([restart, cancel]);
      await settle();
      expect(spawns()).toBe(1);
      expect(D.hostDebug.starting()).toBe(false);
    });

    test("a guest's restart doesn't launch a plan forgotten while the old session closes", async () => {
      await D.hostDebug.start("/p/main.py", "Bob");
      await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
      const restart = D.hostDebug.restart("/p/main.py", "Bob");
      await holdDisconnect();
      D.hostDebug.forgetGuestPlan();
      await fake.exit();
      await restart;
      await settle();
      expect(spawns()).toBe(1);
      expect(D.hostDebug.starting()).toBe(false);
    });
  });

  describe("a restart whose new start fails", () => {
    const failing = (message: string) => ({ then: (_ok: unknown, fail: (e: Error) => void) => fail(new Error(message)) });
    const settled = () => {
      expect(S.dbg.status).toBe("terminated");
      expect(D.hostDebug.starting()).toBe(false);
      expect(D.hostDebug.closing()).toBe(false);
      expect(S.dbg.actor).toBe("");
    };
    /** After the failure, the next Start works normally. */
    async function startsAgain(plan: unknown) {
      m.plan = plan;
      m.spawnFail = null;
      const before = fake.id;
      await D.startDebugging();
      await vi.waitFor(() => {
        expect(fake.id).not.toBe(before);
        expect(S.dbg.status).toBe("stopped");
      });
    }
    const endOnDisconnect = () => {
      fake.replies.disconnect = () => {
        void fake.event("terminated");
        return {};
      };
    };

    test.each([["host"], ["guest"]])("%s: a declined install prompt ends in terminated", async (who) => {
      await startAndStop();
      endOnDisconnect();
      const plan = m.plan;
      m.plan = failing("debugpy is required");
      if (who === "host") await D.restartDebugging();
      else await D.hostDebug.restart("/p/main.py", "Bob");
      settled();
      expect(spawns()).toBe(1);
      expect(S.dbg.console.at(-1)).toEqual({ text: "debugpy is required", kind: "error" });
      await startsAgain(plan);
    });

    test.each([["host"], ["guest"]])("%s: a failed spawn ends in terminated", async (who) => {
      await startAndStop();
      endOnDisconnect();
      const plan = m.plan;
      m.spawnFail = "cannot spawn adapter";
      if (who === "host") await D.restartDebugging();
      else await D.hostDebug.restart("/p/main.py", "Bob");
      await vi.waitFor(settled);
      expect(S.dbg.console.some((l) => l.kind === "error" && l.text.includes("cannot spawn adapter"))).toBe(true);
      await startsAgain(plan);
    });

    test("a failing file open doesn't leave the restart in progress", async () => {
      await startAndStop();
      endOnDisconnect();
      m.tab = { id: "t2", path: "/p/other.py", dirty: false };
      m.openFile = vi.fn(async () => {
        throw new Error("cannot open");
      });
      await expect(D.restartDebugging()).rejects.toThrow("cannot open");
      settled();
    });
  });

  describe("reverse requests and closed sessions", () => {
    const portPlan = () => ({ ...m.plan, adapter: { kind: "port", port: 4711 } });
    const connects = () => ipc.filter(([c]) => c === "proc_connect").length;
    let nextSeq = 700;
    /** Sends a reverse request and returns the response the session answers with. */
    async function reverse(id: string, command: string, args: unknown) {
      const seq = nextSeq++;
      await emit("proc-msg", { id, msg: JSON.stringify({ seq, type: "request", command, arguments: args }) });
      return vi.waitFor(() => {
        const res = ipc
          .filter(([c, a]) => c === "proc_send" && a.id === id)
          .map(([, a]) => JSON.parse(a.msg))
          .find((x) => x.type === "response" && x.request_seq === seq);
        expect(res).toBeTruthy();
        return res;
      });
    }
    const terminal = { cwd: "/p", args: ["python", "main.py"], env: {} };
    const child = { request: "launch", configuration: { name: "child", type: "pwa-node" } };

    test("runInTerminal from a session being closed starts nothing and gets an error", async () => {
      await startAndStop();
      fake.noReply.add("disconnect");
      const stop = D.stopLocal();
      await vi.waitFor(() => expect(fake.commands()).toContain("disconnect"));
      expect(D.hostDebug.closing()).toBe(true);
      expect(await reverse(fake.id!, "runInTerminal", terminal)).toMatchObject({ success: false, command: "runInTerminal" });
      expect(m.runCommand).not.toHaveBeenCalled();
      await fake.exit();
      await stop;
      expect(D.hostDebug.closing()).toBe(false);
    });

    test("runInTerminal from a closed session starts nothing and gets an error", async () => {
      await startAndStop();
      await D.stopLocal();
      expect(await reverse(fake.id!, "runInTerminal", terminal)).toMatchObject({ success: false });
      expect(m.runCommand).not.toHaveBeenCalled();
    });

    test("startDebugging from a session being closed creates no child", async () => {
      m.adoptConnect = true;
      m.plan = portPlan();
      await startAndStop();
      m.adoptConnect = false;
      const before = connects();
      fake.noReply.add("disconnect");
      const stop = D.stopLocal();
      await vi.waitFor(() => expect(fake.commands()).toContain("disconnect"));
      expect(await reverse(fake.id!, "startDebugging", child)).toMatchObject({ success: false, command: "startDebugging" });
      expect(connects()).toBe(before);
      await fake.exit();
      await stop;
    });

    test("startDebugging from the old session doesn't attach to the new one's adapter", async () => {
      m.adoptConnect = true;
      m.plan = portPlan();
      await startAndStop();
      const first = fake.id!;
      await D.restartDebugging();
      await vi.waitFor(() => {
        expect(fake.id).not.toBe(first);
        expect(S.dbg.status).toBe("stopped");
      });
      m.adoptConnect = false;
      const before = connects();
      expect(await reverse(first, "startDebugging", child)).toMatchObject({ success: false });
      expect(connects()).toBe(before);
    });

    test("a child still connecting when the session closes is killed and not launched", async () => {
      m.adoptConnect = true;
      m.plan = portPlan();
      await startAndStop();
      m.adoptConnect = false;
      const gate = deferred<unknown>();
      m.connectGate = gate.promise;
      const before = connects();
      const answer = reverse(fake.id!, "startDebugging", child);
      await vi.waitFor(() => expect(connects()).toBe(before + 1));
      const childId = ipc.filter(([c]) => c === "proc_connect").at(-1)![1].id;
      m.sendFail = childId; // not connected yet, so its disconnect fails right away
      await D.stopLocal();
      gate.resolve(null);
      expect(await answer).toMatchObject({ success: false });
      expect(ipc.some(([c, a]) => c === "proc_kill" && a.id === childId)).toBe(true);
      expect(ipc.some(([c, a]) => c === "proc_send" && a.id === childId && JSON.parse(a.msg).command === "initialize")).toBe(false);
    });

    test("a live session's reverse requests work as before", async () => {
      m.adoptConnect = true;
      m.plan = portPlan();
      await startAndStop();
      m.adoptConnect = false;
      expect(await reverse(fake.id!, "runInTerminal", terminal)).toMatchObject({ success: true });
      expect(m.runCommand).toHaveBeenCalledTimes(1);
      const before = connects();
      expect(await reverse(fake.id!, "startDebugging", child)).toMatchObject({ success: true });
      expect(connects()).toBe(before + 1);
      const childId = ipc.filter(([c]) => c === "proc_connect").at(-1)![1].id;
      await vi.waitFor(() => expect(ipc.some(([c, a]) => c === "proc_send" && a.id === childId && JSON.parse(a.msg).command === "initialize")).toBe(true));
      await emit("proc-exit", childId); // ends its pending requests
    });

    test("an answer to an adapter that is already gone raises nothing", async () => {
      const unhandled = vi.fn();
      const node = (globalThis as any).process; // no Node types in this project
      node.on("unhandledRejection", unhandled);
      try {
        await startAndStop();
        const id = fake.id!;
        await D.stopLocal();
        m.sendFail = id;
        await emit("proc-msg", { id, msg: JSON.stringify({ seq: 900, type: "request", command: "runInTerminal", arguments: terminal }) });
        await new Promise((r) => setTimeout(r, 10));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        node.off("unhandledRejection", unhandled);
      }
    });
  });

  test("a start that throws doesn't count as in progress afterwards", async () => {
    S.dbgHooks.beforeStart = async () => {
      throw new Error("save failed");
    };
    await expect(D.startDebugging()).rejects.toThrow("save failed");
    expect(D.hostDebug.starting()).toBe(false);
  });

  test("the guest's name is gone once the session has ended, however it ended", async () => {
    await D.hostDebug.start("/p/main.py", "Bob");
    await vi.waitFor(() => expect(S.dbg.status).toBe("stopped"));
    expect(S.dbg.actor).toBe("Bob");
    await fake.exit();
    await vi.waitFor(() => expect(S.dbg.status).toBe("terminated"));
    expect(S.dbg.actor).toBe("");
  });
});
