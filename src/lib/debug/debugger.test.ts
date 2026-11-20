import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

// ---------------------------------------------------------------- heavy imports, stubbed

const m = vi.hoisted(() => ({
  tab: { id: "t1", path: "/p/main.py", dirty: false } as { id: string; path: string | null; dirty: boolean },
  plan: null as any,
  openFile: null as any,
  toast: null as any,
  runCommand: null as any,
}));

vi.mock("../state.svelte", () => ({
  app: { tabs: [], root: "/p", mode: "code" },
  activeTab: () => m.tab,
  openFile: (...a: any[]) => m.openFile(...a),
  save: async () => {},
  setMode: () => {},
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
  mockIPC(
    (cmd, args: any) => {
      ipc.push([cmd, args]);
      if (cmd === "proc_spawn") fake.id = args.id;
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
    fake.replies.continue = () => {
      fake.event("continued", { threadId: 1 });
      throw new Error("late failure");
    };
    await D.continueRun();
    await settle();
    expect(S.dbg.console.some((l) => l.kind === "error" && l.text.includes("late failure"))).toBe(true);
    expect(S.dbg.status).toBe("running");
    expect(S.dbg.exec).toBeNull();
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
    vi.doUnmock("./adapters");
  });

  test("without a saved file it only toasts", async () => {
    m.tab = { id: "t2", path: null, dirty: false };
    await D.startDebugging();
    expect(m.toast).toHaveBeenCalledWith(expect.any(String), "error");
    expect(S.dbg.status).toBe("idle");
  });
});
