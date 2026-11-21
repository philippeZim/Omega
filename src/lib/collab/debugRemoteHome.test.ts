// The Run mirror before the host's home folder is known: a fresh module per test, so its state is unset.
import { afterEach, expect, test, vi } from "vitest";
import { fakeUi } from "../../test/fakes";

const h = vi.hoisted(() => ({
  collab: { role: "host" as "host" | null, status: "connected", hostPeer: null, participants: [] as unknown[], myCaps: [] as string[], me: { name: "me", color: "#000" } },
  app: { root: "/home/alice/proj" as string | null, tabs: [] as unknown[], activeId: null, mode: "code" },
  homeDir: async (): Promise<string> => "/home/alice",
}));
vi.mock("./collab.svelte", () => ({ collab: h.collab, send: async () => {}, onCollabMessage: () => {}, sessionEndHooks: [] }));
const ui = fakeUi();
vi.mock("../ui.svelte", () => ({ ui }));
vi.mock("../api", () => ({ fsApi: { exists: async () => true, homeDir: () => h.homeDir() } }));
vi.mock("../layout.svelte", () => ({ showView: vi.fn() }));
vi.mock("../state.svelte", () => ({ app: h.app, activeTab: () => null, setMode: vi.fn() }));
vi.mock("./share.svelte", () => ({ REMOTE: "collab:", isRemote: () => false, openRemote: vi.fn(), flushBackgroundDocs: async () => {}, guestScope: () => null }));
vi.mock("../debug/debugger.svelte", () => ({
  stopLocal: vi.fn(async () => {}),
  hostDebug: new Proxy({}, { get: (_t, k: string) => (k === "gen" ? () => 1 : k === "localLive" || k === "starting" || k === "closing" ? () => false : vi.fn(async () => undefined)) }),
}));

const toB64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromB64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

async function fresh(homeDir: () => Promise<string>) {
  vi.resetModules();
  h.homeDir = homeDir;
  return import("./debugRemote.svelte");
}
afterEach(() => vi.resetModules());

test("host: output waits for the home folder before it is mirrored (#155)", async () => {
  let answer: (home: string) => void = () => {};
  const remote = await fresh(() => new Promise((r) => (answer = r)));
  const later: string[] = [];
  expect(remote.filterTerminal(toB64("at /home/alice/secret.py\n"), (b) => later.push(b))).toBe("");
  expect(later).toEqual([]);
  answer("/home/alice");
  await vi.waitFor(() => expect(later.map(fromB64).join("")).toBe("at ~/secret.py\n"));
});

test("host: without the home folder nothing is mirrored (#155)", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const remote = await fresh(async () => {
    throw new Error("no home");
  });
  const later: string[] = [];
  expect(remote.filterTerminal(toB64("at /home/alice/secret.py\n"), (b) => later.push(b))).toBe("");
  await vi.waitFor(() => expect(logged).toHaveBeenCalledWith("collab home folder", expect.anything()));
  await new Promise((r) => setTimeout(r));
  expect(later).toEqual([]);
});

test("host: a failing home folder lookup runs once and logs once, and stays closed (#155)", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const lookup = vi.fn(async (): Promise<string> => {
    throw new Error("no home");
  });
  const remote = await fresh(lookup);
  const later: string[] = [];
  remote.filterTerminal(toB64("first /home/alice/a\n"), (b) => later.push(b));
  await vi.waitFor(() => expect(logged).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r));
  const calls = lookup.mock.calls.length;
  for (let i = 0; i < 200; i++) expect(remote.filterTerminal(toB64("more /home/alice/b\n"), (b) => later.push(b))).toBe("");
  await new Promise((r) => setTimeout(r));
  expect(lookup.mock.calls.length).toBe(calls);
  expect(logged).toHaveBeenCalledTimes(1);
  expect(later).toEqual([]);
});
