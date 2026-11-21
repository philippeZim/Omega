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
  symbols: vi.fn(),
  topics: new Map<string, any>(),
  methods: new Map<string, any>(),
}));
vi.mock("./collab.svelte", () => ({ collab: h.collab, sessionEndHooks: h.endHooks, send: vi.fn(), onCollabMessage: vi.fn() }));
vi.mock("./rpc.svelte", () => ({
  RpcFail: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  isApproved: () => true,
  isObj: (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v),
  publish: h.publish, registerTopic: (d: any) => void h.topics.set(d.name, d), registerMethod: (d: any) => void h.methods.set(d.name, d),
}));
vi.mock("./share.svelte", () => ({
  sharedDocs: () => h.docs,
  sharedDocListeners: h.listeners,
  guestPathOk: h.pathOk,
  guestScope: () => ({
    root: "/p",
    live: () => h.app.root === "/p",
    check: (rel: string) => h.pathOk(rel, "/p"),
    abs: (rel: string) => `/p/${rel}`,
    rel: (abs: string) => (abs.startsWith("/p/") && !abs.includes("/.git/") ? abs.slice(3) : null),
  }),
}));
vi.mock("../state.svelte", () => ({ app: h.app }));
vi.mock("../api", () => ({ joinPath: (a: string, b: string) => `${a}/${b}` }));
vi.mock("../code/languages", () => ({ langFor: (p: string) => (p.endsWith(".py") ? { server: "python", lspId: "python" } : null) }));
vi.mock("../code/lsp.svelte", () => ({
  clientFor: h.clientFor,
  fileUri: (p: string) => `file://${p}`,
  neverInstall: async () => false,
  restartListeners: h.restart,
  uriPath: (u: string) => decodeURIComponent(u.replace(/^file:\/\//, "")),
  workspaceSymbols: h.symbols,
}));
vi.mock("../code/lspExtension", () => ({
  MAX_FIXES: 30,
  editsForDoc: (edit: any, uri: string) => edit?.changes?.[uri] ?? [],
  quickFixesFor: async (c: any, uri: string, d: any) => (await c.request("textDocument/codeAction", { textDocument: { uri }, range: d.range })).filter((a: any) => a.edit),
}));

const { reconcileLspSessions, lspSessionFor, syncSession } = await import("./lspHost.svelte");
const { LSP_LIMITS, textHash } = await import("./lspProtocol");

function fakeClient() {
  const c = {
    alive: true,
    capabilities: { hoverProvider: true, documentFormattingProvider: true, codeActionProvider: true, completionProvider: { triggerCharacters: ["."], resolveProvider: true } },
    docs: new Map<string, { version: number; text: string }>(),
    diagnostics: new Map<string, any[]>(),
    diagnosticVersions: new Map<string, number | undefined>(),
    feeds: new Map<string, () => string>(),
    change: vi.fn(),
    request: vi.fn(async (_m: string, _p: unknown, _t?: number): Promise<any> => null),
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

// ---------------------------------------------------------------- requests

const ctx = (peer = "g1") => ({ peer, signal: new AbortController().signal });
const run = (name: string, params: any, c = ctx()) => {
  const def = h.methods.get(name);
  const checked = def.validate(params);
  if (checked === null) throw new Error("invalid_params");
  return def.handle(checked, c);
};
async function ready(text = "x = 1\n", rel = "a.py") {
  const d = doc(rel, text);
  reconcileLspSessions();
  await settle();
  return d;
}
const at = (text: string) => ({ len: text.length, hash: textHash(text) });
const P = { line: 0, character: 1 };

test.each(["lsp.completion", "lsp.hover", "lsp.definition"])("%s refuses bad params", (name) => {
  const def = h.methods.get(name);
  const good = { path: "a.py", at: at("x"), pos: P, explicit: true };
  expect(def.validate(good)).not.toBeNull();
  for (const bad of [null, "x", { ...good, path: 3 }, { ...good, path: "" }, { ...good, path: "a\0b" }, { ...good, path: "x".repeat(5000) }, { ...good, pos: { line: -1, character: 0 } }, { ...good, pos: { line: 1.5, character: 0 } }, { ...good, at: { len: 1, hash: "y".repeat(40) } }])
    expect(def.validate(bad)).toBeNull();
});

test("only read features are open to every guest; edits need the edit right", () => {
  expect(h.methods.get("lsp.format").capability).toBe("edit");
  expect(h.methods.get("lsp.fixes").capability).toBe("edit");
  for (const m of ["lsp.completion", "lsp.resolve", "lsp.hover", "lsp.definition", "lsp.symbols"]) expect(h.methods.get(m).capability).toBeNull();
});

test("no method can run a server command", () => {
  expect([...h.methods.keys()].filter((m) => /command|execute|apply/i.test(m))).toEqual([]);
});

test("a guest can't ask about a doc it doesn't have open", async () => {
  await ready();
  await expect(run("lsp.hover", { path: "a.py", at: at("x = 1\n"), pos: P }, ctx("g2"))).rejects.toMatchObject({ code: "not_open" });
});

test("a path the scope refuses never reaches the server", async () => {
  await ready();
  h.pathOk.mockResolvedValue(false);
  await expect(run("lsp.hover", { path: "../secret.py", at: at(""), pos: P })).rejects.toMatchObject({ code: "unavailable" });
  expect(h.client.request).not.toHaveBeenCalled();
});

test("hover: the server's text comes back without host paths", async () => {
  await ready();
  h.client.request.mockResolvedValue({ contents: { kind: "markdown", value: "from /p/src/b.py and /home/me/x/y.py" }, range: { start: P, end: P } });
  const r = await run("lsp.hover", { path: "a.py", at: at("x = 1\n"), pos: P });
  expect(r.contents.value).toBe("from src/b.py and …/y.py");
  expect(h.client.request.mock.calls[0][1].textDocument.uri).toBe(URI);
});

test("a request syncs the server first", async () => {
  await ready();
  await run("lsp.hover", { path: "a.py", at: at("x = 1\n"), pos: P });
  expect(h.client.change).toHaveBeenCalledWith(URI, "x = 1\n");
});

test("a request waits for the keystrokes the guest sent just before", async () => {
  const d = await ready();
  const p = run("lsp.hover", { path: "a.py", at: at("ax = 1\n"), pos: P });
  await new Promise((r) => setTimeout(r, 30));
  expect(h.client.request).not.toHaveBeenCalled();
  d.ytext.insert(0, "a");
  await p;
  expect(h.client.change).toHaveBeenLastCalledWith(URI, "ax = 1\n");
});

test("a cancelled request ends at once", async () => {
  await ready();
  h.client.request.mockImplementation(() => new Promise(() => {}));
  const c = new AbortController();
  const p = run("lsp.hover", { path: "a.py", at: at("x = 1\n"), pos: P }, { peer: "g1", signal: c.signal });
  await settle();
  c.abort();
  await expect(p).rejects.toMatchObject({ code: "cancelled" });
});

test("a failing server is a stable code, without its message", async () => {
  await ready();
  h.client.request.mockRejectedValue(new Error("crash in /home/me/server.js"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(run("lsp.hover", { path: "a.py", at: at("x = 1\n"), pos: P })).rejects.toMatchObject({ code: "server_error" });
  warn.mockRestore();
});

test("definition inside the project is a relative path", async () => {
  await ready();
  h.client.request.mockResolvedValue([{ uri: "file:///p/src/b.py", range: { start: { line: 4, character: 2 }, end: P } }]);
  expect(await run("lsp.definition", { path: "a.py", at: at("x = 1\n"), pos: P })).toEqual({ path: "src/b.py", line: 4, character: 2 });
});

test.each([
  ["outside the project", "file:///usr/lib/python/builtins.pyi", "builtins.pyi"],
  ["inside .git", "file:///p/.git/config", "config"],
  ["a non-file URI", "jdt://contents/rt.jar/java.lang/String.class", "String.class"],
])("definition %s only gives a name", async (_n, uri, name) => {
  await ready();
  h.client.request.mockResolvedValue({ uri, range: { start: P, end: P } });
  expect(await run("lsp.definition", { path: "a.py", at: at("x = 1\n"), pos: P })).toEqual({ outside: name });
});

test("definition through a symlink out of the project only gives a name", async () => {
  await ready();
  h.client.request.mockResolvedValue({ uri: "file:///p/ext/secret.py", range: { start: P, end: P } });
  h.pathOk.mockImplementation(async (rel: string) => rel !== "ext/secret.py");
  expect(await run("lsp.definition", { path: "a.py", at: at("x = 1\n"), pos: P })).toEqual({ outside: "secret.py" });
});

test("completion: capped, only announced triggers, nothing with the host's path", async () => {
  await ready();
  const items = Array.from({ length: 400 }, (_, i) => ({ label: `i${String(i).padStart(3, "0")}`, insertText: i === 1 ? "/p/secret" : "ok" }));
  h.client.request.mockResolvedValue({ isIncomplete: true, items });
  const r = await run("lsp.completion", { path: "a.py", at: at("x = 1\n"), pos: P, explicit: false, trigger: "#" });
  expect(r.items).toHaveLength(299);
  expect(r.total).toBe(400);
  expect(r.incomplete).toBe(true);
  expect(JSON.stringify(r)).not.toContain("/p/");
  expect(h.client.request.mock.calls[0][1].context).toEqual({ triggerKind: 3 });
});

test("resolve sends the server's own item, and only of the guest's last list", async () => {
  await ready();
  const item = { label: "foo", data: { secret: 1 } };
  h.client.request.mockResolvedValueOnce([item]);
  const r = await run("lsp.completion", { path: "a.py", at: at("x = 1\n"), pos: P, explicit: true });
  h.client.request.mockResolvedValueOnce({ ...item, detail: "def foo()", documentation: "see /p/b.py" });
  const full = await run("lsp.resolve", { path: "a.py", list: r.list, id: 0 });
  expect(h.client.request.mock.calls[1][1]).toBe(item);
  expect(full).toMatchObject({ detail: "def foo()", documentation: "see b.py" });
  expect(await run("lsp.resolve", { path: "a.py", list: r.list + 1, id: 0 })).toBeNull();
  expect(await run("lsp.resolve", { path: "a.py", list: r.list, id: 5 })).toBeNull();
});

test("format: edits are tied to the text they were computed for", async () => {
  await ready("x=1\n");
  const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "x = 1" }];
  h.client.request.mockResolvedValue(edits);
  expect(await run("lsp.format", { path: "a.py", at: at("x=1\n") })).toEqual({ base: at("x=1\n"), edits });
});

test("format refuses when the guest's text never arrives", async () => {
  await ready("x=1\n");
  await expect(run("lsp.format", { path: "a.py", at: at("other") })).rejects.toMatchObject({ code: "stale" });
  expect(h.client.request).not.toHaveBeenCalled();
});

test("format refuses when someone typed while the server worked", async () => {
  const d = await ready("x=1\n");
  h.client.request.mockImplementation(async () => {
    d.ytext.insert(0, "#");
    return [];
  });
  await expect(run("lsp.format", { path: "a.py", at: at("x=1\n") })).rejects.toMatchObject({ code: "stale" });
});

test("quick fixes: only this file's edits, and command-only actions are left out", async () => {
  await ready();
  diagnose([err(0)], 1);
  const rev = lastDocs()["a.py"].rev;
  h.client.request.mockResolvedValue([
    { title: "Fix", kind: "quickfix", edit: { changes: { [URI]: [{ range: { start: P, end: P }, newText: "y" }], "file:///p/other.py": [{ range: { start: P, end: P }, newText: "z" }] } } },
    { title: "Run", kind: "quickfix", command: { command: "rm", arguments: ["-rf"] } },
  ]);
  const r = await run("lsp.fixes", { path: "a.py", rev });
  expect(r.fixes).toEqual([[{ title: "Fix", edits: [{ range: { start: P, end: P }, newText: "y" }] }]]);
  expect(h.client.request.mock.calls.every(([m]: [string]) => m === "textDocument/codeAction")).toBe(true);
});

test("quick fixes are for the current revision only", async () => {
  await ready();
  diagnose([err(0)], 1);
  const rev = lastDocs()["a.py"].rev;
  diagnose([err(1)], 1);
  expect(await run("lsp.fixes", { path: "a.py", rev })).toBeNull();
});

test("symbols: project files as relative paths, the rest left out", async () => {
  await ready();
  h.pathOk.mockImplementation(async (rel: string) => rel !== "ext/link.py");
  h.symbols.mockResolvedValue([
    { name: "a", kind: 12, path: "/p/src/b.py", line: 1, character: 0, containerName: "/p/src/b.py" },
    { name: "b", kind: 12, path: "/usr/lib/x.py", line: 1, character: 0 },
    { name: "c", kind: 12, path: "/p/.git/hook.py", line: 1, character: 0 },
    { name: "d", kind: 12, path: "/p/ext/link.py", line: 1, character: 0 },
  ]);
  expect(await run("lsp.symbols", { query: "a" })).toEqual([{ name: "a", kind: 12, path: "src/b.py", line: 1, character: 0, containerName: "src/b.py" }]);
});
