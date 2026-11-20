import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { DapSession as DapSessionT } from "./dap";

// rpc.ts registers its `listen`ers at import time, and every test gets a fresh IPC mock (setup.ts),
// so the module graph is re-imported per test after the mock is installed.
let DapSession: typeof DapSessionT;
let sent: any[];
let sendError: Error | null;

const settle = () => new Promise((r) => setTimeout(r, 0));
const msg = (id: string, m: unknown) => emit("proc-msg", { id, msg: JSON.stringify(m) });

beforeEach(async () => {
  sent = [];
  sendError = null;
  mockIPC(
    (cmd, args: any) => {
      if (cmd === "proc_send") {
        if (sendError) throw sendError;
        sent.push(JSON.parse(args.msg));
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  vi.resetModules();
  ({ DapSession } = await import("./dap"));
  await import("../rpc");
  await settle(); // let rpc.ts's listen() calls register
});

afterEach(() => {
  vi.useRealTimers();
});

function session(over: Partial<ConstructorParameters<typeof DapSessionT>[1]> = {}) {
  const handlers = {
    event: vi.fn(),
    reverse: vi.fn(async () => ({})),
    exit: vi.fn(),
    stderr: vi.fn(),
    ...over,
  };
  return { s: new DapSession("test", handlers), handlers };
}

describe("DapSession", () => {
  test("sends requests with increasing seq and matches responses by request_seq", async () => {
    const { s } = session();
    const a = s.request("threads");
    const b = s.request("stackTrace", { threadId: 1 });
    await settle();
    expect(sent.map((m) => [m.seq, m.type, m.command])).toEqual([
      [1, "request", "threads"],
      [2, "request", "stackTrace"],
    ]);
    expect(sent[1].arguments).toEqual({ threadId: 1 });
    // Answer out of order.
    await msg(s.id, { type: "response", request_seq: 2, success: true, command: "stackTrace", body: { stackFrames: [] } });
    await msg(s.id, { type: "response", request_seq: 1, success: true, command: "threads", body: { threads: [{ id: 1 }] } });
    await expect(b).resolves.toEqual({ stackFrames: [] });
    await expect(a).resolves.toEqual({ threads: [{ id: 1 }] });
  });

  test("response without body resolves to {}", async () => {
    const { s } = session();
    const p = s.request("configurationDone");
    await settle();
    await msg(s.id, { type: "response", request_seq: 1, success: true, command: "configurationDone" });
    await expect(p).resolves.toEqual({});
  });

  test("failed response rejects with the adapter's error text", async () => {
    const { s } = session();
    const p1 = s.request("evaluate");
    const p2 = s.request("setVariable");
    await settle();
    await msg(s.id, { type: "response", request_seq: 1, success: false, command: "evaluate", body: { error: { format: "name 'x' is not defined" } } });
    await msg(s.id, { type: "response", request_seq: 2, success: false, command: "setVariable", message: "nope" });
    await expect(p1).rejects.toThrow("name 'x' is not defined");
    await expect(p2).rejects.toThrow("nope");
  });

  // regression (#25): the fallback error text was hard-coded German instead of going through t().
  test("failed response without message has a localized fallback text", async () => {
    const { s } = session();
    const p = s.request("threads");
    await settle();
    await msg(s.id, { type: "response", request_seq: 1, success: false, command: "threads" });
    const err = await p.catch((e) => e as Error);
    expect(err.message).toContain("threads");
    expect(err.message).not.toContain("fehlgeschlagen");
  });

  test("responses for unknown request_seq and messages for other ids are ignored", async () => {
    const { s, handlers } = session();
    const p = s.request("threads");
    await settle();
    await msg(s.id, { type: "response", request_seq: 99, success: true, body: { wrong: true } });
    await msg("dap-other", { type: "response", request_seq: 1, success: true, body: { wrong: true } });
    await msg(s.id, { type: "response", request_seq: 1, success: true, body: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
    expect(handlers.event).not.toHaveBeenCalled();
  });

  test("no response within the timeout rejects", async () => {
    const { s } = session();
    vi.useFakeTimers();
    const p = s.request("threads", undefined, 1000);
    const assertion = expect(p).rejects.toThrow(/threads/);
    await vi.advanceTimersByTimeAsync(999);
    expect((s as any).pending.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect((s as any).pending.size).toBe(0);
    // A late response is ignored.
    vi.useRealTimers();
    await msg(s.id, { type: "response", request_seq: 1, success: true, body: {} });
  });

  test("timeout 0 never times out", async () => {
    const { s } = session();
    vi.useFakeTimers();
    const p = s.request("launch", {}, 0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((s as any).pending.size).toBe(1);
    vi.useRealTimers();
    await msg(s.id, { type: "response", request_seq: 1, success: true, body: { done: 1 } });
    await expect(p).resolves.toEqual({ done: 1 });
  });

  test("a failed proc_send rejects and removes the pending entry", async () => {
    const { s } = session();
    sendError = new Error("broken pipe");
    await expect(s.request("threads")).rejects.toThrow("broken pipe");
    expect((s as any).pending.size).toBe(0);
  });

  test("events go to the event handler", async () => {
    const { s, handlers } = session();
    await msg(s.id, { type: "event", seq: 5, event: "stopped", body: { reason: "breakpoint", threadId: 1 } });
    expect(handlers.event).toHaveBeenCalledWith(s, expect.objectContaining({ event: "stopped", body: { reason: "breakpoint", threadId: 1 } }));
  });

  test("reverse requests are answered with request_seq = the adapter's seq", async () => {
    const { s, handlers } = session({ reverse: vi.fn(async () => ({ processId: 42 })) });
    await msg(s.id, { type: "request", seq: 17, command: "runInTerminal", arguments: { args: ["x"] } });
    await settle();
    expect(handlers.reverse).toHaveBeenCalledWith(s, expect.objectContaining({ seq: 17, command: "runInTerminal" }));
    expect(sent).toEqual([{ seq: 1, type: "response", request_seq: 17, command: "runInTerminal", success: true, body: { processId: 42 } }]);
    // Our own seq counter advanced: the next request uses seq 2.
    s.request("threads");
    await settle();
    expect(sent[1].seq).toBe(2);
  });

  test("a throwing reverse handler answers success:false with a message", async () => {
    const { s } = session({ reverse: vi.fn(async () => { throw new Error("Unsupported: foo"); }) });
    await msg(s.id, { type: "request", seq: 3, command: "foo" });
    await settle();
    expect(sent[0]).toMatchObject({ type: "response", request_seq: 3, command: "foo", success: false, message: "Error: Unsupported: foo" });
  });

  test("proc-exit rejects pending requests, marks dead and calls exit once", async () => {
    const { s, handlers } = session();
    const p = s.request("threads");
    await settle();
    await emit("proc-exit", s.id);
    await expect(p).rejects.toThrow();
    expect(s.alive).toBe(false);
    expect(handlers.exit).toHaveBeenCalledTimes(1);
    // Unsubscribed: further messages and exits are ignored.
    await emit("proc-exit", s.id);
    await msg(s.id, { type: "event", event: "output" });
    expect(handlers.exit).toHaveBeenCalledTimes(1);
    expect(handlers.event).not.toHaveBeenCalled();
    // Requests after the exit reject immediately without sending.
    const before = sent.length;
    await expect(s.request("threads")).rejects.toThrow();
    expect(sent.length).toBe(before);
  });

  test("stderr lines go to the stderr handler", async () => {
    const { s, handlers } = session();
    await emit("proc-stderr", { id: s.id, msg: "warning: x" });
    expect(handlers.stderr).toHaveBeenCalledWith(s, "warning: x");
  });

  test("spawnStdio / connect / kill invoke the proc commands", async () => {
    const calls: [string, any][] = [];
    mockIPC((cmd, args) => { calls.push([cmd, args]); return null; }, { shouldMockEvents: true });
    const { s } = session();
    await s.spawnStdio("python", ["-m", "debugpy.adapter"], "/p");
    await s.connect(4711);
    s.kill();
    expect(calls).toEqual([
      ["proc_spawn", { id: s.id, cmd: "python", args: ["-m", "debugpy.adapter"], cwd: "/p", env: null }],
      ["proc_connect", { id: s.id, port: 4711 }],
      ["proc_kill", { id: s.id }],
    ]);
    expect(s.alive).toBe(false);
  });
});
