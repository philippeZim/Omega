// Code Together language sessions (lspHost.svelte.ts) with fake shared docs and a fake server client.
import { beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

const h = vi.hoisted(() => ({
  collab: { role: "host" as "host" | "guest" | null, participants: [] as any[] },
  app: { root: "/p" as string | null },
  docs: [] as any[],
  listeners: new Set<() => void>(),
  endHooks: [] as (() => unknown)[],
  restart: new Set<() => void>(),
  client: null as any,
  clientFor: vi.fn(),
  pathOk: vi.fn(async (_rel: string, _root: string) => true),
  publish: vi.fn(),
  topics: new Map<string, any>(),
  methods: new Map<string, any>(),
}));
vi.mock("./collab.svelte", () => ({ collab: h.collab, sessionEndHooks: h.endHooks, send: vi.fn(), onCollabMessage: vi.fn() }));
vi.mock("./rpc.svelte", () => ({ publish: h.publish, registerTopic: (d: any) => void h.topics.set(d.name, d), registerMethod: (d: any) => void h.methods.set(d.name, d) }));
vi.mock("./share.svelte", () => ({ sharedDocs: () => h.docs, sharedDocListeners: h.listeners, guestPathOk: h.pathOk }));
vi.mock("../state.svelte", () => ({ app: h.app }));
vi.mock("../api", () => ({ joinPath: (a: string, b: string) => `${a}/${b}` }));
vi.mock("../code/languages", () => ({ langFor: (p: string) => (p.endsWith(".py") ? { server: "python", lspId: "python" } : null) }));
vi.mock("../code/lsp.svelte", () => ({
  clientFor: h.clientFor,
  fileUri: (p: string) => `file://${p}`,
  neverInstall: async () => false,
  restartListeners: h.restart,
}));

const { reconcileLspSessions, lspSessionFor, syncSession } = await import("./lspHost.svelte");
const { LSP_LIMITS, textHash } = await import("./lspProtocol");

function fakeClient() {
  const c = {
    alive: true,
    capabilities: { hoverProvider: true, completionProvider: { triggerCharacters: ["."] } },
    docs: new Map<string, { version: number; text: string }>(),
    diagnostics: new Map<string, any[]>(),
    diagnosticVersions: new Map<string, number | undefined>(),
    feeds: new Map<string, () => string>(),
    change: vi.fn(),
    feed: vi.fn((uri: string, _l: string, read: () => string) => {
      c.feeds.set(uri, read);
      c.docs.set(uri, { version: 1, text: read() });
    }),
    unfeed: vi.fn((uri: string) => void c.feeds.delete(uri)),
    diagnosticListeners: new Set(),
    exitListeners: new Set<() => void>(),
  };
  return c;
}
function doc(rel: string, text = "x = 1\n", subscribers = ["g1"]) {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, text);
  const d = { rel, root: "/p", ytext, subscribers: new Set(subscribers) };
  h.docs.push(d);
  return d;
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  h.docs.length = 0;
  reconcileLspSessions();
  h.collab.role = "host";
  h.app.root = "/p";
  h.client = fakeClient();
  h.clientFor.mockReset().mockImplementation(async () => h.client);
  h.pathOk.mockReset().mockResolvedValue(true);
  h.publish.mockReset();
});

const URI = "file:///p/a.py";
const err = (line: number, message = "bad") => ({ range: { start: { line, character: 0 }, end: { line, character: 3 } }, severity: 1, message, source: "Pyright" });
function diagnose(list: any[], version?: number) {
  h.client.diagnostics.set(URI, list);
  h.client.diagnosticVersions.set(URI, version);
  for (const l of h.client.diagnosticListeners) (l as (u: string) => void)(URI);
}
const lastDocs = () => h.publish.mock.calls.at(-1)![1].docs;

test("a doc a guest has open is fed to the server, without any host tab", async () => {
  const d = doc("a.py");
  reconcileLspSessions();
  await settle();
  expect(h.client.feed).toHaveBeenCalledOnce();
  expect(h.client.feeds.get("file:///p/a.py")!()).toBe("x = 1\n");
  d.ytext.insert(0, "# ");
  expect(h.client.feeds.get("file:///p/a.py")!()).toBe("# x = 1\n");
});

test("edits reach the server debounced", async () => {
  vi.useFakeTimers();
  try {
    const d = doc("a.py");
    reconcileLspSessions();
    await vi.advanceTimersByTimeAsync(0);
    d.ytext.insert(0, "a");
    d.ytext.insert(0, "b");
    expect(h.client.change).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.client.change).toHaveBeenCalledTimes(1);
    expect(h.client.change).toHaveBeenCalledWith("file:///p/a.py", "bax = 1\n");
  } finally {
    vi.useRealTimers();
  }
});

test("the last guest leaving ends the feed", async () => {
  const d = doc("a.py");
  reconcileLspSessions();
  await settle();
  d.subscribers.clear();
  reconcileLspSessions();
  expect(h.client.unfeed).toHaveBeenCalledWith("file:///p/a.py");
  expect(lspSessionFor("/p/a.py")).toBeNull();
});

test("a renamed doc closes the old document and opens the new one", async () => {
  const d = doc("a.py");
  reconcileLspSessions();
  await settle();
  d.rel = "b.py";
  reconcileLspSessions();
  await settle();
  expect(h.client.unfeed).toHaveBeenCalledWith("file:///p/a.py");
  expect(h.client.feed.mock.calls.at(-1)![0]).toBe("file:///p/b.py");
});

test("nothing starts for docs without a server, unsaved tabs, other folders, or guests", async () => {
  doc("notes.txt");
  doc("tab:abc.py");
  doc("nobody.py", "", []);
  const old = doc("old.py");
  old.root = "/other";
  reconcileLspSessions();
  await settle();
  expect(h.clientFor).not.toHaveBeenCalled();
  h.docs.length = 0;
  doc("a.py");
  h.collab.role = "guest";
  reconcileLspSessions();
  await settle();
  expect(h.clientFor).not.toHaveBeenCalled();
});

test("a path that stopped being shareable isn't sent to a server", async () => {
  h.pathOk.mockResolvedValue(false);
  doc("a.py");
  reconcileLspSessions();
  await settle();
  expect(h.clientFor).not.toHaveBeenCalled();
});

test("a session stopped while connecting doesn't attach", async () => {
  let resolve!: (c: unknown) => void;
  h.clientFor.mockImplementation(() => new Promise((r) => (resolve = r)));
  const d = doc("a.py");
  reconcileLspSessions();
  await settle();
  d.subscribers.clear();
  reconcileLspSessions();
  resolve(h.client);
  await settle();
  expect(h.client.feed).not.toHaveBeenCalled();
});

test("after a server exit the session connects to the new one", async () => {
  vi.useFakeTimers();
  try {
    doc("a.py");
    reconcileLspSessions();
    await vi.advanceTimersByTimeAsync(0);
    const old = h.client;
    h.client = fakeClient();
    old.alive = false;
    for (const l of [...old.exitListeners]) (l as () => void)();
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.client.feed).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("a server that's missing is looked for again when the doc is used", async () => {
  h.clientFor.mockResolvedValueOnce(null);
  doc("a.py");
  reconcileLspSessions();
  await settle();
  const s = lspSessionFor("/p/a.py")!;
  expect(s.client).toBeNull();
  s.lastTry = 0;
  syncSession(s);
  await settle();
  expect(s.client).toBe(h.client);
});

test("the end of the session stops everything", async () => {
  doc("a.py");
  reconcileLspSessions();
  await settle();
  for (const f of h.endHooks) f();
  expect(h.client.unfeed).toHaveBeenCalled();
  expect(lspSessionFor("/p/a.py")).toBeNull();
});

test("diagnostics go out tagged with the text they were computed for", async () => {
  doc("a.py", "x = (\n");
  reconcileLspSessions();
  await settle();
  diagnose([err(0)], 1);
  const e = lastDocs()["a.py"];
  expect(e.diagnostics).toEqual([err(0)]);
  expect(e.len).toBe(6);
  expect(e.hash).toBe(textHash("x = (\n"));
  expect(e.features).toMatchObject({ hover: true, triggers: ["."] });
});

test("a result for an older version of the text is dropped", async () => {
  doc("a.py");
  reconcileLspSessions();
  await settle();
  h.client.docs.get(URI).version = 3;
  h.publish.mockClear();
  diagnose([err(0)], 2);
  expect(h.publish).not.toHaveBeenCalled();
  diagnose([err(1)], 3);
  expect(lastDocs()["a.py"].diagnostics).toEqual([err(1)]);
});

test("no absolute host path leaves in a diagnostic, and their number is capped", async () => {
  doc("a.py");
  reconcileLspSessions();
  await settle();
  diagnose([err(0, 'Cannot read "/p/src/b.py" or "/home/me/.ssh/id_rsa" (file:///etc/passwd)'), ...Array.from({ length: 900 }, (_, i) => err(i))]);
  const e = lastDocs()["a.py"];
  expect(e.diagnostics).toHaveLength(LSP_LIMITS.diagnostics);
  expect(e.diagnostics[0].message).toBe('Cannot read "src/b.py" or "…/id_rsa" (…/passwd)');
});

test("the snapshot holds what's known, a late guest starts current", async () => {
  doc("a.py");
  reconcileLspSessions();
  await settle();
  diagnose([err(0)], 1);
  const snap = h.topics.get("lsp.docs").snapshot();
  expect(snap.full).toBe(true);
  expect(snap.docs["a.py"].diagnostics).toEqual([err(0)]);
});

test("guests hear when a document's diagnostics are gone", async () => {
  const d = doc("a.py");
  reconcileLspSessions();
  await settle();
  diagnose([err(0)], 1);
  d.subscribers.clear();
  reconcileLspSessions();
  expect(lastDocs()).toEqual({ "a.py": null });
});

test("a dead server's diagnostics are withdrawn", async () => {
  doc("a.py");
  reconcileLspSessions();
  await settle();
  diagnose([err(0)], 1);
  h.client.alive = false;
  for (const l of [...h.client.exitListeners]) (l as () => void)();
  expect(lastDocs()).toEqual({ "a.py": null });
});
