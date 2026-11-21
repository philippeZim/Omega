/**
 * Code Together RPC: guests ask the host to do things, the host pushes state to guests.
 *
 * Add a method (next to the feature, on the host and guest side of one module):
 *
 *   declare module "./rpc.svelte" {
 *     interface RpcMethods { "git.status": { params: { path: string }; result: Status } }
 *   }
 *   registerMethod({
 *     name: "git.status",
 *     capability: "git",            // null: any approved guest
 *     validate: (raw) => (isObj(raw) && typeof raw.path === "string" ? { path: raw.path } : null),
 *     handle: async ({ path }, { peer, signal }) => { ... }, // throw new RpcFail("code") to refuse
 *   });
 *   const r = await call("git.status", { path: "" }); // r.ok ? r.value : rpcErrorText(r.error.code)
 *
 * `call` never throws. Paths from guests go through `guestScope()` (share.svelte.ts).
 *
 * Push state: declare it in `RpcTopics`, `registerTopic({ name, capability, snapshot })` on the host,
 * `publish(name, value)` on every change, `subscribe(name, cb)` on the guest. A subscriber gets the
 * snapshot first, so late joiners are current; `cb(null)` means the value is gone (session ended or
 * capability revoked).
 */
import { collab, send, onCollabMessage, sessionEndHooks, type Participant } from "./collab.svelte";
import { CAPABILITIES, type Capability } from "./guard";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

/** Method name -> params and result. Features add theirs with `declare module`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RpcMethods {}
/** Topic name -> payload. Features add theirs with `declare module`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RpcTopics {}

export type RpcMethod = keyof RpcMethods & string;
export type RpcTopic = keyof RpcTopics & string;
type ParamsOf<M extends RpcMethod> = RpcMethods[M] extends { params: infer P } ? P : never;
type ResultOf<M extends RpcMethod> = RpcMethods[M] extends { result: infer R } ? R : never;
type PayloadOf<T extends RpcTopic> = RpcTopics[T];

/** Codes of the RPC layer. Handlers can add their own with `RpcFail` (lower_snake_case). */
export type RpcErrorCode = "unknown_method" | "invalid_params" | "forbidden" | "rate_limited" | "too_large" | "timeout" | "cancelled" | "session_ended" | "internal";
export interface RpcError {
  code: RpcErrorCode | (string & {});
}
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

/** Thrown by a handler to refuse with a stable code. Anything else becomes "internal". */
export class RpcFail extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface RpcContext {
  /** Transport identity of the caller. */
  peer: string;
  /** Aborted when the caller cancels or leaves, or loses the method's capability. */
  signal: AbortSignal;
}

export interface MethodDef<M extends RpcMethod> {
  name: M;
  /** What the guest needs; null: any approved guest. */
  capability: Capability | null;
  /** The params in their checked form, or null if they're invalid. */
  validate: (raw: unknown) => ParamsOf<M> | null;
  handle: (params: ParamsOf<M>, ctx: RpcContext) => Promise<ResultOf<M>> | ResultOf<M>;
}

export interface TopicDef<T extends RpcTopic> {
  name: T;
  capability: Capability | null;
  /** Current value for a new subscriber (keep it cheap and synchronous). */
  snapshot?: () => PayloadOf<T> | null;
}

export const RPC_LIMITS = {
  /** Below the transport's 32 MB, where an oversized message drops the whole connection. */
  maxBytes: 24 * 1024 * 1024,
  burst: 120,
  perSecond: 60,
  maxConcurrent: 16,
  timeoutMs: 15_000,
};

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a JSON text fits the limit (cheap for the common small case). */
function fits(json: string) {
  if (json.length * 3 <= RPC_LIMITS.maxBytes) return true;
  return json.length <= RPC_LIMITS.maxBytes && new TextEncoder().encode(json).length <= RPC_LIMITS.maxBytes;
}

// ------------------------------------------------------------------ host

interface Running {
  controller: AbortController;
  capability: Capability | null;
}
interface PeerState {
  tokens: number;
  refilled: number;
  running: Map<number, Running>;
  topics: Set<string>;
}

const methods = new Map<string, MethodDef<any>>();
const topics = new Map<string, TopicDef<any>>();
const peers = new Map<string, PeerState>();

export function registerMethod<M extends RpcMethod>(def: MethodDef<M>) {
  methods.set(def.name, def);
}

export function registerTopic<T extends RpcTopic>(def: TopicDef<T>) {
  topics.set(def.name, def);
}

/** The approved guest behind a transport id. The id is the only identity that counts. */
const approved = (peer: string): Participant | undefined => collab.participants.find((p) => p.peer === peer && p.role === "guest" && !p.removing);

export const hasCapability = (peer: string, cap: Capability) => !!approved(peer)?.caps?.includes(cap);
const allowed = (peer: string, cap: Capability | null) => (cap ? hasCapability(peer, cap) : !!approved(peer));

function peerState(peer: string) {
  let st = peers.get(peer);
  if (!st) peers.set(peer, (st = { tokens: RPC_LIMITS.burst, refilled: Date.now(), running: new Map(), topics: new Set() }));
  return st;
}

function takeToken(st: PeerState) {
  const now = Date.now();
  st.tokens = Math.min(RPC_LIMITS.burst, st.tokens + ((now - st.refilled) / 1000) * RPC_LIMITS.perSecond);
  st.refilled = now;
  if (st.tokens < 1) return false;
  st.tokens--;
  return true;
}

const replyError = (peer: string, id: number, code: string) => send(peer, { t: "rpc.res", id, ok: false, error: { code } });

function replyResult(peer: string, id: number, result: unknown) {
  let json: string | undefined;
  try {
    json = JSON.stringify(result ?? null);
  } catch {
    return replyError(peer, id, "internal");
  }
  if (!fits(json)) return replyError(peer, id, "too_large");
  return send(peer, { t: "rpc.res", id, ok: true, result });
}

async function onRequest(peer: string, msg: Record<string, unknown>) {
  const id = msg.id as number;
  if (!Number.isSafeInteger(id) || !approved(peer)) return; // unapproved peers get no answer at all
  const st = peerState(peer);
  if (st.running.has(id)) return;
  if (!takeToken(st) || st.running.size >= RPC_LIMITS.maxConcurrent) return replyError(peer, id, "rate_limited");
  const def = typeof msg.method === "string" ? methods.get(msg.method) : undefined;
  if (!def) return replyError(peer, id, "unknown_method");
  if (!allowed(peer, def.capability)) return replyError(peer, id, "forbidden");
  let params: unknown;
  try {
    params = def.validate(msg.params);
  } catch {
    params = null;
  }
  if (params === null || params === undefined) return replyError(peer, id, "invalid_params");

  const controller = new AbortController();
  st.running.set(id, { controller, capability: def.capability });
  try {
    const result = await def.handle(params, { peer, signal: controller.signal });
    if (peers.get(peer) !== st || !approved(peer)) return; // left meanwhile
    if (controller.signal.aborted) {
      if (controller.signal.reason === "forbidden") await replyError(peer, id, "forbidden");
      return;
    }
    if (!allowed(peer, def.capability)) return void (await replyError(peer, id, "forbidden"));
    await replyResult(peer, id, result);
  } catch (e) {
    if (peers.get(peer) !== st || !approved(peer)) return;
    if (controller.signal.aborted && controller.signal.reason !== "forbidden") return;
    if (controller.signal.reason === "forbidden") return void (await replyError(peer, id, "forbidden"));
    // Stable codes only: messages can hold absolute paths, and those stay in the host's log.
    if (e instanceof RpcFail && /^[a-z][a-z0-9_]{0,40}$/.test(e.code)) return void (await replyError(peer, id, e.code));
    console.error(`rpc ${def.name}`, e);
    await replyError(peer, id, "internal");
  } finally {
    st.running.delete(id);
  }
}

function sendTopic(peer: string, topic: string, payload: unknown) {
  return send(peer, { t: "rpc.pub", topic, payload: payload ?? null });
}

function sendSnapshot(peer: string, def: TopicDef<any>) {
  const value = def.snapshot?.();
  if (value === undefined || value === null) return;
  if (fits(JSON.stringify(value))) sendTopic(peer, def.name, value);
  else console.warn(`rpc topic ${def.name}: snapshot too large`);
}

/** Host: sends a new value to the subscribers allowed to see it. False if it was too large. */
export function publish<T extends RpcTopic>(topic: T, payload: PayloadOf<T> | null): boolean {
  if (collab.role !== "host") return false;
  const def = topics.get(topic);
  if (!def) throw new Error(`rpc: unregistered topic ${topic}`);
  if (!fits(JSON.stringify(payload ?? null))) {
    console.warn(`rpc topic ${topic}: payload too large`);
    return false;
  }
  for (const [peer, st] of peers) if (st.topics.has(topic) && allowed(peer, def.capability)) sendTopic(peer, topic, payload);
  return true;
}

/** Host: turns one capability of a guest on or off, effective immediately. */
export function setCapability(peer: string, cap: Capability, on: boolean) {
  const p = approved(peer);
  if (!p || !CAPABILITIES.includes(cap) || !!p.caps?.includes(cap) === on) return;
  const before = p.caps ?? [];
  p.caps = CAPABILITIES.filter((c) => (c === cap ? on : before.includes(c)));
  send(peer, { t: "rpc.caps", caps: [...p.caps] });
  const st = peers.get(peer);
  if (!st) return;
  if (!on) for (const r of st.running.values()) if (r.capability === cap) r.controller.abort("forbidden");
  for (const name of st.topics) {
    const def = topics.get(name);
    if (def?.capability !== cap) continue;
    if (on) sendSnapshot(peer, def);
    else sendTopic(peer, name, null);
  }
}

/** Host: a guest left or was removed. Its running calls are aborted and its state dropped. */
export function forgetRpcPeer(peer: string) {
  const st = peers.get(peer);
  if (!st) return;
  peers.delete(peer);
  for (const r of st.running.values()) r.controller.abort("left");
}

// ------------------------------------------------------------------ guest

interface Pending {
  settle: (r: RpcResult<any>) => void;
}

let nextId = 0;
const pending = new Map<number, Pending>();
const subscribers = new Map<string, Set<(payload: any) => void>>();
const lastValues = new Map<string, unknown>();
const capListeners = new Set<(before: Capability[], now: Capability[]) => void>();

const guestConnected = () => collab.role === "guest" && collab.status === "connected" && !!collab.hostPeer;
const failed = (code: RpcErrorCode): RpcResult<never> => ({ ok: false, error: { code } });

/**
 * Guest: calls a method on the host. Resolves with the result or a typed error and never throws:
 * timeout, cancellation and the end of the session are errors too.
 */
export function call<M extends RpcMethod>(method: M, params: ParamsOf<M>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RpcResult<ResultOf<M>>> {
  if (!guestConnected()) return Promise.resolve(failed("session_ended"));
  if (opts.signal?.aborted) return Promise.resolve(failed("cancelled"));
  let json: string;
  try {
    json = JSON.stringify(params ?? null);
  } catch {
    return Promise.resolve(failed("invalid_params"));
  }
  if (!fits(json)) return Promise.resolve(failed("too_large"));

  const id = ++nextId;
  const host = collab.hostPeer!;
  return new Promise((resolve) => {
    const onAbort = () => {
      send(host, { t: "rpc.cancel", id });
      settle(failed("cancelled"));
    };
    const timer = setTimeout(() => {
      send(host, { t: "rpc.cancel", id });
      settle(failed("timeout"));
    }, opts.timeoutMs ?? RPC_LIMITS.timeoutMs);
    const settle = (r: RpcResult<any>) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      pending.delete(id);
      resolve(r);
    };
    pending.set(id, { settle });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    send(host, { t: "rpc.req", id, method, params });
  });
}

/**
 * Guest: follows a topic until the returned function is called. Survives across sessions, so it can
 * be set up once at module level; `cb(null)` when the value goes away.
 */
export function subscribe<T extends RpcTopic>(topic: T, cb: (payload: PayloadOf<T> | null) => void): () => void {
  let set = subscribers.get(topic);
  if (!set) {
    subscribers.set(topic, (set = new Set()));
    if (guestConnected()) send(collab.hostPeer!, { t: "rpc.sub", topic });
  }
  set.add(cb);
  if (lastValues.has(topic)) cb(lastValues.get(topic) as PayloadOf<T>);
  return () => {
    const s = subscribers.get(topic);
    if (!s?.delete(cb) || s.size) return;
    subscribers.delete(topic);
    lastValues.delete(topic);
    if (guestConnected()) send(collab.hostPeer!, { t: "rpc.unsub", topic });
  };
}

/** Guest: runs when the host changed what this guest may do. */
export function onCapabilitiesChanged(fn: (before: Capability[], now: Capability[]) => void) {
  capListeners.add(fn);
  return () => capListeners.delete(fn);
}

function deliver(topic: string, payload: unknown) {
  for (const cb of [...(subscribers.get(topic) ?? [])]) {
    try {
      cb(payload);
    } catch (e) {
      console.error(`rpc topic ${topic}`, e);
    }
  }
}

function applyCapabilities(raw: unknown) {
  if (!Array.isArray(raw)) return;
  const before = [...collab.myCaps];
  const now = CAPABILITIES.filter((c) => raw.includes(c));
  collab.myCaps = now;
  for (const c of now) if (!before.includes(c)) ui.toast(t("ai.collab.capOn", { cap: capabilityLabel(c) }));
  for (const c of before) if (!now.includes(c)) ui.toast(t("ai.collab.capOff", { cap: capabilityLabel(c) }));
  for (const fn of capListeners) fn(before, now);
}

/** Text for an RPC error code (feature-specific codes are the feature's to translate first). */
export function rpcErrorText(code: string): string {
  switch (code) {
    case "forbidden":
      return t("ai.collab.rpc.forbidden");
    case "rate_limited":
      return t("ai.collab.rpc.rateLimited");
    case "too_large":
      return t("ai.collab.rpc.tooLarge");
    case "timeout":
      return t("ai.collab.fileOpTimeout");
    case "session_ended":
      return t("ai.collab.rpc.sessionEnded");
    default:
      return t("ai.collab.rpc.failed");
  }
}

export const capabilityLabel = (c: Capability) => t(`ai.collab.cap.${c}`);

// ------------------------------------------------------------------ messages

onCollabMessage((peer, msg) => {
  if (collab.role === "host") {
    if (msg.t === "rpc.req") return onRequest(peer, msg);
    if (!approved(peer)) return;
    if (msg.t === "rpc.cancel") peers.get(peer)?.running.get(msg.id)?.controller.abort("cancelled");
    else if (msg.t === "rpc.sub" && typeof msg.topic === "string") {
      const def = topics.get(msg.topic);
      if (!def) return;
      peerState(peer).topics.add(def.name);
      if (allowed(peer, def.capability)) sendSnapshot(peer, def);
    } else if (msg.t === "rpc.unsub") peers.get(peer)?.topics.delete(msg.topic);
    return;
  }
  if (collab.role !== "guest" || peer !== collab.hostPeer) return;
  if (msg.t === "welcome") {
    for (const topic of subscribers.keys()) send(peer, { t: "rpc.sub", topic });
  } else if (msg.t === "rpc.res") {
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.ok === true) p.settle({ ok: true, value: msg.result });
    else p.settle({ ok: false, error: { code: typeof msg.error?.code === "string" ? msg.error.code : "internal" } });
  } else if (msg.t === "rpc.pub" && typeof msg.topic === "string") {
    if (msg.payload === null || msg.payload === undefined) lastValues.delete(msg.topic);
    else lastValues.set(msg.topic, msg.payload);
    deliver(msg.topic, msg.payload ?? null);
  } else if (msg.t === "rpc.caps") applyCapabilities(msg.caps);
});

sessionEndHooks.push(() => {
  for (const p of [...pending.values()]) p.settle(failed("session_ended"));
  for (const peer of [...peers.keys()]) forgetRpcPeer(peer);
  const topicsWithValue = [...lastValues.keys()];
  lastValues.clear();
  for (const topic of topicsWithValue) deliver(topic, null);
});

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
