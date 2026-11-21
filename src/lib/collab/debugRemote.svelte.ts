/**
 * Code Together debugging. The debug session always runs on the host; guests with the `debug`
 * capability control that same session through typed methods and see a mirror of its state in the
 * normal debugger UI (the `dbg` store).
 *
 *  - Breakpoints of project files belong to the host, keyed by relative path. On a guest they sit
 *    in `dbg.breakpoints` under `collab:<rel>`, next to the guest's own, which stay untouched.
 *  - Nothing here sends a DAP request by name, and guests supply no command, launch config, env,
 *    cwd or absolute path. Frame and variable references are checked against the host's current
 *    state, so a stale one fails with a code instead of reaching the adapter.
 *  - Absolute host paths are taken out of names and messages. Variable values and evaluation
 *    results are the program's data and stay exactly as they are.
 */
import { untrack } from "svelte";
import { collab, onCollabMessage, sessionEndHooks } from "./collab.svelte";
import { blockedByCapability } from "./guard";
import { call, hasCapability, isObj, publish, registerMethod, registerTopic, rpcErrorText, RpcFail, subscribe, type RpcResult } from "./rpc.svelte";
import { flushBackgroundDocs, guestScope, isRemote, openRemote, REMOTE, type GuestScope } from "./share.svelte";
import { cleanBreakpoints, cleanRel, clip, DEBUG_LIMITS, isId, RefTable, scrubPaths, shareableBreakpoints, StreamScrubber, termOut, type SharedBreakpoint } from "./debugMirror";
import { applyGuestBreakpoints, dbg, dbgHooks, dbgRemote, endGuestBreakpoints, revertGuestBreakpoints, SHARED_BP, type DebugRemote, type DebugStatus, type Frame, type VarNode } from "../debug/store.svelte";
import { hostDebug, stopLocal } from "../debug/debugger.svelte";
import { app, activeTab, setMode } from "../state.svelte";
import { showView } from "../layout.svelte";
import { fsApi } from "../api";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

type StepOp = "continue" | "next" | "stepIn" | "stepOut";
type ControlOp = StepOp | "pause" | "stop" | "restart";
type EvalContext = "watch" | "repl" | "hover";

interface MirrorFrame {
  id: number;
  name: string;
  /** Relative path, or null for a frame outside the project: guests only get its name. */
  rel: string | null;
  line: number;
  column: number;
  subtle: boolean;
}
interface MirrorScope {
  name: string;
  ref: number;
  open: boolean;
}
export interface MirrorState {
  status: DebugStatus;
  label: string;
  stopReason: string;
  actor: string;
  gen: number;
  threads: { id: number; name: string }[];
  threadId: number | null;
  frames: MirrorFrame[];
  frameId: number | null;
  scopes: MirrorScope[];
  scopesVersion: number;
  exec: { rel: string; line: number } | null;
}
interface MirrorVar {
  name: string;
  value: string;
  type?: string;
  ref: number;
  evaluateName?: string;
}
interface ConsoleBatch {
  reset: boolean;
  lines: { text: string; kind: (typeof dbg.console)[number]["kind"] }[];
  skipped: number;
}
type EvalResult = { value: string; ref: number } | { error: string };
type BreakpointFiles = { files: Record<string, SharedBreakpoint[]> };

declare module "./rpc.svelte" {
  interface RpcMethods {
    "debug.start": { params: { path: string }; result: null };
    "debug.control": { params: { op: ControlOp }; result: null };
    "debug.thread": { params: { id: number }; result: null };
    "debug.frame": { params: { id: number }; result: null };
    "debug.variables": { params: { ref: number }; result: { vars: MirrorVar[]; truncated: boolean } };
    "debug.evaluate": { params: { expression: string; context: EvalContext; frameId: number }; result: EvalResult };
    "debug.watches": { params: { frameId: number; expressions: string[] }; result: { results: EvalResult[] } };
    "debug.setVariable": { params: { ref: number; name: string; value: string }; result: { value: string } };
    "debug.breakpoints": { params: { path: string; lines: { line: number; condition?: string }[] }; result: null };
  }
  interface RpcTopics {
    "debug.state": MirrorState;
    /** Every guest: where the breakpoints are, without their conditions. */
    "debug.bps": BreakpointFiles;
    /** Guests with `debug`: the same list with conditions. */
    "debug.bpsFull": BreakpointFiles;
    "debug.console": ConsoleBatch;
  }
}

const CONTROL_OPS: readonly unknown[] = ["continue", "next", "stepIn", "stepOut", "pause", "stop", "restart"] satisfies ControlOp[];
const EVAL_CONTEXTS: readonly unknown[] = ["watch", "repl", "hover"] satisfies EvalContext[];
const isLive = () => dbg.status === "running" || dbg.status === "stopped" || dbg.status === "starting";
/** A start is on its way or the session is being closed: a guest's Start or Restart has to wait. */
const startBlocked = () => hostDebug.starting() || hostDebug.closing() || dbg.status === "starting";

// ------------------------------------------------------------------ host

const guestName = (peer: string) => collab.participants.find((p) => p.peer === peer)?.name ?? t("ai.collab.guest");

let home: string | null = null;
const scrub = (text: string) => scrubPaths(text, app.root, home);
/** For names and messages: no host path, bounded. */
const shown = (text: unknown, max: number = DEBUG_LIMITS.nameChars) => clip(scrub(String(text ?? "")), max);

const refs = new RefTable();
/** Absolute path -> relative path if guests may see it; emptied when the folder or run changes. */
const relCache = new Map<string, string | null>();
let relCacheKey = "";
/** The guest whose start is still on its way: it ends if that guest loses the right. */
let startingPeer: string | null = null;
let guestStarted = false;

async function sharedRel(abs: string, scope: GuestScope | null): Promise<string | null> {
  if (!scope) return null;
  if (relCache.has(abs)) return relCache.get(abs)!;
  const rel = scope.rel(abs);
  const ok = !!rel && (await scope.check(rel));
  relCache.set(abs, ok ? rel : null);
  return ok ? rel : null;
}

function freshRelCache() {
  const key = `${app.root}\n${hostDebug.gen()}`;
  if (key === relCacheKey) return;
  relCacheKey = key;
  relCache.clear();
}

let scopesSeen: unknown = null;
let scopesVersion = 0;
let lastState: MirrorState | null = null;
let lastBps: BreakpointFiles | null = null;
let lastBpsFull: BreakpointFiles | null = null;
let stateSeq = 0;
let bpSeq = 0;

export async function buildState(): Promise<MirrorState> {
  freshRelCache();
  const scope = guestScope();
  if (dbg.scopes !== scopesSeen) {
    scopesSeen = dbg.scopes;
    scopesVersion++;
  }
  const gen = hostDebug.gen();
  const scopes = dbg.scopes.slice(0, DEBUG_LIMITS.scopes).map((s) => ({ name: shown(s.name), ref: s.ref, open: s.expanded }));
  for (const s of scopes) refs.add(gen, s.ref);
  const source = dbg.frames.slice(0, DEBUG_LIMITS.frames).map((f) => ({ id: f.id, name: f.name, path: f.path, line: f.line, column: f.column, subtle: f.subtle }));
  const frames: MirrorFrame[] = [];
  for (const f of source) {
    const rel = f.path ? await sharedRel(f.path, scope) : null;
    frames.push({ id: f.id, name: shown(f.name), rel, line: f.line, column: f.column, subtle: f.subtle || !rel });
  }
  const exec = dbg.exec;
  const execRel = exec ? await sharedRel(exec.path, scope) : null;
  return {
    status: dbg.status,
    label: shown(dbg.label),
    stopReason: shown(dbg.stopReason),
    actor: dbg.actor,
    gen,
    threads: dbg.threads.slice(0, DEBUG_LIMITS.threads).map((x) => ({ id: x.id, name: shown(x.name) })),
    threadId: dbg.threadId,
    frames,
    frameId: dbg.frameId,
    scopes,
    scopesVersion,
    exec: exec && execRel ? { rel: execRel, line: exec.line } : null,
  };
}

async function publishState() {
  if (collab.role !== "host") return;
  const seq = ++stateSeq;
  const state = await buildState();
  if (seq !== stateSeq || collab.role !== "host") return; // a newer one is on its way
  // Too large: guests keep the last value that did go out, also as the snapshot for late joiners.
  if (publish("debug.state", state)) lastState = state;
}

export async function buildBreakpoints(): Promise<BreakpointFiles> {
  freshRelCache();
  const scope = guestScope();
  const files: Record<string, SharedBreakpoint[]> = {};
  let count = 0;
  let chars = 0;
  for (const [abs, list] of Object.entries(dbg.breakpoints)) {
    if (!list.length || count >= DEBUG_LIMITS.bpFiles || !shareableBreakpoints(list)) continue;
    const entries = list.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}), ...(b.verified === undefined ? {} : { verified: b.verified }) }));
    const rel = await sharedRel(abs, scope);
    if (!rel) continue;
    const size = JSON.stringify(entries).length + JSON.stringify(rel).length + 1;
    if (chars + size > DEBUG_LIMITS.bpChars) continue;
    chars += size;
    files[rel] = entries;
    count++;
  }
  return { files };
}

const withoutConditions = ({ files }: BreakpointFiles): BreakpointFiles => ({
  files: Object.fromEntries(Object.entries(files).map(([rel, list]) => [rel, list.map(({ line, verified }) => ({ line, ...(verified === undefined ? {} : { verified }) }))])),
});

async function publishBreakpoints() {
  if (collab.role !== "host") return;
  const seq = ++bpSeq;
  const full = await buildBreakpoints();
  if (seq !== bpSeq || collab.role !== "host") return;
  if (JSON.stringify(full) === JSON.stringify(lastBpsFull)) return;
  const open = withoutConditions(full);
  if (publish("debug.bpsFull", full)) lastBpsFull = full;
  if (publish("debug.bps", open)) lastBps = open;
}

/** Host: publishes the current state without waiting for the next batch. */
export const publishDebugNow = () => Promise.all([publishState(), publishBreakpoints()]);

let publishTimer = 0;
function schedulePublish() {
  if (publishTimer) return;
  publishTimer = window.setTimeout(() => {
    publishTimer = 0;
    void publishState();
    void publishBreakpoints();
  }, 40);
}

// Console: batched, so a chatty program can't turn into one message per line.
let outbox: ConsoleBatch["lines"] = [];
let outboxReset = false;
let outboxSkipped = 0;
let consoleTimer = 0;

const mirrorLine = (l: { text: string; kind: string }) => {
  // What the program evaluates to is data; only messages and output are scrubbed.
  const data = l.kind === "result" || l.kind === "input";
  return { text: clip(data ? l.text : scrub(l.text), DEBUG_LIMITS.lineChars), kind: l.kind as ConsoleBatch["lines"][number]["kind"] };
};

function flushConsole() {
  consoleTimer = 0;
  if (collab.role !== "host") return;
  const batch: ConsoleBatch = { reset: outboxReset, lines: outbox, skipped: outboxSkipped };
  outbox = [];
  outboxReset = false;
  outboxSkipped = 0;
  publish("debug.console", batch);
}

dbgHooks.logged = (line) => {
  if (collab.role !== "host") return;
  if (!line) {
    outbox = [];
    outboxReset = true;
    outboxSkipped = 0;
  } else {
    outbox.push(mirrorLine(line));
    if (outbox.length > DEBUG_LIMITS.consoleBatch) {
      outboxSkipped += outbox.length - DEBUG_LIMITS.consoleBatch;
      outbox = outbox.slice(-DEBUG_LIMITS.consoleBatch);
    }
  }
  if (!consoleTimer) consoleTimer = window.setTimeout(flushConsole, 80);
};

// Everything in the host's Run and Build terminals reaches guests: command lines, tracebacks and the
// debuggee's launcher name absolute paths. The host's own terminal never passes through here.
/** How long text that may still become a path waits for its rest. */
const TERM_HOLD_MS = 1000;
/** Output kept while the home folder is still being looked up. */
const TERM_WAIT_CHARS = 256 * 1024;
let termScrubber: StreamScrubber | null = null;
let termScrubRoot: string | null = null;
let termTimer = 0;
let termWaiting: string[] = [];
let termWaitingChars = 0;
let homeLoading = false;

const toB64 = (text: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
};

function endTermScrub(later: (b64: string) => void) {
  clearTimeout(termTimer);
  const rest = termScrubber?.flush();
  termScrubber = null;
  if (rest) later(toB64(rest));
}

function scrubChunk(b64: string, later: (b64: string) => void): string {
  if (termScrubber && termScrubRoot !== app.root) endTermScrub(later);
  termScrubRoot = app.root;
  termScrubber ??= new StreamScrubber(app.root, home);
  const text = termScrubber.push(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  // A path that never completes must still show up.
  clearTimeout(termTimer);
  termTimer = window.setTimeout(() => {
    const rest = termScrubber?.drain();
    if (rest) later(toB64(rest));
  }, TERM_HOLD_MS);
  return text ? toB64(text) : "";
}

/** Output from before the home folder is known goes out once it is; without it, none does. */
function loadHomeForTerminal(later: (b64: string) => void) {
  if (homeLoading) return;
  homeLoading = true;
  void fsApi
    .homeDir()
    .then((h) => (home = h))
    .catch((e) => console.error("collab home folder", e))
    .finally(() => {
      homeLoading = false;
      const waiting = termWaiting;
      termWaiting = [];
      termWaitingChars = 0;
      if (home === null || collab.role !== "host") return;
      for (const chunk of waiting) {
        const out = scrubChunk(chunk, later);
        if (out) later(out);
      }
    });
}

export function filterTerminal(b64: string, later: (b64: string) => void): string {
  if (collab.role !== "host") return "";
  if (home === null) {
    if (termWaitingChars + b64.length <= TERM_WAIT_CHARS) {
      termWaiting.push(b64);
      termWaitingChars += b64.length;
    }
    loadHomeForTerminal(later);
    return "";
  }
  return scrubChunk(b64, later);
}
termOut.filter = filterTerminal;

dbgHooks.beforeStart = async () => {
  if (collab.role === "host") await flushBackgroundDocs().catch((e) => console.error("debug flush", e));
};

$effect.root(() => {
  $effect(() => {
    if (collab.role !== "host") return;
    if (home === null) void fsApi.homeDir().then((h) => (home = h)).catch(() => {});
    void [dbg.status, dbg.label, dbg.stopReason, dbg.actor, dbg.threads, dbg.threadId, dbg.frames, dbg.frameId, dbg.exec, dbg.version, app.root];
    void dbg.scopes.map((s) => s.expanded);
    untrack(schedulePublish);
  });
  // Tabs keep their own editor state: re-read breakpoints changed while another tab was showing.
  $effect(() => {
    void app.activeId;
    if (!collab.role) return;
    untrack(() => requestAnimationFrame(() => hostDebug.refreshEditor()));
  });
  $effect(() => {
    if (collab.role !== "host") return;
    const guests = collab.participants.filter((p) => p.role === "guest").length;
    if (guests || !guestStarted) return;
    untrack(() => {
      guestStarted = false;
      hostDebug.release();
      if (isLive()) ui.toast(t("ai.collab.dbg.stillRunning"));
      else hostDebug.forgetGuestPlan();
    });
  });
  // Rights changed or someone left: what they did with them ends here.
  $effect(() => {
    if (collab.role !== "host") return;
    void collab.participants.map((p) => [p.peer, p.removing, p.caps?.includes("debug")]);
    untrack(syncGuestRights);
  });
  // A restart must not launch a file of the folder the host has left.
  let seenRoot: string | null = null;
  $effect(() => {
    const now = app.root;
    if (collab.role === "host" && seenRoot !== null && now !== seenRoot) untrack(() => hostDebug.forgetGuestPlan());
    seenRoot = now;
  });
});

/** Host: guests who can no longer debug lose their breakpoints and their start still on its way. */
export function syncGuestRights() {
  if (collab.role !== "host") return;
  const holds = (peer: string) => hasCapability(peer, "debug");
  revertGuestBreakpoints(holds);
  if (startingPeer && !holds(startingPeer)) {
    const wasStarting = hostDebug.starting();
    startingPeer = null;
    if (wasStarting) void hostDebug.cancelStart();
  }
}

dbgHooks.hosting = () => collab.role === "host";

registerTopic({ name: "debug.state", capability: "debug", snapshot: () => lastState });
registerTopic({ name: "debug.bps", capability: null, snapshot: () => lastBps });
registerTopic({ name: "debug.bpsFull", capability: "debug", snapshot: () => lastBpsFull });
registerTopic({
  name: "debug.console",
  capability: "debug",
  snapshot: () => ({ reset: true, lines: dbg.console.slice(-DEBUG_LIMITS.consoleSnapshot).map(mirrorLine), skipped: 0 }),
});

/** Refuses when the call was cancelled or the guest lost the right while it waited. */
function stillAllowed(peer: string, signal: AbortSignal, cap: "debug" | null = "debug") {
  if (signal.aborted) throw new RpcFail("cancelled");
  if (cap && !hasCapability(peer, cap)) throw new RpcFail("forbidden");
}

function trackStart(peer: string, started: Promise<unknown>) {
  guestStarted = true;
  startingPeer = peer;
  void started
    .catch((e) => console.error("guest debug", e))
    .finally(() => {
      if (startingPeer === peer) startingPeer = null;
    });
}

registerMethod({
  name: "debug.start",
  capability: "debug",
  validate: (raw) => {
    const path = isObj(raw) ? cleanRel(raw.path) : null;
    return path ? { path } : null;
  },
  handle: async ({ path }, { peer, signal }) => {
    const scope = guestScope();
    if (!scope || !(await scope.check(path)) || !scope.live()) throw new RpcFail("unavailable");
    const abs = scope.abs(path);
    if (!(await fsApi.exists(abs).catch(() => false)) || !scope.live()) throw new RpcFail("unavailable");
    stillAllowed(peer, signal);
    if (startBlocked()) throw new RpcFail("busy");
    const name = guestName(peer);
    ui.toast(t("ai.collab.dbg.started", { name, file: path }));
    // Not awaited: it can wait for the host (a missing adapter), and the guest sees the state anyway.
    trackStart(peer, hostDebug.start(abs, name));
    return null;
  },
});

registerMethod({
  name: "debug.control",
  capability: "debug",
  validate: (raw) => (isObj(raw) && CONTROL_OPS.includes(raw.op) ? { op: raw.op as ControlOp } : null),
  handle: async ({ op }, { peer, signal }) => {
    stillAllowed(peer, signal);
    const name = guestName(peer);
    if (op === "stop") {
      if (!isLive() && !hostDebug.localLive() && !hostDebug.starting()) throw new RpcFail("no_session");
      ui.toast(t("ai.collab.dbg.stopped", { name }));
      await hostDebug.stop();
    } else if (op === "restart") {
      // Only a running session, and only a file this guest could have named itself.
      if (!isLive()) throw new RpcFail("no_session");
      if (startBlocked()) throw new RpcFail("busy");
      const file = hostDebug.planFile();
      const scope = guestScope();
      const rel = file && scope ? scope.rel(file) : null;
      if (!file || !scope || !rel || !(await scope.check(rel)) || !scope.live()) throw new RpcFail("unavailable");
      stillAllowed(peer, signal);
      if (startBlocked() || hostDebug.planFile() !== file || !isLive()) throw new RpcFail("busy");
      ui.toast(t("ai.collab.dbg.restarted", { name }));
      trackStart(peer, hostDebug.restart(file, name));
    } else if (op === "pause") {
      if (dbg.status !== "running") throw new RpcFail("not_running");
      await hostDebug.pause(name);
    } else {
      if (dbg.status !== "stopped") throw new RpcFail("not_stopped");
      await hostDebug.step(op, name);
    }
    return null;
  },
});

registerMethod({
  name: "debug.thread",
  capability: "debug",
  validate: (raw) => (isObj(raw) && isId(raw.id) ? { id: raw.id } : null),
  handle: async ({ id }, { peer, signal }) => {
    stillAllowed(peer, signal);
    if (dbg.status !== "stopped") throw new RpcFail("not_stopped");
    if (!dbg.threads.some((x) => x.id === id)) throw new RpcFail("stale");
    await hostDebug.selectThread(id);
    return null;
  },
});

registerMethod({
  name: "debug.frame",
  capability: "debug",
  validate: (raw) => (isObj(raw) && isId(raw.id) ? { id: raw.id } : null),
  handle: async ({ id }, { peer, signal }) => {
    stillAllowed(peer, signal);
    if (dbg.status !== "stopped") throw new RpcFail("not_stopped");
    const frame = dbg.frames.find((f) => f.id === id);
    if (!frame) throw new RpcFail("stale");
    await hostDebug.selectFrame(frame);
    return null;
  },
});

registerMethod({
  name: "debug.variables",
  capability: "debug",
  validate: (raw) => (isObj(raw) && isId(raw.ref) && raw.ref > 0 ? { ref: raw.ref } : null),
  handle: async ({ ref }, { peer, signal }) => {
    stillAllowed(peer, signal);
    if (dbg.status !== "stopped") throw new RpcFail("not_stopped");
    const gen = hostDebug.gen();
    if (!refs.has(gen, ref)) throw new RpcFail("stale");
    let raw: any[];
    try {
      raw = await hostDebug.variables(ref);
    } catch {
      throw new RpcFail(hostDebug.gen() === gen ? "failed" : "stale");
    }
    stillAllowed(peer, signal);
    if (hostDebug.gen() !== gen) throw new RpcFail("stale");
    const vars: MirrorVar[] = [];
    let chars = 0;
    for (const v of raw) {
      if (vars.length >= DEBUG_LIMITS.children || chars >= DEBUG_LIMITS.childrenChars) break;
      const value = clip(String(v.value ?? ""), DEBUG_LIMITS.valueChars);
      const name = clip(String(v.name ?? ""), DEBUG_LIMITS.nameChars);
      const type = typeof v.type === "string" ? clip(v.type, DEBUG_LIMITS.nameChars) : undefined;
      const evaluateName = typeof v.evaluateName === "string" ? clip(v.evaluateName, DEBUG_LIMITS.expressionChars) : undefined;
      chars += value.length + name.length + (type?.length ?? 0) + (evaluateName?.length ?? 0);
      const child = isId(v.variablesReference) ? v.variablesReference : 0;
      refs.add(gen, child);
      vars.push({
        name,
        value,
        ref: child,
        ...(type === undefined ? {} : { type }),
        ...(evaluateName === undefined ? {} : { evaluateName }),
      });
    }
    return { vars, truncated: vars.length < raw.length };
  },
});

registerMethod({
  name: "debug.evaluate",
  capability: "debug",
  validate: (raw) => {
    if (!isObj(raw) || typeof raw.expression !== "string" || !raw.expression.trim() || raw.expression.length > DEBUG_LIMITS.expressionChars) return null;
    if (!EVAL_CONTEXTS.includes(raw.context) || !isId(raw.frameId)) return null;
    return { expression: raw.expression, context: raw.context as EvalContext, frameId: raw.frameId };
  },
  handle: async ({ expression, context, frameId }, { peer, signal }) => {
    stillAllowed(peer, signal);
    if (dbg.status !== "stopped") throw new RpcFail("not_stopped");
    if (!dbg.frames.some((f) => f.id === frameId)) throw new RpcFail("stale");
    const gen = hostDebug.gen();
    const repl = context === "repl";
    if (repl) hostDebug.log(`${guestName(peer)} › ${clip(expression, DEBUG_LIMITS.lineChars)}`, "input");
    try {
      const r = await hostDebug.evaluate(expression, context, frameId);
      stillAllowed(peer, signal);
      if (hostDebug.gen() !== gen) throw new RpcFail("stale");
      const value = clip(String(r.result ?? ""), DEBUG_LIMITS.valueChars);
      const ref = isId(r.variablesReference) ? r.variablesReference : 0;
      refs.add(gen, ref);
      if (repl) {
        hostDebug.log(value, "result");
        await hostDebug.refresh();
      }
      return { value, ref };
    } catch (e) {
      if (e instanceof RpcFail) throw e;
      if (hostDebug.gen() !== gen) throw new RpcFail("stale");
      // The adapter's message can name files: it counts as a message, not a value.
      const error = shown(e instanceof Error ? e.message : e, DEBUG_LIMITS.lineChars);
      if (repl) hostDebug.log(error, "error");
      return { error };
    }
  },
});

registerMethod({
  name: "debug.watches",
  capability: "debug",
  validate: (raw) => {
    if (!isObj(raw) || !isId(raw.frameId) || !Array.isArray(raw.expressions) || raw.expressions.length > DEBUG_LIMITS.watches) return null;
    if (!raw.expressions.every((x) => typeof x === "string" && x.trim() && x.length <= DEBUG_LIMITS.expressionChars)) return null;
    return { frameId: raw.frameId, expressions: raw.expressions as string[] };
  },
  handle: async ({ frameId, expressions }, { peer, signal }) => {
    stillAllowed(peer, signal);
    if (dbg.status !== "stopped") throw new RpcFail("not_stopped");
    if (!dbg.frames.some((f) => f.id === frameId)) throw new RpcFail("stale");
    const gen = hostDebug.gen();
    const results: EvalResult[] = [];
    for (const expression of expressions) {
      stillAllowed(peer, signal);
      if (hostDebug.gen() !== gen) throw new RpcFail("stale");
      try {
        const r = await hostDebug.evaluate(expression, "watch", frameId);
        if (hostDebug.gen() !== gen) throw new RpcFail("stale");
        const ref = isId(r.variablesReference) ? r.variablesReference : 0;
        refs.add(gen, ref);
        results.push({ value: clip(String(r.result ?? ""), DEBUG_LIMITS.watchChars), ref });
      } catch (e) {
        if (e instanceof RpcFail) throw e;
        if (hostDebug.gen() !== gen) throw new RpcFail("stale");
        results.push({ error: shown(e instanceof Error ? e.message : e, DEBUG_LIMITS.nameChars) });
      }
    }
    stillAllowed(peer, signal);
    return { results };
  },
});

registerMethod({
  name: "debug.setVariable",
  capability: "debug",
  validate: (raw) => {
    if (!isObj(raw) || !isId(raw.ref) || raw.ref <= 0) return null;
    if (typeof raw.name !== "string" || !raw.name || raw.name.length > DEBUG_LIMITS.nameChars) return null;
    if (typeof raw.value !== "string" || raw.value.length > DEBUG_LIMITS.expressionChars) return null;
    return { ref: raw.ref, name: raw.name, value: raw.value };
  },
  handle: async ({ ref, name, value }, { peer, signal }) => {
    stillAllowed(peer, signal);
    if (dbg.status !== "stopped") throw new RpcFail("not_stopped");
    const gen = hostDebug.gen();
    if (!refs.has(gen, ref)) throw new RpcFail("stale");
    let result: string | null;
    try {
      result = await hostDebug.setVariable(ref, name, value);
    } catch {
      throw new RpcFail(hostDebug.gen() === gen ? "failed" : "stale");
    }
    if (result === null) throw new RpcFail("no_set_variable");
    return { value: clip(String(result), DEBUG_LIMITS.valueChars) };
  },
});

registerMethod({
  name: "debug.breakpoints",
  // `debug` edits; `edit` alone may only carry existing breakpoints along with the text it changes.
  capability: null,
  validate: (raw) => {
    if (!isObj(raw)) return null;
    const path = cleanRel(raw.path);
    const lines = cleanBreakpoints(raw.lines);
    return path && lines ? { path, lines } : null;
  },
  handle: async ({ path, lines }, { peer, signal }) => {
    if (!hasCapability(peer, "debug") && !hasCapability(peer, "edit")) throw new RpcFail("forbidden");
    const scope = guestScope();
    if (!scope || !(await scope.check(path)) || !scope.live()) throw new RpcFail("unavailable");
    const abs = scope.abs(path);
    if (!(await fsApi.exists(abs).catch(() => false)) || !scope.live()) throw new RpcFail("unavailable");
    stillAllowed(peer, signal, null);
    // Decided on the current list and rights, after the awaits above.
    const mayEdit = hasCapability(peer, "debug");
    if (!mayEdit && !hasCapability(peer, "edit")) throw new RpcFail("forbidden");
    const current = dbg.breakpoints[abs] ?? [];
    // Guests never saw this list whole, so what they send can't replace it.
    if (!shareableBreakpoints(current)) throw new RpcFail("too_many");
    if (!current.length && lines.length && Object.values(dbg.breakpoints).filter((l) => l.length).length >= DEBUG_LIMITS.bpFiles) throw new RpcFail("too_many");
    if (!applyGuestBreakpoints(abs, lines, peer, mayEdit)) throw new RpcFail("forbidden");
    return null;
  },
});

// ------------------------------------------------------------------ guest

const guestConnected = () => collab.role === "guest" && collab.status === "connected";

let cur: MirrorState | null = null;
let published: Record<string, SharedBreakpoint[]> = {};
const sending = new Map<string, { line: number; condition?: string }[] | null>();
const skippedPublish = new Set<string>();

function debugErrorText(code: string) {
  switch (code) {
    case "stale":
      return t("ai.collab.dbg.stale");
    case "not_stopped":
    case "not_running":
      return t("ai.collab.dbg.notStopped");
    case "busy":
      return t("ai.collab.dbg.busy");
    case "no_session":
      return t("ai.collab.dbg.noSession");
    case "no_set_variable":
      return t("ai.collab.dbg.noSetVariable");
    case "too_many":
      return t("ai.collab.dbg.tooMany");
    case "unavailable":
      return t("ai.collab.fileUnavailable");
    default:
      return rpcErrorText(code);
  }
}

const report = (r: RpcResult<unknown>) => {
  // A cancelled call was given up on purpose.
  if (!r.ok && r.error.code !== "cancelled") ui.toast(debugErrorText(r.error.code), "error");
};

function clearWatchValues() {
  for (const w of dbg.watches) {
    w.value = "";
    w.ref = 0;
    w.children = null;
    w.expanded = false;
    w.error = false;
  }
}

function clearMirror() {
  cancelWatches();
  cur = null;
  Object.assign(dbg, { status: "idle", label: "", stopReason: "", actor: "", threads: [], threadId: null, frames: [], frameId: null, scopes: [], exec: null, console: [] });
  clearWatchValues();
  hostDebug.refreshEditor();
}

const nodePath = (n: VarNode & { _path?: string }) => n._path ?? n.name;
const flatten = (nodes: VarNode[]): VarNode[] => nodes.flatMap((n) => [n, ...(n.children ? flatten(n.children) : [])]);

async function fetchChildren(ref: number, prefix: string): Promise<VarNode[] | null> {
  const r = await call("debug.variables", { ref });
  if (!r.ok) {
    if (r.error.code !== "stale" && r.error.code !== "not_stopped") report(r);
    return null;
  }
  return r.value.vars.map((v) => {
    const node: VarNode & { _path?: string } = { name: v.name, value: v.value, type: v.type, ref: v.ref, evaluateName: v.evaluateName, parentRef: ref, children: null, expanded: false };
    node._path = `${prefix}/${v.name}`;
    return node;
  });
}

async function expand(n: VarNode) {
  if (!n.ref) return;
  if (!n.children) {
    const kids = await fetchChildren(n.ref, nodePath(n));
    if (!kids) return;
    n.children = kids;
  }
  n.expanded = true;
}

async function reloadScopes(m: MirrorState, keepOpen: boolean) {
  const prev = new Map(flatten(dbg.scopes).map((n) => [nodePath(n), n.value]));
  const open = new Set(flatten(dbg.scopes).filter((n) => n.expanded).map(nodePath));
  const nodes: VarNode[] = m.scopes.map((s) => ({ name: s.name, value: "", ref: s.ref, parentRef: 0, children: null, expanded: false }));
  dbg.scopes = nodes;
  let budget = DEBUG_LIMITS.reopen;
  const reopen = async (list: VarNode[]) => {
    for (const n of list) {
      if (cur !== m || budget <= 0) return;
      if (!n.ref || !open.has(nodePath(n))) continue;
      budget--;
      await expand(n);
      if (n.children) await reopen(n.children);
    }
  };
  if (keepOpen) await reopen(dbg.scopes);
  for (let i = 0; i < m.scopes.length; i++) if (cur === m && m.scopes[i].open && !dbg.scopes[i]?.expanded) await expand(dbg.scopes[i]);
  if (cur !== m) return;
  for (const n of flatten(dbg.scopes)) {
    const old = prev.get(nodePath(n));
    n.changed = old !== undefined && old !== n.value;
  }
}

const WATCH_DELAY_MS = 100;
let watchTimer = 0;
let watchCall: AbortController | null = null;

function cancelWatches() {
  clearTimeout(watchTimer);
  watchCall?.abort();
  watchCall = null;
}

/** One batched request for the newest stop, so fast stepping can't run into the rate limit. */
function scheduleWatches() {
  cancelWatches();
  if (cur?.status !== "stopped" || cur.frameId === null) return clearWatchValues();
  if (!dbg.watches.length) return;
  watchTimer = window.setTimeout(() => void runWatches(), WATCH_DELAY_MS);
}

async function runWatches() {
  const m = cur;
  if (!m || m.status !== "stopped" || m.frameId === null) return;
  const watches = dbg.watches.slice(0, DEBUG_LIMITS.watches);
  if (!watches.length) return;
  const controller = (watchCall = new AbortController());
  const r = await call("debug.watches", { frameId: m.frameId, expressions: watches.map((w) => w.expr.slice(0, DEBUG_LIMITS.expressionChars)) }, { signal: controller.signal });
  if (watchCall === controller) watchCall = null;
  if (controller.signal.aborted || cur !== m) return;
  if (!r.ok && r.error.code === "stale") return; // the state that replaces this one is on its way
  watches.forEach((w, i) => {
    w.children = null;
    w.expanded = false;
    const one = r.ok ? r.value.results[i] : { error: debugErrorText(r.error.code) };
    if (!one || "error" in one) {
      w.value = one?.error ?? "";
      w.error = true;
      w.ref = 0;
    } else {
      w.value = one.value;
      w.ref = one.ref;
      w.error = false;
    }
  });
}

async function applyState(m: MirrorState) {
  const prev = cur;
  cur = m;
  Object.assign(dbg, { status: m.status, label: m.label, stopReason: m.stopReason, actor: m.actor, threads: m.threads, threadId: m.threadId, frameId: m.frameId });
  dbg.frames = m.frames.map((f): Frame => ({ id: f.id, name: f.name, path: f.rel === null ? null : REMOTE + f.rel, line: f.line, column: f.column, subtle: f.subtle }));
  dbg.exec = m.exec ? { path: REMOTE + m.exec.rel, line: m.exec.line } : null;
  hostDebug.refreshEditor();
  if (m.status !== "stopped") {
    cancelWatches();
    dbg.scopes = [];
    clearWatchValues();
    return;
  }
  const moved = prev?.gen !== m.gen || prev.frameId !== m.frameId || prev.status !== "stopped";
  const refreshed = moved || prev?.scopesVersion !== m.scopesVersion;
  if (moved && m.exec) {
    setMode("code");
    void openRemote(m.exec.rel, m.exec.line);
  }
  if (refreshed) await reloadScopes(m, !moved);
  else for (let i = 0; i < m.scopes.length; i++) if (m.scopes[i].open && dbg.scopes[i] && !dbg.scopes[i].expanded && !dbg.scopes[i].children) await expand(dbg.scopes[i]);
  if (refreshed && cur === m) scheduleWatches();
}

function applyBreakpoints(files: Record<string, SharedBreakpoint[]>) {
  published = files;
  for (const key of Object.keys(dbg.breakpoints)) {
    if (!key.startsWith(SHARED_BP)) continue;
    const rel = key.slice(SHARED_BP.length);
    if (sending.has(rel)) skippedPublish.add(rel);
    else if (!files[rel]) delete dbg.breakpoints[key];
  }
  for (const [rel, list] of Object.entries(files)) {
    if (sending.has(rel)) skippedPublish.add(rel);
    else dbg.breakpoints[SHARED_BP + rel] = list.map((b) => ({ ...b }));
  }
  hostDebug.refreshEditor();
}

function restorePublished(rel: string) {
  const list = published[rel];
  if (list) dbg.breakpoints[SHARED_BP + rel] = list.map((b) => ({ ...b }));
  else delete dbg.breakpoints[SHARED_BP + rel];
  hostDebug.refreshEditor();
}

/** One request per file at a time; the newest list goes next, older ones are dropped. */
async function sendBreakpoints(rel: string, lines: { line: number; condition?: string }[]) {
  if (sending.has(rel)) return void sending.set(rel, lines);
  sending.set(rel, null);
  let next: typeof lines | null = lines;
  let failed = false;
  while (next) {
    const r: RpcResult<null> = await call("debug.breakpoints", { path: rel, lines: next });
    if (!r.ok) {
      failed = true;
      report(r);
    } else failed = false;
    next = sending.get(rel) ?? null;
    sending.set(rel, null);
  }
  sending.delete(rel);
  // The host's list is the truth: after a refusal, or for a change that arrived meanwhile.
  if (failed || skippedPublish.delete(rel)) restorePublished(rel);
}

async function guestAction(op: ControlOp) {
  if (blockedByCapability("debug")) return;
  report(await call("debug.control", { op }));
}

const guestDebug: DebugRemote = {
  active: guestConnected,
  async start() {
    if (blockedByCapability("debug")) return;
    const path = activeTab()?.path;
    const rel = isRemote(path) ? cleanRel(path!.slice(REMOTE.length)) : null;
    if (!rel) return ui.toast(t("ai.collab.dbg.noFile"), "error");
    setMode("code");
    showView("debug");
    report(await call("debug.start", { path: rel }));
  },
  stop: () => guestAction("stop"),
  restart: () => guestAction("restart"),
  step: (cmd) => guestAction(cmd),
  pause: () => guestAction("pause"),
  async selectThread(id) {
    if (blockedByCapability("debug")) return;
    report(await call("debug.thread", { id }));
  },
  async selectFrame(f) {
    if (blockedByCapability("debug")) return;
    report(await call("debug.frame", { id: f.id }));
  },
  async toggleNode(n) {
    if (!n.ref) return;
    if (n.expanded) {
      n.expanded = false;
      return;
    }
    await expand(n);
  },
  async toggleWatch(i) {
    const w = dbg.watches[i];
    if (!w?.ref) return;
    if (!w.expanded && !w.children) {
      const kids = await fetchChildren(w.ref, `watch:${w.expr}`);
      if (!kids) return;
      w.children = kids;
    }
    w.expanded = !w.expanded;
  },
  async setVariable(n, value) {
    if (blockedByCapability("debug")) return;
    const r = await call("debug.setVariable", { ref: n.parentRef, name: n.name, value });
    if (!r.ok) return report(r);
    n.value = r.value.value;
    n.changed = true;
  },
  evaluateWatches: async () => scheduleWatches(),
  async replEval(expr) {
    if (blockedByCapability("debug")) return;
    if (!cur || cur.frameId === null) return ui.toast(t("ai.collab.dbg.notStopped"), "error");
    // Input and result come back through the shared console.
    report(await call("debug.evaluate", { expression: expr.slice(0, DEBUG_LIMITS.expressionChars), context: "repl", frameId: cur.frameId }));
  },
  async hover(expr) {
    if (!cur || cur.status !== "stopped" || cur.frameId === null || !collab.myCaps.includes("debug")) return null;
    const r = await call("debug.evaluate", { expression: expr.slice(0, DEBUG_LIMITS.expressionChars), context: "hover", frameId: cur.frameId });
    return r.ok && "value" in r.value ? r.value.value : null;
  },
  breakpointsChanged(path) {
    const rel = cleanRel(path.slice(SHARED_BP.length));
    if (!rel) return;
    const lines = (dbg.breakpoints[path] ?? []).map((b) => (b.condition ? { line: b.line, condition: b.condition } : { line: b.line }));
    void sendBreakpoints(rel, lines);
  },
};
dbgRemote.impl = guestDebug;

const isMirror = (v: unknown): v is MirrorState =>
  isObj(v) && typeof v.status === "string" && Array.isArray(v.frames) && Array.isArray(v.threads) && Array.isArray(v.scopes) && typeof v.gen === "number";

subscribe("debug.state", (v) => {
  if (!guestConnected() && v !== null) return;
  if (isMirror(v)) void applyState(v);
  else clearMirror();
});

const bpFiles = (v: unknown) => (isObj(v) && isObj(v.files) ? (v.files as Record<string, SharedBreakpoint[]>) : null);
/** With `debug` the list with conditions counts; without, the one every guest gets. */
let filesOpen: Record<string, SharedBreakpoint[]> = {};
let filesFull: Record<string, SharedBreakpoint[]> | null = null;

subscribe("debug.bps", (v) => {
  filesOpen = bpFiles(v) ?? {};
  if (!filesFull) applyBreakpoints(filesOpen);
});

subscribe("debug.bpsFull", (v) => {
  filesFull = bpFiles(v);
  applyBreakpoints(filesFull ?? filesOpen);
});

subscribe("debug.console", (v) => {
  if (!v || !Array.isArray(v.lines)) return;
  if (v.reset) dbg.console = [];
  if (v.skipped > 0) dbg.console.push({ text: t("ai.collab.dbg.skipped", { count: v.skipped }), kind: "info" });
  dbg.console.push(...v.lines.filter((l) => typeof l?.text === "string"));
  if (dbg.console.length > 2000) dbg.console.splice(0, dbg.console.length - 2000);
});

onCollabMessage((_peer, msg) => {
  if (collab.role === "host") {
    if (msg.t === "hello-ready") schedulePublish();
    return;
  }
  if (msg.t === "welcome" && collab.role === "guest" && hostDebug.localLive()) {
    // The guest's own session can't share the panels with the host's.
    void stopLocal().then(() => (cur ? applyState(cur) : clearMirror()));
  }
});

sessionEndHooks.push((wasGuest) => {
  if (wasGuest) {
    for (const key of Object.keys(dbg.breakpoints)) if (key.startsWith(SHARED_BP)) delete dbg.breakpoints[key];
    published = {};
    filesOpen = {};
    filesFull = null;
    sending.clear();
    skippedPublish.clear();
    // A join that was refused never replaced this machine's own running session.
    if (hostDebug.localLive()) hostDebug.refreshEditor();
    else clearMirror();
    return;
  }
  const hadGuests = guestStarted;
  // A start still on its way ends with the session, and restart can't launch what a guest chose.
  if (startingPeer && hostDebug.starting()) void hostDebug.cancelStart();
  startingPeer = null;
  hostDebug.forgetGuestPlan();
  endGuestBreakpoints();
  guestStarted = false;
  clearTimeout(termTimer);
  termScrubber = null;
  termWaiting = [];
  termWaitingChars = 0;
  refs.clear();
  relCache.clear();
  relCacheKey = "";
  lastState = null;
  lastBps = null;
  lastBpsFull = null;
  hostDebug.release();
  if (hadGuests && isLive()) ui.toast(t("ai.collab.dbg.stillRunning"));
});

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
