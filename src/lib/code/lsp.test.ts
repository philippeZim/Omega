import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn() } }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true, withInstallProgress: async (_i: string, _n: string, f: () => any) => f(), serverProgressId: (k: string) => k }));

// ---------------------------------------------------------------- URIs (pure)

describe("fileUri / uriPath", () => {
  test.each([
    ["/home/me/proj/main.py", "file:///home/me/proj/main.py"],
    ["/home/me/my project/a b.py", "file:///home/me/my%20project/a%20b.py"],
    ["/tmp/#hash/100%/q?.c", "file:///tmp/%23hash/100%25/q%3F.c"],
    ["/home/ü/Ärger €.ts", "file:///home/%C3%BC/%C3%84rger%20%E2%82%AC.ts"],
    ["C:/Users/me/proj/main.c", "file:///c%3A/Users/me/proj/main.c"],
    ["D:/My Files/x+y&z.rs", "file:///d%3A/My%20Files/x%2By%26z.rs"],
  ])("%s ⇄ %s", (path, uri) => {
    expect(L.fileUri(path)).toBe(uri);
    expect(L.uriPath(uri)).toBe(path);
    expect(L.uriPath(L.fileUri(path))).toBe(path);
  });

  test("uriPath accepts other spellings of Windows URIs", () => {
    expect(L.uriPath("file:///C:/Users/me/a.c")).toBe("C:/Users/me/a.c");
    expect(L.uriPath("file:///c:/Users/me/a.c")).toBe("C:/Users/me/a.c");
    expect(L.uriPath("file:///C%3A/Users/me/a%20b.c")).toBe("C:/Users/me/a b.c");
    // Normalised back to our own spelling.
    expect(L.fileUri(L.uriPath("file:///C:/x/a.c"))).toBe("file:///c%3A/x/a.c");
  });
});

// #113: the toast used the last stderr line, often unrelated debug output.
describe("exitReason", () => {
  test("picks the last error-like line, not trailing debug output", () => {
    expect(L.exitReason(["thread 'main' panicked at src/x.rs:1", "                (garbage collection took Some(325.805208ms))"])).toBe(": thread 'main' panicked at src/x.rs:1");
    expect(L.exitReason(["Could not find a valid TypeScript installation. Exiting."])).toBe(": Could not find a valid TypeScript installation. Exiting.");
  });

  test("no error-like line → no reason", () => {
    expect(L.exitReason(["                (garbage collection took Some(325.805208ms))"])).toBe("");
    expect(L.exitReason([])).toBe("");
  });

  test("long lines are shortened", () => {
    expect(L.exitReason(["error: " + "x".repeat(300)]).length).toBeLessThanOrEqual(202);
  });
});

// ---------------------------------------------------------------- LspClient with a fake server

class FakeServer {
  id: string | null = null;
  sent: any[] = [];
  /** method → result (function), or "none" to never answer. */
  results: Record<string, ((params: any) => any) | "none"> = {
    initialize: () => ({ capabilities: { hoverProvider: true } }),
  };
  onSend(raw: string) {
    const m = JSON.parse(raw);
    this.sent.push(m);
    if (m.id === undefined || !m.method) return; // notifications and our responses
    const r = this.results[m.method];
    if (r === "none") return;
    setTimeout(() => this.send({ jsonrpc: "2.0", id: m.id, result: r ? r(m.params) : null }), 0);
  }
  send(m: any) {
    return emit("proc-msg", { id: this.id, msg: JSON.stringify(m) });
  }
  notifications() {
    return this.sent.filter((m) => m.id === undefined).map((m) => m.method);
  }
}

let srv: FakeServer;
let calls: [string, any][];
let L: typeof import("./lsp.svelte");
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  srv = new FakeServer();
  calls = [];
  mockIPC(
    (cmd, args: any) => {
      calls.push([cmd, args]);
      if (cmd === "proc_spawn") srv.id = args.id;
      if (cmd === "proc_send" && args.id === srv.id) srv.onSend(args.msg);
      if (cmd === "path_exists") return false;
      return null;
    },
    { shouldMockEvents: true },
  );
  vi.resetModules();
  L = await import("./lsp.svelte");
  await settle();
});

afterEach(() => vi.useRealTimers());

async function readyClient(kind: "python" | "rust" = "python", root = "/w/proj") {
  const c = new L.LspClient(kind, root, "pyright-langserver", ["--stdio"]);
  await c.ready;
  return c;
}

describe("LspClient", () => {
  test("start: spawns, initializes, sends initialized and becomes ready", async () => {
    const c = await readyClient();
    expect(calls.find(([cmd]) => cmd === "proc_spawn")![1]).toEqual({ id: c.id, cmd: "pyright-langserver", args: ["--stdio"], cwd: "/w/proj" });
    const init = srv.sent[0];
    expect(init).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(init.params).toMatchObject({ rootUri: "file:///w/proj", rootPath: "/w/proj", workspaceFolders: [{ uri: "file:///w/proj", name: "proj" }] });
    expect(srv.sent[1]).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    expect(c.capabilities).toEqual({ hoverProvider: true });
    expect(L.lspState.status[c.key]).toBe("ready");
  });

  test("rust gets checkOnSave as default initializationOptions", async () => {
    await readyClient("rust", "/w/crate");
    expect(srv.sent[0].params.initializationOptions).toEqual({ checkOnSave: true });
  });

  test("responses are matched by id, also out of order", async () => {
    const c = await readyClient();
    srv.results.slow = "none";
    srv.results.fast = (p) => ({ echo: p });
    const slow = c.request("slow", { a: 1 });
    const fast = c.request("fast", { b: 2 });
    await expect(fast).resolves.toEqual({ echo: { b: 2 } });
    const slowId = srv.sent.find((m) => m.method === "slow").id;
    await srv.send({ jsonrpc: "2.0", id: 9999, result: "stray" });
    await srv.send({ jsonrpc: "2.0", id: slowId, result: "late" });
    await expect(slow).resolves.toBe("late");
  });

  test("error responses reject with the server's message", async () => {
    const c = await readyClient();
    srv.results.bad = "none";
    const p = c.request("bad", null);
    await settle();
    await srv.send({ jsonrpc: "2.0", id: srv.sent.at(-1).id, error: { code: -32601, message: "Unhandled method bad" } });
    await expect(p).rejects.toThrow("Unhandled method bad");
  });

  test("a request without response times out", async () => {
    const c = await readyClient();
    srv.results["textDocument/hover"] = "none";
    vi.useFakeTimers();
    const p = c.request("textDocument/hover", {}, 500);
    const done = expect(p).rejects.toThrow("textDocument/hover: Timeout");
    await vi.advanceTimersByTimeAsync(499);
    expect((c as any).pending.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect((c as any).pending.size).toBe(0);
  });

  test("a failed proc_send rejects and clears the pending entry", async () => {
    const c = await readyClient();
    mockIPC((cmd) => { if (cmd === "proc_send") throw new Error("pipe closed"); return null; }, { shouldMockEvents: true });
    await expect(c.request("x", null)).rejects.toThrow("pipe closed");
    expect((c as any).pending.size).toBe(0);
  });

  test("didOpen / didChange / didSave / didClose sequence with versions", async () => {
    const c = await readyClient();
    const uri = L.fileUri("/w/proj/a b.py");
    srv.sent = [];
    c.open(uri, "python", "x = 1");
    c.open(uri, "python", "x = 1"); // already open, same text: nothing
    c.change(uri, "x = 1"); // unchanged: nothing
    c.change(uri, "x = 2");
    c.open(uri, "python", "x = 3"); // already open: becomes a change
    c.save(uri, "x = 3");
    c.close(uri);
    c.close(uri); // not open: nothing
    c.save(uri, "x = 3"); // not open: nothing
    c.change(uri, "x = 4"); // not open: nothing
    await settle();
    expect(srv.sent).toEqual([
      { jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "python", version: 1, text: "x = 1" } } },
      { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: "x = 2" }] } },
      { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: "x = 3" }] } },
      { jsonrpc: "2.0", method: "textDocument/didSave", params: { textDocument: { uri }, text: "x = 3" } },
      { jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri } } },
    ]);
    expect(c.docs.has(uri)).toBe(false);
  });

  test("publishDiagnostics are stored under our URI spelling and reach listeners", async () => {
    const c = await readyClient();
    const seen: string[] = [];
    c.diagnosticListeners.add((u) => seen.push(u));
    const diags = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "boom", severity: 1 }];
    await srv.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///C:/w/a%20b.c", diagnostics: diags } });
    await srv.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///w/proj/m.py", diagnostics: [] } });
    expect(seen).toEqual(["file:///c%3A/w/a%20b.c", "file:///w/proj/m.py"]);
    expect(c.diagnostics.get(L.fileUri("C:/w/a b.c"))).toEqual(diags);
    expect(c.diagnostics.get(L.fileUri("/w/proj/m.py"))).toEqual([]);
  });

  test("server requests are answered (configuration, workspaceFolders, unknown → null)", async () => {
    const c = await readyClient();
    srv.sent = [];
    await srv.send({ jsonrpc: "2.0", id: 5, method: "workspace/configuration", params: { items: [{ section: "basedpyright" }, { section: "other" }] } });
    await srv.send({ jsonrpc: "2.0", id: 6, method: "workspace/workspaceFolders" });
    await srv.send({ jsonrpc: "2.0", id: 7, method: "client/registerCapability", params: {} });
    await srv.send({ jsonrpc: "2.0", id: 8, method: "workspace/applyEdit", params: {} });
    await settle();
    expect(srv.sent).toEqual([
      { jsonrpc: "2.0", id: 5, result: [{ analysis: { typeCheckingMode: "standard" } }, null] },
      { jsonrpc: "2.0", id: 6, result: [{ uri: "file:///w/proj", name: "/w/proj" }] },
      { jsonrpc: "2.0", id: 7, result: null },
      { jsonrpc: "2.0", id: 8, result: { applied: false } },
    ]);
    expect(c.alive).toBe(true);
  });

  test("showMessage errors/warnings are kept as status message", async () => {
    const c = await readyClient();
    await srv.send({ jsonrpc: "2.0", method: "window/showMessage", params: { type: 3, message: "info only" } });
    expect(L.lspState.message[c.key]).toBeUndefined();
    await srv.send({ jsonrpc: "2.0", method: "window/showMessage", params: { type: 1, message: "Failed to load project" } });
    expect(L.lspState.message[c.key]).toBe("Failed to load project");
  });

  test("exit toast names the error line, not trailing debug output (#113)", async () => {
    const { ui } = await import("../ui.svelte");
    const toast = vi.mocked(ui.toast);
    toast.mockClear();
    const c = await readyClient();
    await emit("proc-stderr", { id: c.id, msg: "error: index corrupted" });
    await emit("proc-stderr", { id: c.id, msg: "   (garbage collection took Some(3ms))" });
    await emit("proc-exit", c.id);
    expect(toast).toHaveBeenCalledWith("Language server (python) exited: error: index corrupted", "error");
  });

  test("proc-exit marks the client stopped and keeps the stderr tail", async () => {
    const c = await readyClient();
    const onExit = vi.fn();
    c.exitListeners.add(onExit);
    await emit("proc-stderr", { id: c.id, msg: "panic: something" });
    await emit("proc-exit", c.id);
    expect(onExit).toHaveBeenCalledTimes(1); // editors reconnect (#111)
    expect(c.alive).toBe(false);
    expect(L.lspState.status[c.key]).toBe("stopped");
    expect(L.lspState.message[c.key]).toBe("panic: something");
    srv.sent = [];
    c.notify("x", {}); // dead: notifications are dropped
    await settle();
    expect(srv.sent).toEqual([]);
  });

  // #23: in-flight requests (hover, completion, …) must fail on exit, not hang until the 15 s timeout.
  test("proc-exit rejects in-flight requests right away", async () => {
    const c = await readyClient();
    srv.results.slow = "none";
    vi.useFakeTimers();
    const p = c.request("slow", null);
    const settled = vi.fn();
    p.then(settled, settled);
    await emit("proc-exit", c.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toHaveBeenCalled();
    await expect(p).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0); // the request's timeout timer is cleared too
  });

  test("stop: shutdown request, exit notification, then kill", async () => {
    const c = await readyClient();
    srv.sent = [];
    c.stop();
    await vi.waitFor(() => expect(calls.some(([cmd, a]) => cmd === "proc_kill" && a.id === c.id)).toBe(true));
    expect(srv.sent.map((m) => m.method)).toEqual(["shutdown", "exit"]);
    expect(c.stopping).toBe(true);
  });

  // The kill runs 300 ms after stop(), when the IPC may be gone already (app teardown, or the end
  // of a test file): a failing proc_kill must not become an unhandled rejection.
  test("stop: a failing late kill is swallowed", async () => {
    const c = await readyClient();
    vi.useFakeTimers();
    c.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.sent.at(-1).method).toBe("exit");
    (window as any).__TAURI_INTERNALS__.invoke = undefined; // what clearMocks() leaves behind
    const unhandled = vi.fn();
    const proc = (globalThis as any).process; // Node, under the test runner
    proc.on("unhandledRejection", unhandled);
    try {
      await vi.advanceTimersByTimeAsync(300);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      proc.off("unhandledRejection", unhandled);
    }
  });
});

// ---------------------------------------------------------------- findRoot

describe("findRoot", () => {
  function withFiles(files: string[]) {
    const set = new Set(files);
    const asked: string[] = [];
    mockIPC((cmd, args: any) => {
      if (cmd === "path_exists") {
        asked.push(args.path);
        return set.has(args.path);
      }
      return null;
    });
    return asked;
  }
  const PY = ["pyproject.toml", "setup.py", "requirements.txt", ".git"];

  test("nearest directory with a marker", async () => {
    withFiles(["/w/proj/pyproject.toml", "/w/.git"]);
    expect(await L.findRoot("/w/proj/src/pkg/a.py", PY, "/w")).toBe("/w/proj");
  });

  test("falls back to the workspace, or the file's folder without one", async () => {
    withFiles([]);
    expect(await L.findRoot("/w/proj/src/a.py", PY, "/w")).toBe("/w");
    expect(await L.findRoot("/w/proj/src/a.py", PY, null)).toBe("/w/proj/src");
  });

  test("does not look above the workspace root", async () => {
    const asked = withFiles(["/.git", "/home/.git"]);
    expect(await L.findRoot("/home/me/w/src/a.py", PY, "/home/me/w")).toBe("/home/me/w");
    expect(asked.some((p) => p.startsWith("/home/me/.git") || p === "/home/.git" || p === "/.git")).toBe(false);
    expect(asked).toContain("/home/me/w/.git");
  });

  test("without a workspace walks up to (not including) the filesystem root", async () => {
    const asked = withFiles(["/home/me/.git"]);
    expect(await L.findRoot("/home/me/x/y/a.py", PY, null)).toBe("/home/me");
    const asked2 = withFiles([]);
    await L.findRoot("/a/b.py", PY, null);
    expect(asked2.every((p) => !p.startsWith("//") && p !== "/.git")).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
  });

  test("Cargo: the outermost Cargo.toml wins (workspace)", async () => {
    withFiles(["/w/ws/Cargo.toml", "/w/ws/crates/a/Cargo.toml"]);
    expect(await L.findRoot("/w/ws/crates/a/src/main.rs", ["Cargo.toml"], "/w")).toBe("/w/ws");
  });

  test("Windows paths", async () => {
    withFiles(["C:/Users/me/proj/CMakeLists.txt"]);
    expect(await L.findRoot("C:/Users/me/proj/src/main.c", ["compile_commands.json", "CMakeLists.txt"], null)).toBe("C:/Users/me/proj");
    withFiles([]);
    expect(await L.findRoot("C:/a/b/main.c", ["CMakeLists.txt"], null)).toBe("C:/a/b");
    expect(await L.findRoot("C:/a/b/main.c", ["CMakeLists.txt"], "C:/a")).toBe("C:/a");
  });
});

describe("statusFor", () => {
  test("picks the most specific root containing the file", () => {
    L.lspState.status["python|/w"] = "ready";
    L.lspState.status["python|/w/sub"] = "starting";
    L.lspState.status["clangd|/w/sub/deeper"] = "error";
    const lang = { server: "python" } as any;
    expect(L.statusFor(lang, "/w/sub/a.py").status).toBe("starting");
    expect(L.statusFor(lang, "/w/a.py").status).toBe("ready");
    expect(L.statusFor(lang, "/w2/a.py").status).toBeNull();
    expect(L.statusFor(lang, "/w/subway/a.py").status).toBe("ready");
    expect(L.statusFor(null, "/w/a.py").status).toBeNull();
  });
});

describe("client registry", () => {
  /** Fake servers for every spawned id: answer initialize/shutdown right away. */
  async function multiServer(files: string[] = []) {
    const spawned: string[] = [];
    mockIPC(
      (cmd, args: any) => {
        if (cmd === "tools_dir") return "/tools";
        if (cmd === "cmd_works") return true;
        if (cmd === "path_exists" && files.includes(args.path)) return true;
        if (cmd === "which_cmd") return args.cmd === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null;
        if (cmd === "path_exists") return false;
        if (cmd === "proc_spawn") spawned.push(args.id);
        if (cmd === "proc_send") {
          const msg = JSON.parse(args.msg);
          if (msg.id !== undefined && msg.method)
            setTimeout(() => emit("proc-msg", { id: args.id, msg: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { capabilities: {} } : null }) }), 0);
        }
        return null;
      },
      { shouldMockEvents: true },
    );
    // A new IPC mock drops the event listeners: re-import so rpc.ts listens again.
    vi.resetModules();
    L = await import("./lsp.svelte");
    await settle();
    return spawned;
  }
  const PY = { server: "python", lspId: "python" } as any;
  const no = async () => false;

  test("clientFor reuses the running client for the same root and dedupes concurrent starts", async () => {
    const spawned = await multiServer();
    const [a, b] = await Promise.all([L.clientFor(PY, "/w/a.py", "/w", no), L.clientFor(PY, "/w/b.py", "/w", no)]);
    expect(a).toBe(b);
    expect(await L.clientFor(PY, "/w/sub/c.py", "/w", no)).toBe(a);
    expect(spawned.length).toBe(1);
    expect(a!.root).toBe("/w");
    expect(L.lspState.status["python|/w"]).toBe("ready");
  });

  // Regression (#22): a stopped client's exit used to delete its key from the registry and set
  // status "stopped", even when a new client for the same key had started in the meantime
  // (stopServers + restart on demand, or clientFor(..., needDebug) for Java). The running server
  // was dropped (the next clientFor spawned a duplicate) and the status bar showed "stopped".
  test("a late exit of a stopped client does not clobber its replacement", async () => {
    const spawned = await multiServer();
    const old = await L.clientFor(PY, "/w/a.py", "/w", no);
    L.stopServers("python");
    const fresh = await L.clientFor(PY, "/w/a.py", "/w", no);
    expect(fresh).not.toBe(old);
    await emit("proc-exit", old!.id); // old process finally exits
    expect(L.lspState.status["python|/w"]).toBe("ready");
    expect(L.allClients()).toContain(fresh);
    expect(await L.clientFor(PY, "/w/a.py", "/w", no)).toBe(fresh);
    expect(spawned.length).toBe(2);
  });

  // #96: a crash during initialize used to replace the stderr reason with a generic message
  // and a second "failed to start" toast.
  test("a crash during initialize keeps the stderr reason and shows one toast", async () => {
    const { ui } = await import("../ui.svelte");
    const toast = vi.mocked(ui.toast);
    toast.mockClear();
    const spawned: string[] = [];
    mockIPC(
      (cmd, args: any) => {
        if (cmd === "tools_dir") return "/tools";
        if (cmd === "which_cmd") return args.cmd === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null;
        if (cmd === "path_exists") return false;
        if (cmd === "proc_spawn") spawned.push(args.id);
        if (cmd === "proc_send" && JSON.parse(args.msg).method === "initialize")
          setTimeout(async () => {
            await emit("proc-stderr", { id: args.id, msg: "error: bad config" });
            await emit("proc-exit", args.id);
          }, 0);
        return null;
      },
      { shouldMockEvents: true },
    );
    vi.resetModules();
    L = await import("./lsp.svelte");
    await settle();
    expect(await L.clientFor(PY, "/w/a.py", "/w", no)).toBeNull();
    expect(L.lspState.status["python|/w"]).toBe("error");
    expect(L.lspState.message["python|/w"]).toBe("error: bad config");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(toast.mock.calls[0][0])).toContain("error: bad config");
  });

  // #115: servers of a previously opened folder kept running for the whole session.
  test("servers without documents outside the open folder are stopped", async () => {
    const spawned = await multiServer();
    let ws = "/a";
    L.setLspWorkspace(() => ws);
    const a = (await L.clientFor(PY, "/a/x.py", "/a", no))!;
    a.open(L.fileUri("/a/x.py"), "python", "");
    a.close(L.fileUri("/a/x.py"));
    expect(L.allClients()).toContain(a); // still the open folder: kept
    a.open(L.fileUri("/a/x.py"), "python", "");
    ws = "/b";
    const b = (await L.clientFor(PY, "/b/y.py", "/b", no))!;
    expect(L.allClients()).toContain(a); // still has an open document
    b.open(L.fileUri("/b/y.py"), "python", "");
    a.close(L.fileUri("/a/x.py")); // last tab of the old folder closed
    expect(L.allClients()).toEqual([b]);
    expect(a.stopping).toBe(true);
    expect(L.lspState.status["python|/a"]).toBeUndefined();
    expect(spawned.length).toBe(2);
  });

  test("an idle server of the old folder is stopped when the next server is requested", async () => {
    await multiServer();
    let ws = "/a";
    L.setLspWorkspace(() => ws);
    const a = (await L.clientFor(PY, "/a/x.py", "/a", no))!;
    a.open(L.fileUri("/a/x.py"), "python", "");
    a.close(L.fileUri("/a/x.py"));
    ws = "/b";
    const b = await L.clientFor(PY, "/b/y.py", "/b", no);
    expect(L.allClients()).toEqual([b]);
  });

  // #114: a server that answered initialize with an error kept running, and every new tab
  // of the project spawned another one (plus another toast).
  test("a failed start kills the process and is not retried for the next file", async () => {
    const { ui } = await import("../ui.svelte");
    const toast = vi.mocked(ui.toast);
    toast.mockClear();
    const spawned: string[] = [];
    const killed: string[] = [];
    mockIPC(
      (cmd, args: any) => {
        if (cmd === "tools_dir") return "/tools";
        if (cmd === "which_cmd") return args.cmd === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null;
        if (cmd === "path_exists") return false;
        if (cmd === "proc_spawn") spawned.push(args.id);
        if (cmd === "proc_kill") killed.push(args.id);
        if (cmd === "proc_send") {
          const msg = JSON.parse(args.msg);
          if (msg.method === "initialize")
            setTimeout(() => emit("proc-msg", { id: args.id, msg: JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "no tsserver" } }) }), 0);
        }
        return null;
      },
      { shouldMockEvents: true },
    );
    vi.resetModules();
    L = await import("./lsp.svelte");
    await settle();
    expect(await L.clientFor(PY, "/w/a.py", "/w", no)).toBeNull();
    expect(await L.clientFor(PY, "/w/b.py", "/w", no)).toBeNull();
    expect(spawned.length).toBe(1);
    expect(killed).toContain(spawned[0]); // (a previous test's late proc_kill may show up too)
    expect(toast).toHaveBeenCalledTimes(1);
    expect(L.lspState.status["python|/w"]).toBe("error");
    // The late exit of the killed process leaves the error status alone.
    await emit("proc-exit", spawned[0]);
    expect(L.lspState.status["python|/w"]).toBe("error");
    // After an update (stopServers) the server is tried again.
    L.stopServers("python");
    await L.clientFor(PY, "/w/a.py", "/w", no);
    expect(spawned.length).toBe(2);
  });

  // #116: the status indicator restarts the server of the active file.
  test("restartServer replaces the running client and notifies editors", async () => {
    const spawned = await multiServer();
    const old = (await L.clientFor(PY, "/w/a.py", "/w", no))!;
    const notified = vi.fn();
    L.restartListeners.add(notified);
    const fresh = await L.restartServer(PY, "/w/a.py", "/w", no);
    L.restartListeners.delete(notified);
    expect(fresh).not.toBe(old);
    expect(old.stopping).toBe(true);
    expect(L.allClients()).toEqual([fresh]);
    expect(L.lspState.status["python|/w"]).toBe("ready");
    expect(notified).toHaveBeenCalledTimes(1);
    expect(spawned.length).toBe(2);
  });

  test("restartServer asks to install again after the prompt was cancelled", async () => {
    mockIPC((cmd) => (cmd === "tools_dir" ? "/tools" : cmd === "path_exists" ? false : null), { shouldMockEvents: true });
    const ask = vi.fn(async () => false);
    await L.clientFor(PY, "/w/a.py", "/w", ask);
    await L.clientFor(PY, "/w/a.py", "/w", ask);
    expect(ask).toHaveBeenCalledTimes(1);
    await L.restartServer(PY, "/w/a.py", "/w", ask);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test("restartServer retries a server whose start failed (#114)", async () => {
    let fail = true;
    const spawned: string[] = [];
    mockIPC(
      (cmd, args: any) => {
        if (cmd === "tools_dir") return "/tools";
        if (cmd === "which_cmd") return args.cmd === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null;
        if (cmd === "path_exists") return false;
        if (cmd === "proc_spawn") spawned.push(args.id);
        if (cmd === "proc_send") {
          const msg = JSON.parse(args.msg);
          if (msg.id !== undefined && msg.method) {
            const body = msg.method === "initialize" && fail ? { error: { code: -32603, message: "boom" } } : { result: msg.method === "initialize" ? { capabilities: {} } : null };
            setTimeout(() => emit("proc-msg", { id: args.id, msg: JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }) }), 0);
          }
        }
        return null;
      },
      { shouldMockEvents: true },
    );
    vi.resetModules();
    L = await import("./lsp.svelte");
    await settle();
    expect(await L.clientFor(PY, "/w/a.py", "/w", no)).toBeNull();
    fail = false;
    expect(await L.restartServer(PY, "/w/a.py", "/w", no)).not.toBeNull();
    expect(spawned.length).toBe(2);
  });

  // #109: Go to Definition into the std library started a second rust-analyzer rooted in ~/.rustup.
  test("a file outside the open folder uses the folder's running server", async () => {
    const spawned = await multiServer(["/usr/lib/python3/setup.py"]);
    const own = await L.clientFor(PY, "/w/a.py", "/w", no);
    expect(await L.clientFor(PY, "/usr/lib/python3/os.py", "/w", no)).toBe(own);
    expect(spawned.length).toBe(1);
  });

  test("Rust std sources never get a server of their own", async () => {
    const spawned = await multiServer(["/home/me/.rustup/toolchains/stable/lib/rustlib/src/rust/library/Cargo.toml"]);
    const RS = { server: "rust", lspId: "rust" } as any;
    expect(await L.clientFor(RS, "/home/me/.rustup/toolchains/stable/lib/rustlib/src/rust/library/std/src/macros.rs", "/w", no)).toBeNull();
    expect(spawned.length).toBe(0);
  });

  // #110: two servers returning the same symbol gave duplicate keys and the list failed to render.
  test("workspaceSymbols merges all servers and drops duplicate locations", async () => {
    const spawned: string[] = [];
    mockIPC(
      (cmd, args: any) => {
        if (cmd === "tools_dir") return "/tools";
        if (cmd === "which_cmd") return args.cmd === "basedpyright-langserver" ? "/usr/bin/basedpyright-langserver" : null;
        if (cmd === "path_exists") return false;
        if (cmd === "proc_spawn") spawned.push(args.id);
        if (cmd === "proc_send") {
          const msg = JSON.parse(args.msg);
          if (msg.id === undefined || !msg.method) return null;
          const loc = (line: number) => ({ uri: "file:///lib/core/ops.rs", range: { start: { line, character: 4 }, end: { line, character: 7 } } });
          const result =
            msg.method === "initialize" ? { capabilities: {} }
            : msg.method === "workspace/symbol" ? [{ name: "Add", kind: 11, location: loc(155) }, { name: "Add", kind: 11, location: loc(200) }, { name: "nowhere", kind: 12 }]
            : null;
          setTimeout(() => emit("proc-msg", { id: args.id, msg: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) }), 0);
        }
        return null;
      },
      { shouldMockEvents: true },
    );
    vi.resetModules();
    L = await import("./lsp.svelte");
    await settle();
    await L.clientFor(PY, "/w/a.py", "/w", no);
    await L.clientFor(PY, "/v/b.py", "/v", no);
    expect(spawned.length).toBe(2);
    expect(await L.workspaceSymbols("add")).toEqual([
      { name: "Add", kind: 11, containerName: undefined, path: "/lib/core/ops.rs", line: 155, character: 4 },
      { name: "Add", kind: 11, containerName: undefined, path: "/lib/core/ops.rs", line: 200, character: 4 },
    ]);
  });

  // #108: the managed install pulled TypeScript 7, which has no tsserver.js; the server could never start.
  test("managed TypeScript server without tsserver.js counts as missing", async () => {
    let tsserver = false;
    const spawned: string[] = [];
    mockIPC(
      (cmd, args: any) => {
        if (cmd === "tools_dir") return "/tools";
        if (cmd === "which_cmd") return args.cmd === "/tools/typescript/node_modules/.bin/typescript-language-server" ? args.cmd : null;
        if (cmd === "path_exists") return tsserver && args.path === "/tools/typescript/node_modules/typescript/lib/tsserver.js";
        if (cmd === "proc_spawn") spawned.push(args.cmd);
        return null;
      },
      { shouldMockEvents: true },
    );
    vi.resetModules();
    L = await import("./lsp.svelte");
    await settle();
    const TS = { server: "typescript", lspId: "javascript" } as any;
    const ask = vi.fn(async () => false);
    expect(await L.clientFor(TS, "/w/a.js", "/w", ask)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(spawned).toEqual([]);
    tsserver = true;
    L.stopServers("typescript");
    void L.clientFor(TS, "/w/a.js", "/w", ask);
    await vi.waitFor(() => expect(spawned).toEqual(["/tools/typescript/node_modules/.bin/typescript-language-server"]));
  });

  test("missing server: status missing, askInstall declined → null", async () => {
    mockIPC((cmd) => (cmd === "tools_dir" ? "/tools" : cmd === "path_exists" ? false : null), { shouldMockEvents: true });
    const ask = vi.fn(async () => false);
    expect(await L.clientFor(PY, "/w/a.py", "/w", ask)).toBeNull();
    expect(ask).toHaveBeenCalledWith("python", "basedpyright (Python)");
    expect(L.lspState.status["python|/w"]).toBe("missing");
  });

  // #112: the prompt came back on every activation of a tab after Cancel.
  test("a declined install is not asked again, except for debugging or after stopServers", async () => {
    mockIPC((cmd) => (cmd === "tools_dir" ? "/tools" : cmd === "path_exists" ? false : null), { shouldMockEvents: true });
    const ask = vi.fn(async () => false);
    expect(await L.clientFor(PY, "/w/a.py", "/w", ask)).toBeNull();
    expect(await L.clientFor(PY, "/w/b.py", "/w", ask)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(L.lspState.status["python|/w"]).toBe("missing");
    await L.clientFor(PY, "/w/a.py", "/w", ask, true);
    expect(ask).toHaveBeenCalledTimes(2);
    L.stopServers("python"); // installed/updated from the settings
    await L.clientFor(PY, "/w/a.py", "/w", ask);
    expect(ask).toHaveBeenCalledTimes(3);
  });
});
