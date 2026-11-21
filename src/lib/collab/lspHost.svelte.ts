/**
 * Code Together, host side of language intelligence: every shared document a guest has open gets
 * a language server document fed from its Y.Text, whichever tab the host is looking at.
 */
import type * as Y from "yjs";
import { collab, sessionEndHooks } from "./collab.svelte";
import { isApproved, isObj, publish, registerMethod, registerTopic, RpcFail } from "./rpc.svelte";
import {
  LSP_LIMITS, NO_FEATURES, capDiagnostics, hostPaths, isKnownLibrary, isRange, mentionsPrivatePath, parsePositionParams, parseRel, parseStamp, scrubPaths, stampOf,
  wireDiagnostic, wireEdits, wireFeatures, wireItem, wireMarkup, type HostPaths,
  type LspDocEntry, type LspDocsPayload, type PositionParams, type TextStamp, type WireDiagnostic, type WireEdit, type WireFix, type WireItem, type WireRange,
} from "./lspProtocol";
import { guestPathOk, guestScope, sharedDocListeners, sharedDocs, type GuestScope, type SharedDocView } from "./share.svelte";
import { app } from "../state.svelte";
import { fsApi, joinPath } from "../api";
import { langFor, type LangInfo } from "../code/languages";
import { clientFor, fileUri, neverInstall, restartListeners, stopGuestServers, toolsDir, uriPath, workspaceSymbols, type LspClient, type WorkspaceSymbol } from "../code/lsp.svelte";
import { editsForDoc, MAX_FIXES, quickFixesFor } from "../code/lspExtension";

/** Delay between an edit and the server hearing about it. */
const CHANGE_MS = 200;
/** Reconnects after a server exit, like an editor (a crashing server is not restarted forever). */
const RECONNECT_MS = 1000;
const RECONNECTS = 3;
/** A session without a server (not installed yet) looks again this often, when it's being used. */
const RETRY_MS = 5000;
/**
 * A server that doesn't say which version a result is for: only text that has been quiet this long
 * counts as analysed. Anything earlier could be the answer for the text before the last edit.
 */
const UNVERSIONED_QUIET_MS = 800;
/** A hover waits this long to learn where its symbol is defined. */
const HOVER_LOCATE_MS = 1200;
/** Toolchain folders, in addition to the home, temp and tools folders of this machine. */
const SYSTEM_DIRS = ["/usr/lib", "/usr/lib64", "/usr/include", "/usr/local", "/opt", "/nix/store", "/tmp", "/var/tmp", "/private/tmp"];

declare module "./rpc.svelte" {
  interface RpcTopics {
    "lsp.docs": LspDocsPayload;
  }
  interface RpcMethods {
    "lsp.completion": { params: PositionParams & { trigger?: string; explicit: boolean }; result: { list: number; incomplete: boolean; total: number; items: WireItem[] } };
    "lsp.resolve": { params: { path: string; list: number; id: number; at: TextStamp }; result: { detail?: string; documentation?: unknown; additionalTextEdits?: WireEdit[]; base?: TextStamp } | null };
    "lsp.hover": { params: PositionParams; result: { contents: unknown; range?: WireRange } | null };
    "lsp.definition": { params: PositionParams; result: LspTarget | null };
    "lsp.format": { params: { path: string; at: TextStamp }; result: { base: TextStamp; edits: WireEdit[] } };
    "lsp.fixes": { params: { path: string; rev: number }; result: { base: TextStamp; fixes: WireFix[][] } | null };
    "lsp.symbols": { params: { query: string }; result: WorkspaceSymbol[] };
  }
}

/** Where a definition is: a place in the project, or just the name of a file guests can't open. */
export type LspTarget = { path: string; line: number; character: number } | { outside: string };

export interface LspSession {
  doc: SharedDocView;
  ytext: Y.Text;
  abs: string;
  uri: string;
  lang: LangInfo;
  client: LspClient | null;
  connecting: Promise<void> | null;
  lastTry: number;
  reconnects: number;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  onText: () => void;
  onDiagnostics: (uri: string) => void;
  onExit: () => void;
  /** What guests currently know about this document. */
  entry: LspDocEntry | null;
  /** The server's diagnostics behind `entry`, unchanged (for its code actions). */
  raw: any[];
  /** Quick fixes of the current entry, looked up once however many guests ask. */
  fixes: { rev: number; result: Promise<WireFix[][]> } | null;
  /** The text's fingerprint, kept until the text changes. */
  stamp: TextStamp | null;
  paths: HostPaths;
  /** A result from a server without versions, waiting for the text to be quiet. */
  hold?: ReturnType<typeof setTimeout>;
}

/** Revisions are unique across sessions, so a guest never takes a new entry for one it has shown. */
let nextRev = 1;

const sessions = new Map<string, LspSession>();
/** Documents guests have open beyond the session limit, and what they were told. */
const limited = new Map<string, LspDocEntry>();

const unavailableEntry = (unavailable: "no_server" | "limit"): LspDocEntry => ({ rev: nextRev++, hash: "", len: 0, diagnostics: [], features: NO_FEATURES, unavailable });

let knownDirs: Promise<string[]> | null = null;
/** This machine's folders whose paths must not reach guests. */
function hostDirs() {
  return (knownDirs ??= (async () => {
    const temp = await import("@tauri-apps/api/path").then((m) => m.tempDir()).catch(() => null);
    const [home, tools] = await Promise.all([Promise.resolve().then(() => fsApi.homeDir()).catch(() => null), toolsDir().catch(() => null)]);
    return [...SYSTEM_DIRS, ...[home, tools, temp].filter((d): d is string => !!d)];
  })());
}

const wanted = () => {
  const out = new Map<string, { doc: SharedDocView; lang: LangInfo }>();
  if (collab.role !== "host") return out;
  for (const doc of sharedDocs()) {
    // Unsaved tabs have no file a server could resolve imports from, on the host either.
    if (!doc.subscribers.size || !doc.root || doc.root !== app.root || doc.rel.startsWith("tab:")) continue;
    const lang = langFor(doc.rel);
    if (lang?.server) out.set(joinPath(doc.root, doc.rel), { doc, lang });
  }
  return out;
};

/** Brings the running sessions in line with the documents guests have open. */
export function reconcileLspSessions() {
  const want = wanted();
  for (const [abs, s] of sessions) if (want.get(abs)?.doc !== s.doc || s.ytext !== s.doc.ytext) stopSession(s);
  const over = new Set<string>();
  for (const [abs, { doc, lang }] of want) {
    if (sessions.has(abs)) continue;
    if (sessions.size < LSP_LIMITS.sessions) startSession(abs, doc, lang);
    else over.add(doc.rel);
  }
  for (const rel of [...limited.keys()]) {
    if (over.has(rel)) continue;
    limited.delete(rel);
    // A document that got a session reports through it.
    if (collab.role === "host" && ![...sessions.values()].some((s) => s.doc.rel === rel)) publish("lsp.docs", { docs: { [rel]: null } });
  }
  for (const rel of over) {
    if (limited.has(rel)) continue;
    const entry = unavailableEntry("limit");
    limited.set(rel, entry);
    publish("lsp.docs", { docs: { [rel]: entry } });
  }
}

function startSession(abs: string, doc: SharedDocView, lang: LangInfo) {
  const s: LspSession = {
    doc,
    ytext: doc.ytext,
    abs,
    uri: fileUri(abs),
    lang,
    client: null,
    connecting: null,
    lastTry: 0,
    reconnects: RECONNECTS,
    stopped: false,
    stamp: null,
    paths: hostPaths(doc.root ?? ""),
    onText: () => {
      s.stamp = null;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => syncSession(s), CHANGE_MS);
    },
    onDiagnostics: (uri) => {
      if (uri === s.uri) publishEntry(s);
    },
    entry: null,
    raw: [],
    fixes: null,
    onExit: () => {
      detach(s);
      clearEntry(s); // the dead server's diagnostics are stale
      if (s.stopped || s.reconnects-- <= 0) return;
      setTimeout(() => !s.stopped && !s.client && void connect(s), RECONNECT_MS);
    },
  };
  sessions.set(abs, s);
  s.ytext.observe(s.onText);
  void connect(s);
}

function detach(s: LspSession) {
  clearTimeout(s.hold);
  const c = s.client;
  if (!c) return;
  c.diagnosticListeners.delete(s.onDiagnostics);
  c.exitListeners.delete(s.onExit);
  s.client = null;
  if (c.alive) c.unfeed(s.uri);
}

function stopSession(s: LspSession) {
  s.stopped = true;
  clearTimeout(s.timer);
  s.ytext.unobserve(s.onText);
  detach(s);
  clearEntry(s);
  if (sessions.get(s.abs) === s) sessions.delete(s.abs);
}

function clearEntry(s: LspSession) {
  if (!s.entry) return;
  const rel = s.entry && relOfEntry.get(s);
  s.entry = null;
  s.raw = [];
  s.fixes = null;
  relOfEntry.delete(s);
  if (rel !== undefined && collab.role === "host") publish("lsp.docs", { docs: { [rel]: null } });
}

/** The name a session's entry was published under (the doc can be renamed afterwards). */
const relOfEntry = new Map<LspSession, string>();

/**
 * Guests get the diagnostics together with the exact text they belong to. A result for an older
 * version than the server has is dropped: the one for the current version is on its way.
 */
function publishEntry(s: LspSession) {
  const c = s.client;
  const root = s.doc.root;
  const sent = c?.docs.get(s.uri);
  if (!c || !sent || !root || collab.role !== "host") return;
  const version = c.diagnosticVersions.get(s.uri);
  if (version !== undefined && version !== sent.version) return;
  if (version === undefined && c.diagnostics.has(s.uri)) {
    const age = Date.now() - (c.textChangedAt.get(s.uri) ?? 0);
    if (age < UNVERSIONED_QUIET_MS) return holdForQuiet(s, c, UNVERSIONED_QUIET_MS - age);
  }
  clearTimeout(s.hold);
  const raw = (c.diagnostics.get(s.uri) ?? []).slice(0, LSP_LIMITS.diagnostics);
  const wired = raw.map((d) => ({ raw: d, wire: wireDiagnostic(d, s.paths) })).filter((d): d is { raw: any; wire: WireDiagnostic } => !!d.wire);
  const { kept, dropped } = capDiagnostics(wired);
  s.raw = kept.map((d) => d.raw);
  s.fixes = null;
  s.entry = { rev: nextRev++, ...stampOf(sent.text), diagnostics: kept.map((d) => d.wire), features: wireFeatures(c.capabilities), ...(dropped ? { truncated: dropped } : {}) };
  relOfEntry.set(s, s.doc.rel);
  publish("lsp.docs", { docs: { [s.doc.rel]: s.entry } });
}

/** Once the text is quiet, asks for a result that can only be about this text. */
function holdForQuiet(s: LspSession, c: LspClient, ms: number) {
  clearTimeout(s.hold);
  s.hold = setTimeout(() => {
    if (s.stopped || s.client !== c) return;
    const left = UNVERSIONED_QUIET_MS - (Date.now() - (c.textChangedAt.get(s.uri) ?? 0));
    if (left > 0) holdForQuiet(s, c, left);
    else c.resend(s.uri);
  }, ms);
}

/** Tells the server the current text now. */
export function syncSession(s: LspSession) {
  clearTimeout(s.timer);
  if (s.stopped) return;
  if (s.client) s.client.change(s.uri, s.ytext.toString());
  else if (Date.now() - s.lastTry >= RETRY_MS) void connect(s);
}

function connect(s: LspSession): Promise<void> {
  if (s.connecting) return s.connecting;
  s.lastTry = Date.now();
  const run = (async () => {
    const root = s.doc.root;
    // The doc was checked when the guest opened it; a folder can become a symlink since.
    if (!root || !(await guestPathOk(s.doc.rel, root)) || s.stopped) return;
    s.paths = hostPaths(root, await hostDirs());
    if (s.stopped) return;
    const c = await clientFor(s.lang, s.abs, root, neverInstall).catch(() => null);
    if (s.stopped || s.client) return;
    if (!c) return markNoServer(s);
    s.client = c;
    c.feed(s.uri, s.lang.lspId, () => s.ytext.toString());
    c.diagnosticListeners.add(s.onDiagnostics);
    c.exitListeners.add(s.onExit);
    publishEntry(s); // the server may know this file already
  })().finally(() => {
    s.connecting = null;
  });
  s.connecting = run;
  return run;
}

/** The host has no server for this file (not installed, or over the limit): guests are told. */
function markNoServer(s: LspSession) {
  if (s.entry?.unavailable === "no_server") return;
  s.entry = unavailableEntry("no_server");
  s.raw = [];
  s.fixes = null;
  relOfEntry.set(s, s.doc.rel);
  publish("lsp.docs", { docs: { [s.doc.rel]: s.entry } });
}

registerTopic({
  name: "lsp.docs",
  capability: null,
  snapshot: () => {
    const docs: Record<string, LspDocEntry> = {};
    for (const s of sessions.values()) if (s.entry) docs[s.doc.rel] = s.entry;
    for (const [rel, e] of limited) docs[rel] = e;
    return { full: true, docs };
  },
});

// ------------------------------------------------------------------ requests from guests

/** How long a request waits for the guest's last keystrokes, which travel separately. */
const SETTLE_MS = 300;
const SETTLE_STEP_MS = 20;

const refuse = (code: string): never => {
  throw new RpcFail(code);
};

/** The session of a document this guest has open, with a running server. */
async function sessionFor(rel: string, peer: string, signal: AbortSignal): Promise<{ s: LspSession; c: LspClient; scope: GuestScope; paths: HostPaths }> {
  const scope = guestScope() ?? refuse("unavailable");
  if (!(await scope.check(rel)) || !scope.live() || signal.aborted) refuse("unavailable");
  const s = sessions.get(scope.abs(rel));
  if (!s || s.doc.rel !== rel || !s.doc.subscribers.has(peer)) return refuse("not_open");
  if (!s.client && Date.now() - s.lastTry >= RETRY_MS) await connect(s);
  if (signal.aborted || s.stopped) refuse("unavailable");
  return { s, c: s.client ?? refuse("no_server"), scope, paths: s.paths };
}

/** Whether the shared text is this one. Hashes at most once per state of the text. */
const isAt = (s: LspSession, at: TextStamp) => s.ytext.length === at.len && (s.stamp ??= stampOf(s.ytext.toString())).hash === at.hash;

/** Waits briefly until the host has the text the guest is looking at. False if it never came. */
async function reaches(s: LspSession, at: TextStamp, signal: AbortSignal) {
  const same = () => isAt(s, at);
  for (let waited = 0; !same(); waited += SETTLE_STEP_MS) {
    if (waited >= SETTLE_MS || signal.aborted || s.stopped) return false;
    await new Promise((r) => setTimeout(r, SETTLE_STEP_MS));
  }
  return true;
}

/** A server request that ends with the caller's signal; a failing server is a stable error code. */
async function ask<T = any>(c: LspClient, method: string, params: unknown, signal: AbortSignal, timeoutMs = 10_000): Promise<T> {
  if (signal.aborted) refuse("cancelled");
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new RpcFail("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([c.request<T>(method, params, timeoutMs), aborted]);
  } catch (e) {
    if (e instanceof RpcFail) throw e;
    console.warn(`lsp ${method}`, e);
    return refuse("server_error");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The session, synced to the guest's text. Reads go ahead on a near miss; `exact` refuses it. */
async function synced(rel: string, at: TextStamp, peer: string, signal: AbortSignal, exact = false) {
  const got = await sessionFor(rel, peer, signal);
  const same = await reaches(got.s, at, signal);
  if (signal.aborted || got.s.stopped) refuse("unavailable");
  if (exact && !same) refuse("stale");
  syncSession(got.s);
  return { ...got, same };
}

/** Host: the items of each guest's last completion, the only ones `lsp.resolve` may name. */
const completions = new Map<string, { rel: string; list: number; items: any[] }>();
let nextList = 1;

const stringOr = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);

registerMethod({
  name: "lsp.completion",
  capability: "edit", // nothing can be inserted without it
  validate: (raw) => {
    const p = parsePositionParams(raw);
    if (!p || !isObj(raw) || typeof raw.explicit !== "boolean") return null;
    if (raw.trigger !== undefined && (typeof raw.trigger !== "string" || raw.trigger.length > 2)) return null;
    return { ...p, explicit: raw.explicit, ...(raw.trigger === undefined ? {} : { trigger: raw.trigger as string }) };
  },
  handle: async ({ path, at, pos, trigger, explicit }, { peer, signal }) => {
    const { s, c, paths } = await synced(path, at, peer, signal);
    // Only a character the server itself announced counts as a trigger.
    const triggered = trigger !== undefined && (c.capabilities.completionProvider?.triggerCharacters ?? [".", ":", ">"]).includes(trigger);
    const res: any = await ask(c, "textDocument/completion", {
      textDocument: { uri: s.uri },
      position: pos,
      context: triggered ? { triggerKind: 2, triggerCharacter: trigger } : { triggerKind: explicit ? 1 : 3 },
    }, signal);
    const all: any[] = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
    const sorted = all.filter((i) => typeof i?.label === "string").sort((a, b) => String(a.sortText ?? a.label).localeCompare(String(b.sortText ?? b.label)));
    const kept = sorted.slice(0, LSP_LIMITS.completions);
    const items: WireItem[] = [];
    const text = s.ytext.toString();
    kept.forEach((item, i) => {
      const w = wireItem(item, i, paths, text);
      if (w) items.push(w);
    });
    for (const p of completions.keys()) if (!isApproved(p)) completions.delete(p);
    const list = nextList++;
    completions.set(peer, { rel: path, list, items: kept });
    return { list, incomplete: !!res?.isIncomplete, total: sorted.length, items };
  },
});

registerMethod({
  name: "lsp.resolve",
  capability: "edit",
  validate: (raw) => {
    if (!isObj(raw)) return null;
    const path = parseRel(raw.path), at = parseStamp(raw.at);
    if (!path || !at || !Number.isSafeInteger(raw.list) || !Number.isInteger(raw.id) || (raw.id as number) < 0 || (raw.id as number) >= LSP_LIMITS.completions) return null;
    return { path, list: raw.list as number, id: raw.id as number, at };
  },
  handle: async ({ path, list, id, at }, { peer, signal }) => {
    // The server gets its own item back, never one a guest wrote.
    const last = completions.get(peer);
    const item = last?.rel === path && last.list === list ? last.items[id] : undefined;
    if (!item) return null;
    const { s, c, paths, same } = await synced(path, at, peer, signal);
    if (!c.capabilities.completionProvider?.resolveProvider) return null;
    const full: any = await ask(c, "completionItem/resolve", item, signal, 5000);
    const w = wireItem({ ...full, label: item.label }, id, paths, s.ytext.toString());
    if (!w) return null;
    // Edits only for the text they were computed on, and tied to it.
    const edits = same && isAt(s, at) ? w.additionalTextEdits : undefined;
    return { detail: w.detail, documentation: w.documentation, ...(edits ? { additionalTextEdits: edits, base: at } : {}) };
  },
});

/** Where the symbol under the cursor is defined, or null if that can't be told in time. */
async function definedAt(s: LspSession, c: LspClient, pos: PositionParams["pos"], signal: AbortSignal): Promise<any[] | null> {
  if (!c.capabilities.definitionProvider) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), HOVER_LOCATE_MS)));
  try {
    const res = await Promise.race([ask(c, "textDocument/definition", { textDocument: { uri: s.uri }, position: pos }, signal, HOVER_LOCATE_MS), late]);
    const list = Array.isArray(res) ? res : res ? [res] : [];
    return list.length && list.every((l) => typeof (l?.targetUri ?? l?.uri) === "string") ? list : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether guests may read about something defined here: the project or a public library. */
async function readableLocation(uri: string, scope: GuestScope) {
  if (uri.startsWith("jdt://")) return true; // the JDK's own classes
  if (!uri.startsWith("file://")) return false;
  const abs = uriPath(uri);
  const rel = scope.rel(abs);
  if (rel) return scope.check(rel);
  return !abs.startsWith(scope.root + "/") && isKnownLibrary(abs);
}

const markupText = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map(markupText).join("\n") : typeof c?.value === "string" ? c.value : "");

registerMethod({
  name: "lsp.hover",
  capability: null,
  validate: parsePositionParams,
  handle: async ({ path, at, pos }, { peer, signal }) => {
    const { s, c, scope, paths } = await synced(path, at, peer, signal);
    if (!c.capabilities.hoverProvider) return null;
    const [res, where] = await Promise.all([
      ask<any>(c, "textDocument/hover", { textDocument: { uri: s.uri }, position: pos }, signal),
      definedAt(s, c, pos, signal),
    ]);
    if (!res) return null;
    if (where) {
      for (const l of where) if (!(await readableLocation(l.targetUri ?? l.uri, scope))) return null;
    } else if (mentionsPrivatePath(markupText(res.contents), paths)) return null;
    if (signal.aborted || !scope.live()) return null;
    const contents = wireMarkup(res.contents, paths);
    if (contents === undefined) return null;
    return { contents, ...(isRange(res.range) ? { range: res.range } : {}) };
  },
});

/** A server location as guests may see it: a project file, or only the name of anything else. */
async function targetFor(loc: any, scope: GuestScope): Promise<LspTarget | null> {
  const uri = loc?.targetUri ?? loc?.uri;
  const range = loc?.targetSelectionRange ?? loc?.range;
  if (typeof uri !== "string" || !Number.isSafeInteger(range?.start?.line) || !Number.isSafeInteger(range?.start?.character)) return null;
  if (!uri.startsWith("file://")) return { outside: (uri.split(/[/\\?#]/).pop() ?? "").slice(0, 120) };
  const abs = uriPath(uri);
  const rel = scope.rel(abs);
  // Also through symlinks: what isn't shared is named, never opened.
  if (!rel || !(await scope.check(rel))) return { outside: (abs.split("/").pop() ?? "").slice(0, 120) };
  return { path: rel, line: range.start.line, character: range.start.character };
}

registerMethod({
  name: "lsp.definition",
  capability: null,
  validate: parsePositionParams,
  handle: async ({ path, at, pos }, { peer, signal }) => {
    const { s, c, scope } = await synced(path, at, peer, signal);
    const res: any = await ask(c, "textDocument/definition", { textDocument: { uri: s.uri }, position: pos }, signal);
    const target = await targetFor(Array.isArray(res) ? res[0] : res, scope);
    return scope.live() ? target : null;
  },
});

registerMethod({
  name: "lsp.format",
  capability: "edit",
  validate: (raw) => {
    const path = isObj(raw) ? parseRel(raw.path) : null;
    const at = isObj(raw) ? parseStamp(raw.at) : null;
    return path && at ? { path, at } : null;
  },
  handle: async ({ path, at }, { peer, signal }) => {
    const { s, c, paths } = await synced(path, at, peer, signal, true);
    if (!c.capabilities.documentFormattingProvider) refuse("unsupported");
    const before = s.ytext.toString();
    const res = await ask<unknown>(c, "textDocument/formatting", { textDocument: { uri: s.uri }, options: { tabSize: 4, insertSpaces: true } }, signal);
    // Someone typed meanwhile: these positions no longer fit.
    if (s.stopped || s.ytext.toString() !== before) refuse("stale");
    if (res !== null && !Array.isArray(res)) refuse("server_error");
    const edits = res === null ? [] : wireEdits(res, paths, before);
    return { base: stampOf(before), edits: edits ?? refuse("host_path") };
  },
});

/** The quick fixes the host's own editor would offer. Commands are never run, for anyone. */
async function lookUpFixes(s: LspSession, c: LspClient, paths: HostPaths): Promise<WireFix[][]> {
  const raw = s.raw;
  const text = s.ytext.toString();
  return Promise.all(
    raw.map(async (d, i) => {
      if (i >= MAX_FIXES) return [];
      const fixes: WireFix[] = [];
      for (const a of (await quickFixesFor(c, s.uri, d)).slice(0, LSP_LIMITS.fixesPerDiagnostic)) {
        const edits = wireEdits(editsForDoc(a.edit, s.uri), paths, text);
        if (edits?.length && typeof a.title === "string") fixes.push({ title: scrubPaths(a.title, paths).slice(0, LSP_LIMITS.fixTitle), edits });
      }
      return fixes;
    }),
  );
}

registerMethod({
  name: "lsp.fixes",
  capability: "edit",
  validate: (raw) => {
    const path = isObj(raw) ? parseRel(raw.path) : null;
    return path && isObj(raw) && Number.isSafeInteger(raw.rev) ? { path, rev: raw.rev as number } : null;
  },
  handle: async ({ path, rev }, { peer, signal }) => {
    const { s, c, paths } = await sessionFor(path, peer, signal);
    const entry = s.entry;
    if (!entry || entry.rev !== rev) return null;
    if (s.fixes?.rev !== rev) s.fixes = { rev, result: lookUpFixes(s, c, paths) };
    const fixes = await s.fixes.result;
    return !signal.aborted && s.entry?.rev === rev ? { base: { len: entry.len, hash: entry.hash }, fixes } : null;
  },
});

registerMethod({
  name: "lsp.symbols",
  capability: null,
  validate: (raw) => {
    const query = isObj(raw) ? stringOr(raw.query, LSP_LIMITS.query) : undefined;
    return query ? { query } : null;
  },
  handle: async ({ query }, { signal }) => {
    const scope = guestScope() ?? refuse("unavailable");
    const found = await workspaceSymbols(query);
    if (signal.aborted || !scope.live()) refuse("unavailable");
    const paths = hostPaths(scope.root, await hostDirs());
    const allowed = new Map<string, boolean>();
    const out: WorkspaceSymbol[] = [];
    for (const sym of found) {
      if (out.length >= LSP_LIMITS.symbols) break;
      const rel = scope.rel(sym.path);
      if (!rel) continue;
      if (!allowed.has(rel)) allowed.set(rel, await scope.check(rel));
      if (!allowed.get(rel)) continue;
      out.push({
        name: scrubPaths(sym.name, paths).slice(0, LSP_LIMITS.label),
        kind: sym.kind,
        ...(sym.containerName ? { containerName: scrubPaths(sym.containerName, paths).slice(0, LSP_LIMITS.label) } : {}),
        path: rel,
        line: sym.line,
        character: sym.character,
      });
    }
    return out;
  },
});

export const lspSessionFor = (abs: string) => sessions.get(abs) ?? null;

// A change of the shared docs can come in a burst (a guest joining opens all tabs).
let queued = false;
sharedDocListeners.add(() => {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    reconcileLspSessions();
    // A guest that left or closed the doc: its completion list goes too.
    for (const [peer, e] of completions) if (!isApproved(peer) || !sharedDocs().some((d) => d.rel === e.rel && d.subscribers.has(peer))) completions.delete(peer);
  });
});

// A restarted server: sessions without a client connect again.
restartListeners.add(() => {
  for (const s of sessions.values()) {
    s.reconnects = RECONNECTS;
    if (!s.client) void connect(s);
  }
});

sessionEndHooks.push(() => {
  for (const s of [...sessions.values()]) stopSession(s);
  limited.clear();
  completions.clear();
  knownDirs = null;
  stopGuestServers();
});

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
