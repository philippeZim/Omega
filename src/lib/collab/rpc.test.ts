// Code Together RPC (rpc.svelte.ts), driven through the collab message handler with a fake transport.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeUi } from "../../test/fakes";

type Msg = Record<string, any>;
const h = vi.hoisted(() => ({
  handlers: [] as ((peer: string, msg: Record<string, any>) => unknown)[],
  endHooks: [] as (() => unknown)[],
  sent: [] as { peer: string; msg: Record<string, any> }[],
  collab: { role: "host" as "host" | "guest" | null, status: "connected", hostPeer: "host-peer" as string | null, participants: [] as any[], myCaps: [] as string[] },
}));
vi.mock("./collab.svelte", () => ({
  collab: h.collab,
  // Like the real transport: what's sent is a JSON copy.
  send: async (peer: string, msg: Msg) => void h.sent.push({ peer, msg: JSON.parse(JSON.stringify(msg)) }),
  onCollabMessage: (fn: (peer: string, msg: Msg) => unknown) => void h.handlers.push(fn),
  sessionEndHooks: h.endHooks,
}));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));

const rpc = await import("./rpc.svelte");
const { RPC_LIMITS, RpcFail, call, forgetRpcPeer, publish, registerMethod, registerTopic, setCapability, subscribe } = rpc;

declare module "./rpc.svelte" {
  interface RpcMethods {
    "t.echo": { params: { v: string }; result: string };
    "t.open": { params: { v: string }; result: string };
    "t.fail": { params: { kind: string }; result: null };
    "t.big": { params: { n: number }; result: string };
    "t.wait": { params: { v: string }; result: string };
  }
  interface RpcTopics {
    "t.state": { n: number };
    "t.gated": { n: number };
  }
}

const str = (raw: unknown) => (rpc.isObj(raw) && typeof raw.v === "string" ? { v: raw.v } : null);
const echo = vi.fn(({ v }: { v: string }) => v);
let release: (() => void) | null = null;
let lastSignal: AbortSignal | null = null;
registerMethod({ name: "t.echo", capability: "run", validate: str, handle: echo });
registerMethod({ name: "t.open", capability: null, validate: str, handle: ({ v }) => v });
registerMethod({
  name: "t.fail",
  capability: null,
  validate: (raw) => (rpc.isObj(raw) && typeof raw.kind === "string" ? { kind: raw.kind } : null),
  handle: ({ kind }) => {
    if (kind === "code") throw new RpcFail("exists");
    if (kind === "badcode") throw new RpcFail("/home/secret/file");
    throw new Error("EACCES: /home/secret/project/a.txt\n    at handler (/home/secret/app.js:1:1)");
  },
});
registerMethod({
  name: "t.big",
  capability: null,
  validate: (raw) => (rpc.isObj(raw) && typeof raw.n === "number" ? { n: raw.n } : null),
  handle: ({ n }) => "x".repeat(n),
});
registerMethod({
  name: "t.wait",
  capability: "run",
  validate: str,
  handle: async ({ v }, { signal }) => {
    lastSignal = signal;
    await new Promise<void>((r) => (release = r));
    return v;
  },
});
let state: { n: number } | null = { n: 1 };
registerTopic({ name: "t.state", capability: null, snapshot: () => state });
registerTopic({ name: "t.gated", capability: "git", snapshot: () => ({ n: 7 }) });

const receive = async (peer: string, msg: Msg) => {
  for (const fn of h.handlers) await fn(peer, msg);
};
const req = (peer: string, id: number, method: unknown, params: unknown = { v: "hi" }) => receive(peer, { t: "rpc.req", id, method, params });
const replies = (peer = "g1") => h.sent.filter((s) => s.peer === peer && s.msg.t === "rpc.res").map((s) => s.msg);
const pubs = (peer = "g1") => h.sent.filter((s) => s.peer === peer && s.msg.t === "rpc.pub").map((s) => s.msg);
const guest = (peer: string, caps: string[] = ["edit", "run"]) => ({ peer, name: peer, color: "#333333", role: "guest", caps });

beforeEach(async () => {
  for (const fn of h.endHooks) await fn();
  h.sent.length = 0;
  echo.mockClear();
  ui.reset();
  release = null;
  lastSignal = null;
  state = { n: 1 };
  Object.assign(h.collab, { role: "host", status: "connected", hostPeer: "host-peer", myCaps: [], participants: [{ peer: "self", name: "H", color: "#111111", role: "host" }, guest("g1"), guest("g2")] });
});
afterEach(() => {
  release?.();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ host

test("an approved guest with the capability gets the result", async () => {
  await req("g1", 1, "t.echo");
  expect(replies()).toEqual([{ t: "rpc.res", id: 1, ok: true, result: "hi" }]);
});

test("unknown methods are refused, also names from Object.prototype", async () => {
  for (const [i, m] of ["nope", "__proto__", "constructor", 7, null, {}].entries()) await req("g1", i, m);
  expect(replies().map((r) => r.error.code)).toEqual(Array(6).fill("unknown_method"));
});

test("invalid params never reach the handler", async () => {
  for (const [i, params] of [null, undefined, 5, "x", [], { v: 1 }].entries()) await receive("g1", { t: "rpc.req", id: i, method: "t.echo", params });
  expect(replies().map((r) => r.error.code)).toEqual(Array(6).fill("invalid_params"));
  expect(echo).not.toHaveBeenCalled();
});

test("a missing capability is refused, a method without one stays open", async () => {
  h.collab.participants[1].caps = ["edit"];
  await req("g1", 1, "t.echo");
  await req("g1", 2, "t.open");
  expect(replies()[0].error.code).toBe("forbidden");
  expect(replies()[1]).toMatchObject({ ok: true, result: "hi" });
  expect(echo).not.toHaveBeenCalled();
});

test("an unapproved peer gets no answer and runs nothing", async () => {
  await req("stranger", 1, "t.echo");
  await receive("stranger", { t: "rpc.sub", topic: "t.state" });
  expect(h.sent).toEqual([]);
  expect(echo).not.toHaveBeenCalled();
});

test("a guest being removed is refused at once", async () => {
  h.collab.participants[1].removing = true;
  await req("g1", 1, "t.echo");
  expect(h.sent).toEqual([]);
});

test("identity comes from the transport: fields in the message can't claim another peer", async () => {
  h.collab.participants[1].caps = [];
  await receive("g1", { t: "rpc.req", id: 1, method: "t.echo", params: { v: "x", peer: "g2" }, peer: "g2", from: "g2", caps: ["run"] });
  expect(replies("g1")[0].error.code).toBe("forbidden");
  expect(replies("g2")).toEqual([]);
  expect(echo).not.toHaveBeenCalled();

  // One peer can't cancel another's call either.
  const running = req("g2", 5, "t.wait");
  await vi.waitFor(() => expect(lastSignal).not.toBeNull());
  await receive("g1", { t: "rpc.cancel", id: 5, peer: "g2" });
  expect(lastSignal!.aborted).toBe(false);
  release!();
  await running;
  expect(replies("g2")).toEqual([{ t: "rpc.res", id: 5, ok: true, result: "hi" }]);
});

test("handler errors become stable codes without paths or stacks", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await req("g1", 1, "t.fail", { kind: "code" });
  await req("g1", 2, "t.fail", { kind: "crash" });
  await req("g1", 3, "t.fail", { kind: "badcode" });
  expect(replies().map((r) => r.error)).toEqual([{ code: "exists" }, { code: "internal" }, { code: "internal" }]);
  expect(JSON.stringify(h.sent)).not.toContain("/home/secret");
  log.mockRestore();
});

test("results over the size cap get too_large instead of breaking the connection", async () => {
  const cap = RPC_LIMITS.maxBytes;
  RPC_LIMITS.maxBytes = 1000;
  try {
    await req("g1", 1, "t.big", { n: 5000 });
    await req("g1", 2, "t.big", { n: 100 });
    expect(replies()[0]).toEqual({ t: "rpc.res", id: 1, ok: false, error: { code: "too_large" } });
    expect(replies()[1].ok).toBe(true);
  } finally {
    RPC_LIMITS.maxBytes = cap;
  }
  expect(cap).toBeLessThan(32 * 1024 * 1024);
});

test("the cap counts bytes, not characters", async () => {
  const cap = RPC_LIMITS.maxBytes;
  RPC_LIMITS.maxBytes = 1000;
  registerMethod({ name: "t.big", capability: null, validate: (raw) => raw as { n: number }, handle: ({ n }) => "é".repeat(n) });
  try {
    await req("g1", 1, "t.big", { n: 600 }); // 600 characters, 1200 bytes
    expect(replies()[0].error.code).toBe("too_large");
  } finally {
    RPC_LIMITS.maxBytes = cap;
    registerMethod({ name: "t.big", capability: null, validate: (raw) => raw as { n: number }, handle: ({ n }) => "x".repeat(n) });
  }
});

test("rate limit: a burst is cut off per peer, others are unaffected, and it refills", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  for (let i = 0; i < RPC_LIMITS.burst + 5; i++) await req("g1", i, "t.open");
  const codes = replies().map((r) => r.error?.code);
  expect(codes.filter((c) => c === "rate_limited")).toHaveLength(5);
  await req("g2", 1, "t.open");
  expect(replies("g2")[0].ok).toBe(true);

  vi.advanceTimersByTime(1000);
  h.sent.length = 0;
  await req("g1", 999, "t.open");
  expect(replies()[0].ok).toBe(true);
});

test("concurrency limit: calls beyond it are refused until one finishes", async () => {
  const releases: (() => void)[] = [];
  registerMethod({
    name: "t.wait",
    capability: "run",
    validate: str,
    handle: async ({ v }) => {
      await new Promise<void>((r) => releases.push(r));
      return v;
    },
  });
  const calls = Array.from({ length: RPC_LIMITS.maxConcurrent }, (_, i) => req("g1", i, "t.wait"));
  await vi.waitFor(() => expect(releases).toHaveLength(RPC_LIMITS.maxConcurrent));
  await req("g1", 100, "t.wait");
  expect(replies().at(-1)).toMatchObject({ id: 100, error: { code: "rate_limited" } });
  for (const r of releases) r();
  await Promise.all(calls);
  registerMethod({
    name: "t.wait",
    capability: "run",
    validate: str,
    handle: async ({ v }, { signal }) => {
      lastSignal = signal;
      await new Promise<void>((r) => (release = r));
      return v;
    },
  });
});

test("revoking a capability applies at once: new calls, running calls, and the guest is told", async () => {
  const running = req("g1", 1, "t.wait");
  await vi.waitFor(() => expect(lastSignal).not.toBeNull());
  setCapability("g1", "run", false);
  expect(lastSignal!.aborted).toBe(true);
  expect(h.sent.find((s) => s.msg.t === "rpc.caps")).toEqual({ peer: "g1", msg: { t: "rpc.caps", caps: ["edit"] } });
  release!();
  await running;
  expect(replies()[0]).toMatchObject({ id: 1, error: { code: "forbidden" } });

  await req("g1", 2, "t.echo");
  expect(replies()[1]).toMatchObject({ id: 2, error: { code: "forbidden" } });

  setCapability("g1", "run", true);
  await req("g1", 3, "t.echo");
  expect(replies()[2]).toMatchObject({ id: 3, ok: true });
  // Only this guest changed.
  expect(h.collab.participants[2].caps).toEqual(["edit", "run"]);
});

test("capabilities can't be set for unknown peers or to unknown names", () => {
  setCapability("stranger", "run", true);
  setCapability("g1", "nope" as never, true);
  expect(h.sent).toEqual([]);
  expect(h.collab.participants[1].caps).toEqual(["edit", "run"]);
});

test("a guest that leaves has its calls aborted and gets nothing more", async () => {
  await receive("g1", { t: "rpc.sub", topic: "t.state" });
  const running = req("g1", 1, "t.wait");
  await vi.waitFor(() => expect(lastSignal).not.toBeNull());
  h.sent.length = 0;
  forgetRpcPeer("g1");
  h.collab.participants.splice(1, 1);
  expect(lastSignal!.aborted).toBe(true);
  release!();
  await running;
  publish("t.state", { n: 2 });
  expect(h.sent).toEqual([]);
});

// ------------------------------------------------------------------ topics

test("subscribers get the snapshot, then updates; others get nothing", async () => {
  await receive("g1", { t: "rpc.sub", topic: "t.state" });
  expect(pubs()).toEqual([{ t: "rpc.pub", topic: "t.state", payload: { n: 1 } }]);
  publish("t.state", { n: 2 });
  expect(pubs().at(-1)!.payload).toEqual({ n: 2 });
  expect(pubs("g2")).toEqual([]);

  await receive("g1", { t: "rpc.unsub", topic: "t.state" });
  publish("t.state", { n: 3 });
  expect(pubs().at(-1)!.payload).toEqual({ n: 2 });
});

test("a topic behind a capability follows grants and revocations", async () => {
  await receive("g1", { t: "rpc.sub", topic: "t.gated" });
  publish("t.gated", { n: 8 });
  expect(pubs()).toEqual([]);
  setCapability("g1", "git", true);
  expect(pubs().at(-1)!.payload).toEqual({ n: 7 });
  publish("t.gated", { n: 9 });
  expect(pubs().at(-1)!.payload).toEqual({ n: 9 });
  setCapability("g1", "git", false);
  expect(pubs().at(-1)!.payload).toBeNull();
  publish("t.gated", { n: 10 });
  expect(pubs().at(-1)!.payload).toBeNull();
});

test("a payload over the size cap isn't sent", async () => {
  await receive("g1", { t: "rpc.sub", topic: "t.state" });
  h.sent.length = 0;
  const cap = RPC_LIMITS.maxBytes;
  RPC_LIMITS.maxBytes = 10;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(publish("t.state", { n: 123456789012 })).toBe(false);
  } finally {
    RPC_LIMITS.maxBytes = cap;
    warn.mockRestore();
  }
  expect(h.sent).toEqual([]);
});

// ------------------------------------------------------------------ guest

const asGuest = () => {
  Object.assign(h.collab, { role: "guest", participants: [], myCaps: ["edit", "run"] });
};
const lastReq = () => h.sent.filter((s) => s.msg.t === "rpc.req").at(-1)!.msg;

test("guest: call resolves with the host's result or its error", async () => {
  asGuest();
  const ok = call("t.echo", { v: "a" });
  expect(h.sent.at(-1)).toMatchObject({ peer: "host-peer", msg: { t: "rpc.req", method: "t.echo", params: { v: "a" } } });
  await receive("host-peer", { t: "rpc.res", id: lastReq().id, ok: true, result: "A" });
  expect(await ok).toEqual({ ok: true, value: "A" });

  const bad = call("t.echo", { v: "b" });
  await receive("host-peer", { t: "rpc.res", id: lastReq().id, ok: false, error: { code: "forbidden" } });
  expect(await bad).toEqual({ ok: false, error: { code: "forbidden" } });
});

test("guest: an answer from anyone but the host is ignored", async () => {
  asGuest();
  const p = call("t.echo", { v: "a" }, { timeoutMs: 20 });
  await receive("mallory", { t: "rpc.res", id: lastReq().id, ok: true, result: "forged" });
  expect(await p).toEqual({ ok: false, error: { code: "timeout" } });
});

test("guest: timeout resolves with an error and tells the host", async () => {
  vi.useFakeTimers();
  asGuest();
  const p = call("t.echo", { v: "a" }, { timeoutMs: 500 });
  const id = lastReq().id;
  await vi.advanceTimersByTimeAsync(500);
  expect(await p).toEqual({ ok: false, error: { code: "timeout" } });
  expect(h.sent.at(-1)!.msg).toEqual({ t: "rpc.cancel", id });
  // A late answer is harmless.
  await receive("host-peer", { t: "rpc.res", id, ok: true, result: "late" });
});

test("guest: AbortSignal cancels the call and reaches the host's handler", async () => {
  asGuest();
  const ac = new AbortController();
  const p = call("t.echo", { v: "a" }, { signal: ac.signal });
  const id = lastReq().id;
  ac.abort();
  expect(await p).toEqual({ ok: false, error: { code: "cancelled" } });
  expect(h.sent.at(-1)!.msg).toEqual({ t: "rpc.cancel", id });

  h.sent.length = 0;
  expect(await call("t.echo", { v: "a" }, { signal: ac.signal })).toEqual({ ok: false, error: { code: "cancelled" } });
  expect(h.sent).toEqual([]);

  Object.assign(h.collab, { role: "host", participants: [guest("g1")] });
  const running = req("g1", 9, "t.wait");
  await vi.waitFor(() => expect(lastSignal).not.toBeNull());
  await receive("g1", { t: "rpc.cancel", id: 9 });
  expect(lastSignal!.aborted).toBe(true);
  release!();
  await running;
  expect(replies()).toEqual([]);
});

test("guest: the end of the session settles every pending call", async () => {
  asGuest();
  const calls = [call("t.echo", { v: "a" }), call("t.open", { v: "b" })];
  for (const fn of h.endHooks) await fn();
  expect(await Promise.all(calls)).toEqual(Array(2).fill({ ok: false, error: { code: "session_ended" } }));
  h.collab.role = null;
  expect(await call("t.echo", { v: "c" })).toEqual({ ok: false, error: { code: "session_ended" } });
});

test("guest: params over the cap are refused locally", async () => {
  asGuest();
  const cap = RPC_LIMITS.maxBytes;
  RPC_LIMITS.maxBytes = 5;
  try {
    expect(await call("t.echo", { v: "too long" })).toEqual({ ok: false, error: { code: "too_large" } });
  } finally {
    RPC_LIMITS.maxBytes = cap;
  }
  expect(h.sent).toEqual([]);
});

test("guest: subscribe gets pushes, late subscribers the last value, the session end null", async () => {
  asGuest();
  const a = vi.fn();
  const offA = subscribe("t.state", a);
  expect(h.sent.at(-1)!.msg).toEqual({ t: "rpc.sub", topic: "t.state" });
  await receive("host-peer", { t: "rpc.pub", topic: "t.state", payload: { n: 5 } });
  expect(a).toHaveBeenLastCalledWith({ n: 5 });

  const b = vi.fn();
  const offB = subscribe("t.state", b);
  expect(b).toHaveBeenCalledWith({ n: 5 });

  for (const fn of h.endHooks) await fn();
  expect(a).toHaveBeenLastCalledWith(null);
  expect(b).toHaveBeenLastCalledWith(null);

  // A new session subscribes again on welcome.
  h.sent.length = 0;
  await receive("host-peer", { t: "welcome" });
  expect(h.sent.map((s) => s.msg)).toEqual([{ t: "rpc.sub", topic: "t.state" }]);

  offA();
  offB();
  expect(h.sent.at(-1)!.msg).toEqual({ t: "rpc.unsub", topic: "t.state" });
});

test("guest: a capability change updates the state, tells the user and the listeners", async () => {
  asGuest();
  const changed = vi.fn();
  const off = rpc.onCapabilitiesChanged(changed);
  await receive("host-peer", { t: "rpc.caps", caps: ["edit", "git", "made-up"] });
  expect(h.collab.myCaps).toEqual(["edit", "git"]);
  expect(changed).toHaveBeenCalledWith(["edit", "run"], ["edit", "git"]);
  expect(ui.toasts.map((x) => x.text)).toEqual(["The host allowed: Git", "The host turned off: Run"]);
  off();
});

// ------------------------------------------------------------------ hardening

test("a clock stepping backwards can't lock a guest out", async () => {
  await req("g1", 1, "t.open");
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 86_400_000);
  try {
    await req("g1", 2, "t.open");
    expect(replies()[1]).toMatchObject({ id: 2, ok: true });
  } finally {
    now.mockRestore();
  }
});

test("a flooding peer gets a bounded number of refusals; a dropped call still ends by timeout", async () => {
  vi.useFakeTimers({ toFake: ["performance"] });
  for (let i = 0; i < RPC_LIMITS.burst + 500; i++) await req("g1", i, "t.open");
  const refused = replies().filter((r) => r.error?.code === "rate_limited");
  expect(refused).toHaveLength(RPC_LIMITS.maxRefusalsPerSecond);
  vi.useRealTimers();

  asGuest();
  const p = call("t.echo", { v: "dropped" }, { timeoutMs: 10 });
  expect(await p).toEqual({ ok: false, error: { code: "timeout" } });
});

test("repeating a subscription doesn't make the host resend its snapshot", async () => {
  for (let i = 0; i < 50; i++) await receive("g1", { t: "rpc.sub", topic: "t.state" });
  expect(pubs()).toHaveLength(1);
});

test("guest: pushes for topics nobody follows are not kept", async () => {
  asGuest();
  await receive("host-peer", { t: "rpc.pub", topic: "t.state", payload: { n: 1 } });
  const cb = vi.fn();
  const off = subscribe("t.state", cb);
  expect(cb).not.toHaveBeenCalled();
  off();
});
