// Code Together session state (collab.svelte.ts) with the transport events mocked.
import { expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

const forgetPeer = vi.hoisted(() => vi.fn());
vi.mock("./share.svelte", () => ({ forgetPeer, teardownShare: async () => {} }));

const NAME = "Gäste-Testerin Ümlaut mit sehr langem Namen"; // 43 characters

test("a guest with a long name finds itself in the participant list (#130)", async () => {
  mockIPC((cmd) => (cmd === "collab_join" ? "hostpeer" : null), { shouldMockEvents: true });
  const { collab, join, isMe, setMyName, MAX_NAME, PROTOCOL_VERSION } = await import("./collab.svelte");
  setMyName(NAME);
  expect(collab.me.name).toBe(NAME.slice(0, MAX_NAME));
  await join("omega-ticket");

  // The host's list: another guest with the same (cut) name, and me.
  const cut = NAME.slice(0, 40);
  const participants = [
    { peer: "host", name: "Host", color: "#111111", role: "host" },
    { peer: "other", name: cut, color: "#222222", role: "guest" },
    { peer: "me123", name: cut, color: "#333333", role: "guest" },
  ];
  await emit("collab-msg", { peer: "hostpeer", msg: JSON.stringify({ t: "welcome", version: PROTOCOL_VERSION, you: { peer: "me123", name: cut, color: "#333333" }, participants }) });
  expect(collab.status).toBe("connected");
  expect(collab.participants.filter(isMe).map((p) => p.peer)).toEqual(["me123"]);
});

test("host: a guest whose connection closed is forgotten by the shared-docs layer", async () => {
  // A fresh module, so its transport listeners register on this test's event mock.
  vi.resetModules();
  mockIPC(() => null, { shouldMockEvents: true });
  const { collab } = await import("./collab.svelte");
  await new Promise((r) => setTimeout(r));
  Object.assign(collab, {
    role: "host",
    status: "hosting",
    participants: [
      { peer: "self", name: "Host", color: "#111111", role: "host" },
      { peer: "g1", name: "Gast", color: "#222222", role: "guest" },
    ],
  });
  await emit("collab-closed", { peer: "g1", reason: "closed" });
  await vi.waitFor(() => expect(forgetPeer).toHaveBeenCalledWith("g1"));
  Object.assign(collab, { role: null, status: "idle", participants: [] });
});

/** A fresh session module on a fresh event mock; `calls` lists the backend commands it used. */
async function freshSession(handler: (cmd: string, args: any) => unknown = () => null) {
  vi.resetModules();
  const calls: { cmd: string; args: any }[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "git") return { code: 0, stdout: "Tester\n" };
      const r = handler(cmd, args);
      if (r instanceof Error) throw r;
      return r;
    },
    { shouldMockEvents: true },
  );
  const m = await import("./collab.svelte");
  const { ui } = await import("../ui.svelte");
  const toast = vi.spyOn(ui, "toast");
  await new Promise((r) => setTimeout(r));
  const sent = () => calls.filter((c) => c.cmd === "collab_send").map((c) => ({ peer: c.args.peer as string, msg: JSON.parse(c.args.msg) }));
  return { ...m, calls, sent, toast };
}
const count = (calls: { cmd: string }[], cmd: string) => calls.filter((c) => c.cmd === cmd).length;

test("starting to host twice at once starts one session", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_host" ? "omega-t" : null));
  s.collab.me.name = "";
  await Promise.all([s.startHosting(), s.startHosting()]);
  expect(count(s.calls, "collab_host")).toBe(1);
  await s.startHosting();
  expect(count(s.calls, "collab_host")).toBe(1);
  await s.leave();
});

test("joining while hosting keeps the host role, and joining twice at once connects once", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_host" ? "omega-t" : cmd === "collab_join" ? "hostpeer" : null));
  await s.startHosting();
  await s.join("omega-other");
  expect(s.collab.role).toBe("host");
  expect(count(s.calls, "collab_join")).toBe(0);
  await s.leave();

  s.collab.me.name = "";
  await Promise.all([s.join("omega-a"), s.join("omega-b")]);
  expect(count(s.calls, "collab_join")).toBe(1);
  await s.leave();
});

test("after a failed start the user can try again", async () => {
  let fail = true;
  const s = await freshSession((cmd) => (cmd === "collab_host" ? (fail ? new Error("no network") : "omega-t") : null));
  await s.startHosting();
  expect(s.collab.status).toBe("error");
  fail = false;
  await s.startHosting();
  expect(s.collab.status).toBe("hosting");
  await s.leave();
});

test("leave recovers when the backend fails to stop", async () => {
  let fail = true;
  const s = await freshSession((cmd) => (cmd === "collab_host" ? "omega-t" : cmd === "collab_stop" && fail ? new Error("stop failed") : null));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const ended = vi.fn();
  s.sessionEndHooks.push(ended);
  await s.startHosting();
  await s.leave();
  expect(s.collab.role).toBeNull();
  expect(ended).toHaveBeenCalled();
  fail = false;
  await s.startHosting();
  expect(s.collab.status).toBe("hosting");
  await s.leave();
  expect(count(s.calls, "collab_stop")).toBe(2);
  log.mockRestore();
});

test("host: a guest with another protocol version is told and never becomes a request", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_host" ? "omega-t" : null));
  await s.startHosting();
  for (const version of [s.PROTOCOL_VERSION - 1, s.PROTOCOL_VERSION + 1, "2", undefined]) {
    await emit("collab-msg", { peer: "old", msg: JSON.stringify({ t: "hello", name: "Old", version }) });
  }
  expect(s.collab.requests).toEqual([]);
  expect(s.sent().filter((x) => x.peer === "old").map((x) => x.msg)).toContainEqual({ t: "version", version: s.PROTOCOL_VERSION });
  await emit("collab-msg", { peer: "new", msg: JSON.stringify({ t: "hello", name: "New", version: s.PROTOCOL_VERSION }) });
  expect(s.collab.requests.map((r) => r.peer)).toEqual(["new"]);
  await s.leave();
});

test("guest: a version mismatch gives one message saying who should update", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_join" ? "hostpeer" : null));
  for (const [version, text] of [
    [s.PROTOCOL_VERSION + 1, "Update Omega"],
    [s.PROTOCOL_VERSION - 1, "Ask the host"],
  ] as const) {
    s.toast.mockClear();
    await s.join("omega-t");
    await emit("collab-msg", { peer: "hostpeer", msg: JSON.stringify({ t: "version", version }) });
    await emit("collab-closed", { peer: "hostpeer", reason: "removed" });
    await vi.waitFor(() => expect(s.collab.role).toBeNull());
    expect(s.toast).toHaveBeenCalledTimes(1);
    expect(s.toast.mock.calls[0][0]).toContain(text);
  }
});

test("guest: a host that doesn't send a version counts as older", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_join" ? "hostpeer" : null));
  await s.join("omega-t");
  await emit("collab-msg", { peer: "hostpeer", msg: JSON.stringify({ t: "welcome", you: { peer: "me", name: "Me", color: "#333333" }, participants: [] }) });
  await vi.waitFor(() => expect(s.collab.role).toBeNull());
  expect(s.collab.status).toBe("idle");
  expect(s.toast.mock.calls.map((c) => c[0]).join()).toContain("Ask the host");
});

test("start rights: approve applies them, a rejoin can't get more, later changes spare existing guests, ending clears them", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_host" ? "omega-t" : null));
  const { DEFAULT_CAPABILITIES } = await import("./guard");
  await s.startHosting();
  expect(s.collab.startCaps).toEqual(DEFAULT_CAPABILITIES);
  expect(s.collab.startCaps).not.toContain("terminal");

  s.setStartCapability("run", false);
  s.approve({ peer: "g1", name: "Gast" });
  const caps = () => s.collab.participants.find((p) => p.peer === "g1")?.caps;
  expect(caps()).not.toContain("run");
  expect(s.sent().find((x) => x.msg.t === "welcome")!.msg.caps).not.toContain("run");

  // Leaving and being approved again (with a new connection) gives no more than the start rights.
  await emit("collab-closed", { peer: "g1", reason: "closed" });
  s.approve({ peer: "g1-again", name: "Gast" });
  expect(s.collab.participants.find((p) => p.peer === "g1-again")?.caps).not.toContain("run");

  // A guest's own list is a copy: changing the start rights leaves it alone.
  s.setStartCapability("git", false);
  s.setStartCapability("run", true);
  const existing = s.collab.participants.find((p) => p.peer === "g1-again")!.caps!;
  expect(existing).toContain("git");
  expect(existing).not.toContain("run");
  s.approve({ peer: "g2", name: "Zwei" });
  const later = s.collab.participants.find((p) => p.peer === "g2")!.caps!;
  expect(later).toContain("run");
  expect(later).not.toContain("git");

  await s.leave();
  expect(s.collab.startCaps).toEqual(DEFAULT_CAPABILITIES);
});

test("host: join requests are bounded, the excess is told it's busy, and the host hears once", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_host" ? "omega-t" : null));
  await s.startHosting();
  s.toast.mockClear();
  const hello = (peer: string) => emit("collab-msg", { peer, msg: JSON.stringify({ t: "hello", name: peer, version: s.PROTOCOL_VERSION }) });
  for (let i = 0; i < s.MAX_VISIBLE_REQUESTS + 5; i++) await hello(`p${i}`);
  expect(s.collab.requests.length).toBe(s.MAX_VISIBLE_REQUESTS);
  expect(s.collab.refused).toBe(5);
  await vi.waitFor(() => expect(s.sent().filter((m) => m.msg.t === "busy").map((m) => m.peer)).toEqual(["p16", "p17", "p18", "p19", "p20"]));
  await emit("collab-refused", { count: 40 });
  expect(s.collab.refused).toBe(45);
  expect(s.toast.mock.calls.filter(([m]) => m === "ai.collab.joinsRefused" || String(m).startsWith("Too many join")).length).toBe(1);
  await s.leave();
  expect(s.collab.refused).toBe(0);
});

test("host: an approved guest keeps its place while a flood of requests is turned away", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_host" ? "omega-t" : null));
  await s.startHosting();
  await emit("collab-msg", { peer: "good", msg: JSON.stringify({ t: "hello", name: "Good", version: s.PROTOCOL_VERSION }) });
  s.approve(s.collab.requests[0]);
  for (let i = 0; i < s.MAX_VISIBLE_REQUESTS * 2; i++) await emit("collab-msg", { peer: `x${i}`, msg: JSON.stringify({ t: "hello", name: "x", version: s.PROTOCOL_VERSION }) });
  expect(s.collab.participants.some((p) => p.peer === "good")).toBe(true);
  expect(s.sent().some((m) => m.peer === "good" && m.msg.t === "busy")).toBe(false);
  await s.leave();
});

test.each(["busy", "expired"])("guest: a refusal by the host's limits (%s) says so", async (code) => {
  const s = await freshSession((cmd) => (cmd === "collab_join" ? "hostpeer" : null));
  await s.join("omega-t");
  s.toast.mockClear();
  await emit("collab-closed", { peer: "hostpeer", reason: `collab:${code}` });
  const text = code === "busy" ? "too many join requests" : "timed out";
  await vi.waitFor(() => expect(s.toast.mock.calls.some(([m]) => String(m).includes(text))).toBe(true));
  expect(s.toast.mock.calls.some(([m]) => m === "Disconnected from host")).toBe(false);
});

test("guest: a busy answer from the host ends the attempt with a clear message", async () => {
  const s = await freshSession((cmd) => (cmd === "collab_join" ? "hostpeer" : null));
  await s.join("omega-t");
  await emit("collab-msg", { peer: "hostpeer", msg: JSON.stringify({ t: "busy" }) });
  await vi.waitFor(() => expect(s.collab.role).toBe(null));
  expect(s.toast.mock.calls.some(([m]) => String(m).includes("too many join requests"))).toBe(true);
});
