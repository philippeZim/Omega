import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

// ---------------------------------------------------------------- xterm stubs

const x = vi.hoisted(() => ({ terms: [] as any[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: any;
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    written: string[] = [];
    dataCb: ((d: string) => void) | null = null;
    buffer = { active: { baseY: 0, cursorY: 0, getLine: () => undefined } };
    constructor(opts: any) {
      this.options = opts;
      x.terms.push(this);
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData(cb: (d: string) => void) { this.dataCb = cb; }
    onResize() {}
    resize(c: number, r: number) { this.cols = c; this.rows = r; }
    open(el: HTMLElement) { this.element = el; }
    write(s: string) { this.written.push(s); }
    reset() { this.written = []; }
    focus() {}
    dispose() {}
    hasSelection() { return false; }
    getSelection() { return ""; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./layout.svelte", () => ({ showView: vi.fn(), hideView: vi.fn(), toggleView: vi.fn() }));

// ---------------------------------------------------------------- IPC

let calls: [string, any][];
let spawnError: Error | null;
let T: typeof import("./terminal.svelte");
const settle = () => new Promise((r) => setTimeout(r, 0));
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const lastTerm = () => x.terms[x.terms.length - 1];
const written = (term = lastTerm()) => term.written.join("");

beforeEach(async () => {
  calls = [];
  spawnError = null;
  x.terms = [];
  mockIPC(
    (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "pty_spawn" && spawnError) throw spawnError;
      return null;
    },
    { shouldMockEvents: true },
  );
  if (!(document as any).fonts) Object.defineProperty(document, "fonts", { value: { load: async () => [] }, configurable: true });
  vi.resetModules();
  T = await import("./terminal.svelte");
  await settle();
});

afterEach(() => vi.restoreAllMocks());

const spawns = () => calls.filter(([c]) => c === "pty_spawn").map(([, a]) => a);

describe("Build/Run tasks", () => {
  test("pty-exit with code 0 marks the task ok with its duration", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const onExit = vi.fn();
    T.runTask("run", "python main.py", "/p", "Run main.py", { focus: false, onExit });
    const tab = T.terms.tabs.find((t) => t.kind === "run")!;
    expect(tab).toMatchObject({ title: "Run main.py", status: "running", exited: false });
    expect(T.taskRunning("run")).toBe(true);
    await settle();
    const [spawn] = spawns();
    expect(spawn).toMatchObject({ cwd: "/p", kind: "run", shell: null, command: "python main.py", cols: 80, rows: 24 });
    expect(spawn.id).toMatch(new RegExp(`^${tab.id}\\.\\d+$`));
    expect(T.isTaskPty(spawn.id)).toBe(true);
    expect(written()).toContain("$ python main.py");

    now.mockReturnValue(11_500);
    await emit("pty-exit", { id: spawn.id, code: 0 });
    expect(tab.status).toBe("ok");
    expect(tab.code).toBe(0);
    expect(onExit).toHaveBeenCalledWith(0);
    expect(written()).toContain("Finished with code 0 · 1.5 s");
    expect(T.taskRunning()).toBe(false);
  });

  test("non-zero exit marks the task failed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const onExit = vi.fn();
    T.runTask("build", "make", "/p", "Build", { focus: false, onExit });
    await settle();
    now.mockReturnValue(125_000);
    await emit("pty-exit", { id: spawns()[0].id, code: 2 });
    const tab = T.terms.tabs.find((t) => t.kind === "build")!;
    expect(tab).toMatchObject({ status: "fail", code: 2 });
    expect(onExit).toHaveBeenCalledWith(2);
    expect(written()).toContain("Failed with code 2 · 2 min 5 s");
  });

  test("taskState follows the run; interruptTask only stops the task it names", async () => {
    expect(T.taskState()).toEqual({ running: false, kind: null, taskId: null, status: null });
    T.runTask("run", "sleep 100", null, "Run", { focus: false });
    await settle();
    const first = T.taskState();
    expect(first).toMatchObject({ running: true, kind: "run", status: "running" });
    const pty = spawns()[0].id;

    T.runTask("run", "sleep 200", null, "Run", { focus: false });
    await settle();
    const second = T.taskState();
    expect(second.taskId).not.toBe(first.taskId);
    const pty2 = spawns()[1].id;
    expect(pty2).not.toBe(pty);

    // A Stop for the replaced run must not hit the new one.
    expect(T.interruptTask(first.taskId!)).toBe(false);
    expect(calls.some(([c, a]) => c === "pty_write" && a.id === pty2)).toBe(false);
    expect(T.interruptTask(second.taskId!)).toBe(true);
    expect(calls.at(-1)).toEqual(["pty_write", { id: pty2, data: "\x03" }]);
    await emit("pty-exit", { id: pty2, code: 130 });
    expect(T.taskState()).toMatchObject({ running: false, kind: "run", taskId: second.taskId, status: "stopped" });
  });

  test("a package task is marked while it runs, and the mark doesn't carry over to the next run", async () => {
    T.runCommand("uv sync", "/p", "uv", false, { packageTask: true });
    await settle();
    const pkg = T.taskState();
    expect(pkg.packages).toBe(true);
    expect(T.runningPackageTask(pkg.taskId!)).toBe(true);

    T.runTask("run", "sleep 100", null, "Run", { focus: false });
    await settle();
    const plain = T.taskState();
    expect(plain.packages).toBeUndefined();
    expect(T.runningPackageTask(plain.taskId!)).toBe(false);
    expect(T.runningPackageTask(pkg.taskId!)).toBeNull(); // a late Stop for the package task
  });

  test("cancelTask / interruptRun end as stopped and report null", async () => {
    const onExit = vi.fn();
    T.runTask("run", "sleep 100", null, "Run", { focus: false, onExit });
    await settle();
    const pty = spawns()[0].id;
    T.interruptRun();
    expect(calls.at(-1)).toEqual(["pty_write", { id: pty, data: "\x03" }]);
    await emit("pty-exit", { id: pty, code: 130 });
    expect(T.terms.tabs[0].status).toBe("stopped");
    expect(onExit).toHaveBeenCalledWith(null);

    T.runTask("run", "sleep 100", null, "Run", { focus: false, onExit });
    await settle();
    const pty2 = spawns()[1].id;
    T.cancelTask("run");
    expect(calls.some(([c, a]) => c === "pty_kill" && a.id === pty2)).toBe(true);
    await emit("pty-exit", { id: pty2, code: null });
    expect(T.terms.tabs[0].status).toBe("stopped");
  });

  test("sendInput reaches the program in the Run tab, which has its own PTY id (#88)", async () => {
    T.runTask("run", "./prog", null, "Run", { focus: false });
    await settle();
    const tab = T.terms.tabs.find((t) => t.kind === "run")!;
    await T.sendInput(tab.id, "Jürgen\r");
    expect(calls.at(-1)).toEqual(["pty_write", { id: spawns()[0].id, data: "Jürgen\r" }]);
    expect(spawns()[0].id).not.toBe(tab.id);
  });

  test("a killed process (code null) counts as stopped", async () => {
    T.runTask("run", "x", null, "Run", { focus: false });
    await settle();
    await emit("pty-exit", { id: spawns()[0].id, code: null });
    expect(T.terms.tabs[0]).toMatchObject({ status: "stopped", code: null });
  });

  test("a failing pty_spawn shows the error and finishes with 127", async () => {
    spawnError = new Error("No such file");
    const onExit = vi.fn();
    T.runTask("run", "nope", null, "Run", { focus: false, onExit });
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(127));
    expect(T.terms.tabs[0]).toMatchObject({ status: "fail", code: 127 });
    expect(written()).toContain("No such file");
  });

  test("restarting reuses the tab, kills the old pty and ignores its exit", async () => {
    const first = vi.fn();
    T.runTask("run", "one", null, "Run", { focus: false, onExit: first });
    await settle();
    const old = spawns()[0].id;
    const second = vi.fn();
    T.runTask("run", "two", null, "Run", { focus: false, onExit: second });
    await settle();
    expect(T.terms.tabs.length).toBe(1);
    expect(calls.some(([c, a]) => c === "pty_kill" && a.id === old)).toBe(true);
    const cur = spawns()[1].id;
    expect(cur).not.toBe(old);
    await emit("pty-exit", { id: old, code: 1 });
    expect(T.terms.tabs[0].status).toBe("running");
    expect(first).not.toHaveBeenCalled();
    await emit("pty-exit", { id: cur, code: 0 });
    expect(T.terms.tabs[0].status).toBe("ok");
    expect(second).toHaveBeenCalledWith(0);
    expect(first).not.toHaveBeenCalled();
  });

  test("the Build tab is kept left of the Run tab", () => {
    T.runTask("run", "r", null, "Run", { focus: false });
    T.runTask("build", "b", null, "Build", { focus: false });
    expect(T.terms.tabs.map((t) => t.kind)).toEqual(["build", "run"]);
  });
});

describe("shell terminals", () => {
  test("input queued before the shell exists is written after pty_spawn", async () => {
    const id = T.newTerminalWith("claude", "/p", "Claude");
    expect(T.terms.tabs.find((t) => t.id === id)).toMatchObject({ title: "Claude", kind: "shell" });
    expect(calls.some(([c]) => c === "pty_write")).toBe(false);
    const host = document.createElement("div");
    document.body.appendChild(host);
    await T.attach(id, host);
    const order = calls.filter(([c]) => c === "pty_spawn" || c === "pty_write");
    expect(order).toEqual([
      ["pty_spawn", { id, cwd: "/p", cols: 80, rows: 24, kind: "shell", shell: null }],
      ["pty_write", { id, data: "claude\r" }],
    ]);
    // A second attach does not spawn or replay again.
    await T.attach(id, host);
    expect(calls.filter(([c]) => c === "pty_spawn" || c === "pty_write").length).toBe(2);
  });

  test("attach uses the cwd fallback when the terminal has none", async () => {
    const id = T.newTerminal(null);
    await T.attach(id, document.createElement("div"), "/fallback");
    expect(spawns()[0]).toMatchObject({ id, cwd: "/fallback" });
  });

  test("pty-data is decoded as streaming UTF-8", async () => {
    const id = T.newTerminal(null);
    const term = lastTerm();
    // "é" = C3 A9, split across two chunks.
    await emit("pty-data", { id, data: b64([0x61, 0xc3]) });
    await emit("pty-data", { id, data: b64([0xa9, 0x62]) });
    expect(term.written.join("")).toBe("aéb");
  });

  test("pty-exit of a shell marks the tab exited", async () => {
    const id = T.newTerminal(null);
    await emit("pty-exit", { id, code: 0 });
    expect(T.terms.tabs.find((t) => t.id === id)!.exited).toBe(true);
    expect(written()).toContain("[Process exited]");
  });

  test("typing goes to the current pty", async () => {
    const id = T.newTerminal(null);
    lastTerm().dataCb("ls\r");
    await settle();
    expect(calls.at(-1)).toEqual(["pty_write", { id, data: "ls\r" }]);
  });

  test("new terminals take the lowest free number; closing the last hides the panel", async () => {
    const a = T.newTerminal(null);
    const b = T.newTerminal(null);
    expect(T.terms.tabs.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 2"]);
    T.closeTerminal(a);
    T.newTerminal(null);
    expect(T.terms.tabs.map((t) => t.title)).toEqual(["Terminal 2", "Terminal 1"]);
    const { hideView } = await import("./layout.svelte");
    for (const t of [...T.terms.tabs]) T.closeTerminal(t.id);
    expect(T.terms.active).toBeNull();
    expect(hideView).toHaveBeenCalledWith("terminal");
    expect(calls.some(([c, arg]) => c === "pty_kill" && arg.id === b)).toBe(true);
  });

  test("guest input only reaches the exact running task, never a later one", async () => {
    T.runTask("run", "python a.py", null, "Run", { focus: false });
    await settle();
    const first = T.taskState().taskId!;
    const pty = spawns()[0].id;
    expect(await T.writeTaskInput(first, "Ada\r")).toBe("ok");
    expect(calls).toContainEqual(["pty_write_guest", expect.objectContaining({ id: pty, data: "Ada\r", target: "task" })]);

    T.runTask("run", "python b.py", null, "Run", { focus: false });
    await settle();
    const pty2 = spawns()[1].id;
    calls.length = 0;
    expect(await T.writeTaskInput(first, "late\r")).toBe("ended");
    expect(calls.some(([c]) => c === "pty_write_guest" || c === "pty_write")).toBe(false);

    const second = T.taskState().taskId!;
    await emit("pty-exit", { id: pty2, code: 0 });
    expect(await T.writeTaskInput(second, "after exit\r")).toBe("ended");
    expect(calls.some(([c]) => c === "pty_write_guest" || c === "pty_write")).toBe(false);
  });

  test("no guest input after Stop was requested", async () => {
    T.runTask("run", "sleep 9", null, "Run", { focus: false });
    await settle();
    const id = T.taskState().taskId!;
    T.interruptTask(id);
    calls.length = 0;
    expect(await T.writeTaskInput(id, "x")).toBe("ended");
    expect(calls.some(([c]) => c === "pty_write_guest")).toBe(false);
  });

  test("a guest's shell view is read-only and takes neither the view nor the focus", async () => {
    const own = T.newTerminal(null);
    const onClose = vi.fn();
    const id = T.openGuestShellView("Ada's shell", 100, 30, onClose);
    expect(T.terms.active).toBe(own);
    expect(lastTerm()).toMatchObject({ cols: 100, rows: 30 });
    expect(lastTerm().options.disableStdin).toBe(true);
    await T.spawnGuestShell(id, "/p", 100, 30);
    expect(spawns().at(-1)).toMatchObject({ id, cwd: "/p", kind: "guest-shell", shell: null });

    calls.length = 0;
    lastTerm().dataCb("typed by the host\r");
    await expect(T.sendInput(id, "from a tool")).rejects.toThrow();
    await settle();
    expect(calls.some(([c]) => c === "pty_write")).toBe(false);

    T.closeTerminal(id);
    expect(onClose).toHaveBeenCalledOnce();
    expect(calls.some(([c, a]) => c === "pty_kill" && a.id === id)).toBe(true);
  });

  test("a view closed while its shell starts kills the shell", async () => {
    const id = T.openGuestShellView("Ada's shell", 80, 24, () => {});
    const spawning = T.spawnGuestShell(id, "/p", 80, 24);
    T.closeTerminal(id);
    await spawning;
    await settle();
    expect(spawns().some((s) => s.id === id)).toBe(false);
  });

  test("remote terminals route typing to onInput instead of a pty", async () => {
    const onInput = vi.fn();
    const id = T.remoteTerminal("Host: Run", onInput);
    lastTerm().dataCb("y\r");
    await settle();
    expect(onInput).toHaveBeenCalledWith("y\r");
    expect(calls.some(([c]) => c === "pty_write")).toBe(false);
    await T.attach(id, document.createElement("div"));
    expect(spawns()).toEqual([]);
  });
});
