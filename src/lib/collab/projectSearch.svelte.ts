/**
 * Code Together: a guest's project search. Host side: file list, text search, preview and replace
 * over the RPC, with relative paths only. Guest side: the backend of the search UI (search/remote.ts).
 *
 * Replace goes file by file, so a guest always knows which files changed, also when the host takes
 * `edit` away halfway. Patterns run in the host's Rust `regex` (linear time), never in its JS engine.
 */
import { invoke } from "@tauri-apps/api/core";
import { collab } from "./collab.svelte";
import { blockedByCapability, guestCan } from "./guard";
import { guestMayWrite } from "./hooksGuard";
import { call, isObj, registerMethod, rpcErrorText, RpcFail, type RpcResult } from "./rpc.svelte";
import { REMOTE, guestHasDoc, guestPreviewDoc, guestReplaceInDoc, guestScope, hostDocHasClock, hostLiveText, hostLiveTexts, hostReplaceIn, openRemote, type GuestScope, type ReplacePlan } from "./share.svelte";
import { remoteSearch, type RemoteQuery, type RemoteSearch, type ReplaceReport, type ReplaceTarget } from "../search/remote";
import type { Hit } from "../search/search.svelte";
import { t } from "../i18n/index.svelte";

export const SEARCH_LIMITS = {
  query: 1000,
  mask: 1000,
  replacement: 64 * 1024,
  files: 500,
  maxResults: 5000,
  /** Live text per file and per search, in characters. */
  liveFile: 8 * 1024 * 1024,
  liveTotal: 16 * 1024 * 1024,
  /** Calls of one guest running at once. */
  reads: 4,
  replaces: 2,
};
const SEARCH_TIMEOUT_MS = 60_000;
const REPLACE_TIMEOUT_MS = 30_000;
const RATE_RETRIES = 8;
const APPLIED_TRIES = 20;
const APPLIED_WAIT_MS = 100;

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
type Hits = { hits: Hit[]; files: number; total: number; truncated: boolean; versions: Record<string, string> };
type Files = { files: string[]; truncated: boolean; versions?: Record<string, string> };
type Expect = { version: string } | { line: number; lineVersion: string };

declare module "./rpc.svelte" {
  interface RpcMethods {
    "search.list": { params: Record<string, never>; result: Files };
    "search.text": { params: QueryParams; result: Hits };
    "search.matching": { params: QueryParams; result: Files };
    "search.read": { params: { file: string }; result: string | null };
    "search.replace": { params: { query: QueryParams; replacement: string; file: string; expect: Expect }; result: { count: number } };
    "search.canWrite": { params: { file: string }; result: null };
    "search.applied": { params: { file: string; client: number; clock: number }; result: boolean };
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
/** Reads and replaces of a guest in progress. */
const inFlight = new Map<string, number>();

const KNOWN = new Set(["cancelled", "bad_pattern", "unavailable", "unreadable", "too_large", "changed", "hardlinked", "write_failed"]);
function failure(e: unknown) {
  if (e instanceof RpcFail) return e;
  const code = String(e);
  if (KNOWN.has(code)) return new RpcFail(code);
  console.error("guest search", e); // can hold absolute paths: stays on the host
  return new RpcFail("failed");
}

interface SearchRun {
  token: number;
  /** Throws once this search was cancelled or replaced. */
  check(): void;
}

/**
 * Runs one search, cancelled by the guest, when it loses access, or by its next search. Call it
 * before the first await of a handler: the order of the calls decides which search is the latest.
 */
async function exclusive<T>(slot: string, signal: AbortSignal, body: (run: SearchRun) => Promise<T>): Promise<T> {
  running.get(slot)?.abort();
  const own = new AbortController();
  running.set(slot, own);
  const token = nextToken++;
  const cancel = () => void invoke("guest_search_cancel", { token }).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  own.signal.addEventListener("abort", cancel, { once: true });
  const check = () => {
    if (signal.aborted || own.signal.aborted) throw new RpcFail("cancelled");
  };
  try {
    check();
    return await body({ token, check });
  } catch (e) {
    throw failure(e);
  } finally {
    signal.removeEventListener("abort", cancel);
    own.signal.removeEventListener("abort", cancel);
    if (running.get(slot) === own) running.delete(slot);
  }
}

/** Runs `body` unless this guest already has `max` of these calls running. */
async function bounded<T>(slot: string, max: number, body: () => Promise<T>): Promise<T> {
  const now = inFlight.get(slot) ?? 0;
  if (now >= max) throw new RpcFail("rate_limited");
  inFlight.set(slot, now + 1);
  try {
    return await body();
  } finally {
    const left = (inFlight.get(slot) ?? 1) - 1;
    if (left) inFlight.set(slot, left);
    else inFlight.delete(slot);
  }
}

const needScope = () => {
  const scope = guestScope();
  if (!scope) throw new RpcFail("unavailable");
  return scope;
};

const visible = (scope: GuestScope, rel: unknown): rel is string => typeof rel === "string" && !!rel && scope.rel(scope.abs(rel)) === rel;

const onlyVisible = (scope: GuestScope, versions: Record<string, string> = {}) => Object.fromEntries(Object.entries(versions).filter(([rel]) => visible(scope, rel)));

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
  const { texts, omitted } = hostLiveTexts(scope, SEARCH_LIMITS.liveFile, SEARCH_LIMITS.liveTotal);
  return { query: { ...q, files, overlay: texts, omit: omitted }, partial: omitted.length > 0 };
}

registerMethod({
  name: "search.list",
  capability: null,
  validate: () => ({}),
  handle: (_p, { peer, signal }) =>
    exclusive(`${peer}:list`, signal, async (run) => {
      const scope = needScope();
      const r = await invoke<Files>("guest_list_files", { token: run.token, root: scope.root });
      run.check();
      if (!scope.live()) throw new RpcFail("unavailable");
      return { files: r.files.filter((f) => visible(scope, f)), truncated: r.truncated };
    }),
});

registerMethod({
  name: "search.text",
  capability: null,
  validate: validQuery,
  handle: (q, { peer, signal }) =>
    exclusive(`${peer}:text`, signal, async (run) => {
      const scope = needScope();
      const backend = await backendQuery(scope, q);
      run.check();
      if (!backend) return { hits: [], files: 0, total: 0, truncated: false, versions: {} };
      const r = await invoke<Hits>("guest_search_text", { token: run.token, root: scope.root, query: backend.query });
      run.check();
      if (!scope.live()) throw new RpcFail("unavailable");
      return { ...r, hits: r.hits.filter((h) => visible(scope, h.file)), truncated: r.truncated || backend.partial, versions: onlyVisible(scope, r.versions) };
    }),
});

registerMethod({
  name: "search.matching",
  capability: null,
  validate: validQuery,
  handle: (q, { peer, signal }) =>
    exclusive(`${peer}:matching`, signal, async (run) => {
      const scope = needScope();
      const backend = await backendQuery(scope, q);
      run.check();
      if (!backend) return { files: [], truncated: false, versions: {} };
      const r = await invoke<Files>("guest_search_matching", { token: run.token, root: scope.root, query: backend.query });
      run.check();
      if (!scope.live()) throw new RpcFail("unavailable");
      return { files: r.files.filter((f) => visible(scope, f)), truncated: r.truncated || backend.partial, versions: onlyVisible(scope, r.versions) };
    }),
});

registerMethod({
  name: "search.read",
  capability: null,
  validate: (raw) => (isObj(raw) && typeof raw.file === "string" ? { file: raw.file } : null),
  // A named file may be hidden or ignored, like with `doc.open`; only the walk leaves those out.
  handle: ({ file }, { peer }) =>
    bounded(`${peer}:read`, SEARCH_LIMITS.reads, async () => {
      const scope = needScope();
      if (!visible(scope, file) || !(await scope.check(file))) throw new RpcFail("unavailable");
      const live = hostLiveText(scope, file);
      if (live !== undefined) {
        if (live.length > SEARCH_LIMITS.liveFile) throw new RpcFail("too_large");
        return live;
      }
      const text = await invoke<string | null>("guest_read_text", { root: scope.root, rel: file });
      if (!scope.live()) throw new RpcFail("unavailable");
      return text;
    }),
});

const validExpect = (raw: unknown): Expect | null => {
  if (!isObj(raw)) return null;
  if (typeof raw.version === "string") return { version: raw.version };
  return Number.isSafeInteger(raw.line) && (raw.line as number) >= 1 && typeof raw.lineVersion === "string" ? { line: raw.line as number, lineVersion: raw.lineVersion } : null;
};

/** The backend's Replace request; it refuses text that isn't what the guest saw. */
const replaceSpec = (q: QueryParams, replacement: string, expect: Expect) => ({
  query: q.query,
  caseSensitive: q.caseSensitive,
  wholeWord: q.wholeWord,
  regex: q.regex,
  replacement,
  line: "line" in expect ? expect.line : null,
  expectVersion: "version" in expect ? expect.version : null,
  expectLine: "line" in expect ? expect.lineVersion : null,
});

registerMethod({
  name: "search.replace",
  capability: "edit",
  validate: (raw) => {
    if (!isObj(raw) || typeof raw.file !== "string" || typeof raw.replacement !== "string" || raw.replacement.length > SEARCH_LIMITS.replacement) return null;
    const query = validQuery(raw.query);
    const expect = validExpect(raw.expect);
    return query && expect && { query, replacement: raw.replacement, file: raw.file, expect };
  },
  handle: ({ query: q, replacement, file, expect }, { peer, signal }) =>
    bounded(`${peer}:replace`, SEARCH_LIMITS.replaces, async () => {
      const scope = needScope();
      if (!visible(scope, file)) throw new RpcFail("unavailable");
      const replace = replaceSpec(q, replacement, expect);
      try {
        return { count: await hostReplaceIn(scope, file, (text) => invoke<ReplacePlan>("guest_replace_plan", { text, replace }), signal, peer) };
      } catch (e) {
        throw failure(e);
      }
    }),
});

registerMethod({
  name: "search.canWrite",
  capability: "edit",
  validate: (raw) => (isObj(raw) && typeof raw.file === "string" ? { file: raw.file } : null),
  handle: async ({ file }, { peer }) => {
    const scope = needScope();
    if (!visible(scope, file) || !(await scope.check(file))) throw new RpcFail("unavailable");
    if (!(await guestMayWrite(peer, scope.root, [file]))) throw new RpcFail("hooks");
    try {
      await invoke("guest_write_check", { root: scope.root, rel: file });
    } catch (e) {
      throw failure(e);
    }
    return null;
  },
});

registerMethod({
  name: "search.applied",
  capability: "edit",
  validate: (raw) =>
    isObj(raw) && typeof raw.file === "string" && Number.isSafeInteger(raw.client) && Number.isSafeInteger(raw.clock) ? { file: raw.file, client: raw.client as number, clock: raw.clock as number } : null,
  handle: ({ file, client, clock }) => hostDocHasClock(file, client, clock),
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
    case "changed":
      return t("git.search.fileChanged");
    case "hardlinked":
      return t("git.search.fileHardlinked");
    case "unconfirmed":
      return t("git.search.fileUnconfirmed");
    case "hooks":
      return t("git.guestErr.hooks");
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

/** Calls again while the RPC limit says so: that's a reason to wait, not a failed file. */
async function patiently<T>(attempt: () => Promise<RpcResult<T>>) {
  let r = await attempt();
  for (let i = 0; i < RATE_RETRIES && !r.ok && r.error.code === "rate_limited"; i++) {
    await pause(500 * (i + 1));
    r = await attempt();
  }
  return r;
}

/** Whether the host has the update of a Replace made in this guest's copy. */
async function reachedHost(file: string, client: number, clock: number) {
  for (let i = 0; i < APPLIED_TRIES; i++) {
    const r = await patiently(() => call("search.applied", { file, client, clock }, { timeoutMs: REPLACE_TIMEOUT_MS }));
    if (!r.ok) return r.error.code;
    if (r.value) return null;
    await pause(APPLIED_WAIT_MS);
  }
  return "unconfirmed";
}

type Step = { ok: true; count: number } | { ok: false; code: string };
const refused = (code: string): Step => ({ ok: false, code });

/**
 * One file. In a doc this guest has open the change is made here, so Ctrl+Z takes it back; other
 * files change on the host (no undo, like the host's own Replace in a file without a tab).
 */
async function replaceOne(q: QueryParams, replacement: string, target: ReplaceTarget): Promise<Step> {
  const file = relOf(target.file);
  const expect: Expect | null = target.line !== undefined ? (target.lineVersion ? { line: target.line, lineVersion: target.lineVersion } : null) : target.version ? { version: target.version } : null;
  if (!expect) return refused("changed");
  if (guestHasDoc(file)) {
    const gate = await patiently(() => call("search.canWrite", { file }, { timeoutMs: REPLACE_TIMEOUT_MS }));
    if (!gate.ok) return refused(gate.error.code);
    const replace = replaceSpec(q, replacement, expect);
    try {
      const done = await guestReplaceInDoc(file, (text) => invoke<ReplacePlan>("guest_replace_plan", { text, replace }));
      if (done) {
        if (!done.count) return { ok: true, count: 0 };
        const missing = await reachedHost(file, done.client, done.clock);
        return missing ? refused(missing) : { ok: true, count: done.count };
      }
    } catch (e) {
      return refused(failure(e).code);
    }
  }
  const r = await patiently(() => call("search.replace", { query: q, replacement, file, expect }, { timeoutMs: REPLACE_TIMEOUT_MS }));
  return r.ok ? { ok: true, count: r.value.count } : refused(r.error.code);
}

/** Guest: replaces file by file and reports exactly what happened to each. */
export async function replaceInFiles(q: RemoteQuery, replacement: string, targets: ReplaceTarget[]): Promise<ReplaceReport> {
  const report: ReplaceReport = { replaced: 0, changed: 0, errors: [], stopped: null, done: 0 };
  const query = toParams(q);
  for (const target of targets) {
    const r = await replaceOne(query, replacement, target);
    if (r.ok) {
      report.done++;
      report.replaced += r.count;
      if (r.count) report.changed++;
    } else if (ENDS_RUN.has(r.code)) {
      report.stopped = searchErrorText(r.code);
      break;
    } else {
      report.done++;
      report.errors.push({ file: relOf(target.file), message: searchErrorText(r.code) });
    }
  }
  return report;
}

const remoteKeys = (versions: Record<string, string> = {}) => Object.fromEntries(Object.entries(versions).map(([rel, v]) => [REMOTE + rel, v]));

const backend: RemoteSearch = {
  active: () => collab.role === "guest" && collab.status === "connected",
  mayReplace: () => !blockedByCapability("edit"),
  canEdit: () => guestCan("edit"),
  listFiles: async (signal) => {
    const r = await call("search.list", {}, { timeoutMs: SEARCH_TIMEOUT_MS, signal });
    return r.ok ? { ok: true, value: r.value } : { ok: false, message: searchErrorText(r.error.code) };
  },
  text: async (q, signal) => {
    const r = await call("search.text", toParams(q), { timeoutMs: SEARCH_TIMEOUT_MS, signal });
    if (!r.ok) return { ok: false, message: searchErrorText(r.error.code) };
    return { ok: true, value: { ...r.value, hits: r.value.hits.map((h) => ({ ...h, file: REMOTE + h.file })), versions: remoteKeys(r.value.versions) } };
  },
  matching: async (q) => {
    const r = await call("search.matching", toParams(q), { timeoutMs: SEARCH_TIMEOUT_MS });
    if (!r.ok) return { ok: false, message: searchErrorText(r.error.code) };
    return { ok: true, value: { files: r.value.files.map((f) => REMOTE + f), truncated: r.value.truncated, versions: remoteKeys(r.value.versions) } };
  },
  read: async (file) => {
    const rel = relOf(file);
    if (!isShared(rel)) return null;
    const r = await call("search.read", { file: rel }, { timeoutMs: SEARCH_TIMEOUT_MS });
    return r.ok ? r.value : null;
  },
  replace: replaceInFiles,
  previewDoc: (file, onDoc) => guestPreviewDoc(relOf(file), onDoc),
  reveal: (file, line, range) => openRemote(relOf(file), line, range),
};

remoteSearch.backend = backend;

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
