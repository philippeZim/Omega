/**
 * Code Together: a guest's project search. Host side: file list, text search, preview and replace
 * over the RPC, with relative paths only. Guest side: the backend of the search UI (search/remote.ts).
 *
 * Replace goes file by file, so a guest always knows which files changed, also when the host takes
 * `edit` away halfway. Patterns run in the host's Rust `regex` (linear time), never in its JS engine.
 */
import { invoke } from "@tauri-apps/api/core";
import { collab } from "./collab.svelte";
import { blockedByCapability } from "./guard";
import { call, isObj, registerMethod, rpcErrorText, RpcFail } from "./rpc.svelte";
import { REMOTE, guestScope, hostLiveTexts, hostReplaceIn, openRemote, type GuestScope, type ReplacePlan } from "./share.svelte";
import { remoteSearch, type RemoteQuery, type RemoteSearch, type ReplaceReport } from "../search/remote";
import type { Hit } from "../search/search.svelte";
import { t } from "../i18n/index.svelte";

export const SEARCH_LIMITS = { query: 1000, mask: 1000, replacement: 64 * 1024, files: 500, maxResults: 5000 };
const SEARCH_TIMEOUT_MS = 60_000;
const REPLACE_TIMEOUT_MS = 30_000;
const RATE_RETRIES = 8;

interface QueryParams {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  mask: string;
  folder: string;
  /** Scope "open files". Empty means none, never the whole project. */
  files?: string[];
  maxResults: number;
}
type Hits = { hits: Hit[]; files: number; total: number; truncated: boolean };
type Files = { files: string[]; truncated: boolean };

declare module "./rpc.svelte" {
  interface RpcMethods {
    "search.list": { params: Record<string, never>; result: Files };
    "search.text": { params: QueryParams; result: Hits };
    "search.matching": { params: QueryParams; result: Files };
    "search.read": { params: { file: string }; result: string | null };
    "search.replace": { params: { query: QueryParams; replacement: string; file: string; line?: number }; result: { count: number } };
  }
}

// ------------------------------------------------------------------ host

const validQuery = (raw: unknown): QueryParams | null => {
  if (!isObj(raw)) return null;
  const { query, caseSensitive, wholeWord, regex, mask, folder, files, maxResults } = raw;
  if (typeof query !== "string" || !query || query.length > SEARCH_LIMITS.query) return null;
  if (typeof caseSensitive !== "boolean" || typeof wholeWord !== "boolean" || typeof regex !== "boolean") return null;
  if (typeof mask !== "string" || mask.length > SEARCH_LIMITS.mask || typeof folder !== "string") return null;
  if (!Number.isSafeInteger(maxResults) || (maxResults as number) < 1) return null;
  if (files !== undefined && !(Array.isArray(files) && files.length <= SEARCH_LIMITS.files && files.every((f) => typeof f === "string"))) return null;
  return { query, caseSensitive, wholeWord, regex, mask, folder, maxResults: Math.min(maxResults as number, SEARCH_LIMITS.maxResults), ...(files ? { files: files as string[] } : {}) };
};

let nextToken = Date.now() * 1000;
/** The running search per guest and kind: a new one replaces it, so a guest can't pile them up. */
const running = new Map<string, AbortController>();

const KNOWN = new Set(["cancelled", "bad_pattern", "unavailable", "too_large"]);
function failure(e: unknown) {
  if (e instanceof RpcFail) return e;
  const code = String(e);
  if (KNOWN.has(code)) return new RpcFail(code);
  console.error("guest search", e); // can hold absolute paths: stays on the host
  return new RpcFail("failed");
}

/** Runs one backend search, cancelled by the guest, by its next search, or when it loses access. */
async function exclusive<T>(slot: string, signal: AbortSignal, run: (token: number) => Promise<T>): Promise<T> {
  running.get(slot)?.abort();
  const own = new AbortController();
  running.set(slot, own);
  const token = nextToken++;
  const cancel = () => void invoke("guest_search_cancel", { token }).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  own.signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw new RpcFail("cancelled");
    return await run(token);
  } catch (e) {
    throw failure(e);
  } finally {
    signal.removeEventListener("abort", cancel);
    own.signal.removeEventListener("abort", cancel);
    if (running.get(slot) === own) running.delete(slot);
  }
}

const needScope = () => {
  const scope = guestScope();
  if (!scope) throw new RpcFail("unavailable");
  return scope;
};

const visible = (scope: GuestScope, rel: unknown): rel is string => typeof rel === "string" && !!rel && scope.rel(scope.abs(rel)) === rel;

/** The query for the backend; null when an "open files" scope has nothing the guest may read. */
async function backendQuery(scope: GuestScope, q: QueryParams) {
  if (q.folder && !(await scope.check(q.folder))) throw new RpcFail("unavailable");
  let files: string[] = [];
  if (q.files) {
    const checked = await Promise.all(q.files.map(async (f) => (visible(scope, f) && (await scope.check(f)) ? f : null)));
    files = checked.filter((f): f is string => !!f);
    if (!files.length) return null;
  }
  if (!scope.live()) throw new RpcFail("unavailable");
  return { ...q, files, overlay: hostLiveTexts(scope) };
}

registerMethod({
  name: "search.list",
  capability: null,
  validate: () => ({}),
  handle: async (_p, { peer, signal }) => {
    const scope = needScope();
    const r = await exclusive(`${peer}:list`, signal, (token) => invoke<Files>("guest_list_files", { token, root: scope.root }));
    if (!scope.live()) throw new RpcFail("unavailable");
    return { files: r.files.filter((f) => visible(scope, f)), truncated: r.truncated };
  },
});

registerMethod({
  name: "search.text",
  capability: null,
  validate: validQuery,
  handle: async (q, { peer, signal }) => {
    const scope = needScope();
    const query = await backendQuery(scope, q);
    if (!query) return { hits: [], files: 0, total: 0, truncated: false };
    const r = await exclusive(`${peer}:text`, signal, (token) => invoke<Hits>("guest_search_text", { token, root: scope.root, query }));
    if (!scope.live()) throw new RpcFail("unavailable");
    return { ...r, hits: r.hits.filter((h) => visible(scope, h.file)) };
  },
});

registerMethod({
  name: "search.matching",
  capability: null,
  validate: validQuery,
  handle: async (q, { peer, signal }) => {
    const scope = needScope();
    const query = await backendQuery(scope, q);
    if (!query) return { files: [], truncated: false };
    const r = await exclusive(`${peer}:matching`, signal, (token) => invoke<Files>("guest_search_matching", { token, root: scope.root, query }));
    if (!scope.live()) throw new RpcFail("unavailable");
    return { files: r.files.filter((f) => visible(scope, f)), truncated: r.truncated };
  },
});

registerMethod({
  name: "search.read",
  capability: null,
  validate: (raw) => (isObj(raw) && typeof raw.file === "string" ? { file: raw.file } : null),
  handle: async ({ file }) => {
    const scope = needScope();
    if (!visible(scope, file) || !(await scope.check(file))) throw new RpcFail("unavailable");
    const live = hostLiveTexts(scope)[file];
    if (live !== undefined) return live;
    const text = await invoke<string | null>("guest_read_text", { root: scope.root, rel: file });
    if (!scope.live()) throw new RpcFail("unavailable");
    return text;
  },
});

registerMethod({
  name: "search.replace",
  capability: "edit",
  validate: (raw) => {
    if (!isObj(raw) || typeof raw.file !== "string" || typeof raw.replacement !== "string" || raw.replacement.length > SEARCH_LIMITS.replacement) return null;
    if (raw.line !== undefined && !(Number.isSafeInteger(raw.line) && (raw.line as number) >= 1)) return null;
    const query = validQuery(raw.query);
    return query && { query, replacement: raw.replacement, file: raw.file, ...(raw.line === undefined ? {} : { line: raw.line as number }) };
  },
  handle: async ({ query: q, replacement, file, line }, { signal }) => {
    const scope = needScope();
    if (!visible(scope, file)) throw new RpcFail("unavailable");
    const replace = { query: q.query, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regex: q.regex, replacement, line: line ?? null };
    try {
      const count = await hostReplaceIn(scope, file, (text) => invoke<ReplacePlan>("guest_replace_plan", { text, replace }), signal);
      return { count };
    } catch (e) {
      throw failure(e);
    }
  },
});

// ------------------------------------------------------------------ guest

/** Text for a search error code. */
export function searchErrorText(code: string) {
  switch (code) {
    case "bad_pattern":
      return t("git.search.badPattern");
    case "unavailable":
      return t("ai.collab.fileUnavailable");
    case "busy":
      return t("git.search.fileBusy");
    case "unreadable":
      return t("git.search.fileUnreadable");
    default:
      return rpcErrorText(code);
  }
}

const relOf = (file: string) => (file.startsWith(REMOTE) ? file.slice(REMOTE.length) : file);
const toParams = (q: RemoteQuery): QueryParams => ({ ...q, ...(q.files ? { files: q.files.map(relOf) } : {}) });
const isShared = (rel: string) => !rel.startsWith("tab:");

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Codes after which the next file wouldn't fare better. */
const ENDS_RUN = new Set(["forbidden", "session_ended", "cancelled"]);

/** Guest: replaces file by file and reports exactly what happened to each. */
export async function replaceInFiles(q: RemoteQuery, replacement: string, files: string[], line?: number): Promise<ReplaceReport> {
  const report: ReplaceReport = { replaced: 0, changed: 0, errors: [], stopped: null, done: 0 };
  const query = toParams(q);
  for (const file of files) {
    const rel = relOf(file);
    let r = await call("search.replace", { query, replacement, file: rel, ...(line === undefined ? {} : { line }) }, { timeoutMs: REPLACE_TIMEOUT_MS });
    // Large runs can hit the RPC rate limit: that's a reason to wait, not a failed file.
    for (let i = 0; i < RATE_RETRIES && !r.ok && r.error.code === "rate_limited"; i++) {
      await pause(500 * (i + 1));
      r = await call("search.replace", { query, replacement, file: rel, ...(line === undefined ? {} : { line }) }, { timeoutMs: REPLACE_TIMEOUT_MS });
    }
    if (r.ok) {
      report.done++;
      report.replaced += r.value.count;
      if (r.value.count) report.changed++;
    } else if (ENDS_RUN.has(r.error.code)) {
      report.stopped = searchErrorText(r.error.code);
      break;
    } else {
      report.done++;
      report.errors.push({ file: rel, message: searchErrorText(r.error.code) });
    }
  }
  return report;
}

const backend: RemoteSearch = {
  active: () => collab.role === "guest" && collab.status === "connected",
  mayReplace: () => !blockedByCapability("edit"),
  listFiles: async (signal) => {
    const r = await call("search.list", {}, { timeoutMs: SEARCH_TIMEOUT_MS, signal });
    return r.ok ? { ok: true, value: r.value } : { ok: false, message: searchErrorText(r.error.code) };
  },
  text: async (q, signal) => {
    const r = await call("search.text", toParams(q), { timeoutMs: SEARCH_TIMEOUT_MS, signal });
    if (!r.ok) return { ok: false, message: searchErrorText(r.error.code) };
    return { ok: true, value: { ...r.value, hits: r.value.hits.map((h) => ({ ...h, file: REMOTE + h.file })) } };
  },
  matching: async (q) => {
    const r = await call("search.matching", toParams(q), { timeoutMs: SEARCH_TIMEOUT_MS });
    if (!r.ok) return { ok: false, message: searchErrorText(r.error.code) };
    return { ok: true, value: { files: r.value.files.map((f) => REMOTE + f), truncated: r.value.truncated } };
  },
  read: async (file) => {
    const rel = relOf(file);
    if (!isShared(rel)) return null;
    const r = await call("search.read", { file: rel }, { timeoutMs: SEARCH_TIMEOUT_MS });
    return r.ok ? r.value : null;
  },
  replace: replaceInFiles,
  reveal: (file, line, range) => openRemote(relOf(file), line, range),
};

remoteSearch.backend = backend;

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
