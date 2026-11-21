/**
 * Code Together, host side of language intelligence: every shared document a guest has open gets
 * a language server document fed from its Y.Text, whichever tab the host is looking at.
 */
import type * as Y from "yjs";
import { collab, sessionEndHooks } from "./collab.svelte";
import { publish, registerTopic } from "./rpc.svelte";
import { LSP_LIMITS, textHash, wireDiagnostic, wireFeatures, type LspDocEntry, type LspDocsPayload, type WireDiagnostic } from "./lspProtocol";
import { guestPathOk, sharedDocListeners, sharedDocs, type SharedDocView } from "./share.svelte";
import { app } from "../state.svelte";
import { joinPath } from "../api";
import { langFor, type LangInfo } from "../code/languages";
import { clientFor, fileUri, neverInstall, restartListeners, type LspClient } from "../code/lsp.svelte";

/** Delay between an edit and the server hearing about it. */
const CHANGE_MS = 200;
/** Reconnects after a server exit, like an editor (a crashing server is not restarted forever). */
const RECONNECT_MS = 1000;
const RECONNECTS = 3;
/** A session without a server (not installed yet) looks again this often, when it's being used. */
const RETRY_MS = 5000;

declare module "./rpc.svelte" {
  interface RpcTopics {
    "lsp.docs": LspDocsPayload;
  }
}

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
}

/** Revisions are unique across sessions, so a guest never takes a new entry for one it has shown. */
let nextRev = 1;

const sessions = new Map<string, LspSession>();

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
  for (const [abs, { doc, lang }] of want) if (!sessions.has(abs)) startSession(abs, doc, lang);
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
    onText: () => {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => syncSession(s), CHANGE_MS);
    },
    onDiagnostics: (uri) => {
      if (uri === s.uri) publishEntry(s);
    },
    entry: null,
    raw: [],
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
  const raw = (c.diagnostics.get(s.uri) ?? []).slice(0, LSP_LIMITS.diagnostics);
  const kept = raw.map((d) => ({ raw: d, wire: wireDiagnostic(d, root) })).filter((d): d is { raw: any; wire: WireDiagnostic } => !!d.wire);
  s.raw = kept.map((d) => d.raw);
  s.entry = { rev: nextRev++, hash: textHash(sent.text), len: sent.text.length, diagnostics: kept.map((d) => d.wire), features: wireFeatures(c.capabilities) };
  relOfEntry.set(s, s.doc.rel);
  publish("lsp.docs", { docs: { [s.doc.rel]: s.entry } });
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
    const c = await clientFor(s.lang, s.abs, root, neverInstall).catch(() => null);
    if (!c || s.stopped || s.client) return;
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

registerTopic({
  name: "lsp.docs",
  capability: null,
  snapshot: () => {
    const docs: Record<string, LspDocEntry> = {};
    for (const s of sessions.values()) if (s.entry) docs[s.doc.rel] = s.entry;
    return { full: true, docs };
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
});

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
