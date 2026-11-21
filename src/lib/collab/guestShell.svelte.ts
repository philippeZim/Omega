/**
 * Level 2 of guest terminal access: a real shell on the host for one guest (capability `terminal`,
 * off by default). Granting it always goes through the host's confirmation. Each shell is its own
 * PTY in the project root; the host sees who has one (GuestShellBar), can watch it read-only and end
 * it. Losing the capability, leaving, being removed and the end of the session kill it at once.
 */
import { listen } from "@tauri-apps/api/event";
import { collab, onCollabMessage, peerGoneHooks, send, sessionEndHooks, setStartCapability } from "./collab.svelte";
import { blockedByCapability, guestGuard, type Capability } from "./guard";
import { call, hasCapability, isObj, onCapabilitiesChanged, onCapabilityRevoked, registerMethod, rpcErrorText, RpcFail, setCapability } from "./rpc.svelte";
import { InputPump, TERM_LIMITS, validTermSize } from "./guestInput";
import { closeTerminal, markTerminalExited, openGuestShellView, remoteTerminal, resizeGuestShell, spawnGuestShell, terminalSize, terms, writeGuestShell, writeTerminal } from "../terminal.svelte";
import { showView } from "../layout.svelte";
import { app } from "../state.svelte";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

declare module "./rpc.svelte" {
  interface RpcMethods {
    "shell.open": { params: { cols: number; rows: number }; result: { id: string } };
    "shell.input": { params: { id: string; data: string }; result: null };
    "shell.resize": { params: { id: string; cols: number; rows: number }; result: null };
    "shell.close": { params: { id: string }; result: null };
  }
}

// ------------------------------------------------------------------ host: confirmation

let asking = false;

async function confirmed(title: string, body: string) {
  if (asking) return false;
  asking = true;
  try {
    return await ui.confirm(title, body, t("ai.collab.shell.confirmOk"), true);
  } finally {
    asking = false;
  }
}

/** Host: a guest's capability switch. `terminal` only turns on after the confirmation. */
export async function requestCapability(peer: string, cap: Capability, on: boolean) {
  if (cap !== "terminal" || !on) return setCapability(peer, cap, on);
  const name = collab.participants.find((p) => p.peer === peer)?.name ?? t("ai.collab.guest");
  if (await confirmed(t("ai.collab.shell.confirmTitle", { name }), t("ai.collab.shell.confirmBody", { name }))) setCapability(peer, "terminal", true, { confirmed: true });
}

/** Host: the "New guests start with" switch, with the same confirmation for `terminal`. */
export async function requestStartCapability(cap: Capability, on: boolean) {
  if (cap !== "terminal" || !on) return setStartCapability(cap, on);
  if (await confirmed(t("ai.collab.shell.startTitle"), t("ai.collab.shell.startBody"))) setStartCapability("terminal", true, { confirmed: true });
}

// ------------------------------------------------------------------ host: shells

interface HostShell {
  id: string;
  peer: string;
  out: string[];
  outSize: number;
  skipped: boolean;
  timer: number;
  flushing: boolean;
}

const shells = new Map<string, HostShell>();

/** Host: the open guest shells, for the indicator. */
export const guestShells = $state({ list: [] as { id: string; peer: string; name: string; color: string }[] });

function takeOutput(s: HostShell) {
  const chunks: string[] = [];
  let size = 0;
  while (s.out.length && (!chunks.length || size + s.out[0].length <= TERM_LIMITS.maxOutputMessage)) {
    const c = s.out.shift()!;
    size += c.length;
    chunks.push(c);
  }
  s.outSize -= size;
  const skipped = s.skipped;
  s.skipped = false;
  return { t: "shell.data", id: s.id, chunks, ...(skipped ? { skipped: true } : {}) };
}

async function flush(s: HostShell) {
  s.timer = 0;
  if (s.flushing) return;
  s.flushing = true;
  try {
    // Awaited, so a slow connection holds output here, where it's bounded.
    while (shells.get(s.id) === s && s.out.length && hasCapability(s.peer, "terminal")) await send(s.peer, takeOutput(s));
  } finally {
    s.flushing = false;
  }
}

function queueOutput(s: HostShell, b64: string) {
  s.out.push(b64);
  s.outSize += b64.length;
  while (s.outSize > TERM_LIMITS.maxBufferedOutput && s.out.length > 1) {
    s.outSize -= s.out.shift()!.length;
    s.skipped = true;
  }
  if (!s.timer) s.timer = window.setTimeout(() => void flush(s), 30);
}

/** Removes a shell and kills its PTY. `finalOutput`: it ended by itself, the guest gets the rest. */
function endShell(s: HostShell, finalOutput = false) {
  if (shells.get(s.id) !== s) return;
  if (finalOutput && hasCapability(s.peer, "terminal")) while (s.out.length) void send(s.peer, takeOutput(s));
  shells.delete(s.id);
  clearTimeout(s.timer);
  guestShells.list = guestShells.list.filter((x) => x.id !== s.id);
  if (terms.tabs.some((x) => x.id === s.id)) closeTerminal(s.id);
  void send(s.peer, { t: "shell.exit", id: s.id });
}

function endPeerShells(peer: string) {
  for (const s of [...shells.values()]) if (s.peer === peer) endShell(s);
}

/** Host: the End button. */
export function endGuestShell(id: string) {
  const s = shells.get(id);
  if (s) endShell(s);
}

/** Host: shows a guest's shell (read-only) in the terminal panel. */
export function viewGuestShell(id: string) {
  if (!shells.has(id)) return;
  showView("terminal");
  terms.active = id;
}

const ownShell = (id: string, peer: string) => {
  const s = shells.get(id);
  return s?.peer === peer ? s : null;
};

const shellId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

registerMethod({
  name: "shell.open",
  capability: "terminal",
  validate: (raw) => (isObj(raw) && validTermSize(raw.cols, raw.rows) ? { cols: raw.cols as number, rows: raw.rows as number } : null),
  handle: async ({ cols, rows }, { peer, signal }) => {
    const root = app.root;
    if (!root) throw new RpcFail("no_folder");
    const mine = [...shells.values()].filter((s) => s.peer === peer).length;
    if (mine >= TERM_LIMITS.shellsPerGuest || shells.size >= TERM_LIMITS.shellsTotal) throw new RpcFail("shell_limit");
    const who = collab.participants.find((p) => p.peer === peer);
    const name = who?.name ?? t("ai.collab.guest");
    // Counted from here on, so parallel requests can't pass the limit.
    let s: HostShell | undefined;
    const id = openGuestShellView(t("ai.collab.shell.viewTitle", { name }), cols, rows, () => s && endShell(s));
    s = { id, peer, out: [], outSize: 0, skipped: false, timer: 0, flushing: false };
    shells.set(id, s);
    guestShells.list = [...guestShells.list, { id, peer, name, color: who?.color ?? "#888888" }];
    try {
      await spawnGuestShell(id, root, cols, rows);
    } catch (e) {
      console.error("guest shell", e);
      endShell(s);
      throw new RpcFail("shell_failed");
    }
    if (shells.get(id) !== s) throw new RpcFail("forbidden"); // ended while it was starting
    if (signal.aborted || !hasCapability(peer, "terminal")) {
      endShell(s);
      throw new RpcFail("forbidden");
    }
    return { id };
  },
});

registerMethod({
  name: "shell.input",
  capability: "terminal",
  validate: (raw) => (isObj(raw) && shellId(raw.id) && typeof raw.data === "string" && raw.data.length > 0 && raw.data.length <= TERM_LIMITS.maxInput ? { id: raw.id, data: raw.data } : null),
  handle: async ({ id, data }, { peer }) => {
    if (!ownShell(id, peer)) throw new RpcFail("shell_ended");
    const r = await writeGuestShell(id, data);
    if (r === "busy") throw new RpcFail("input_busy");
    if (r === "ended") throw new RpcFail("shell_ended");
    return null;
  },
});

registerMethod({
  name: "shell.resize",
  capability: "terminal",
  validate: (raw) => (isObj(raw) && shellId(raw.id) && validTermSize(raw.cols, raw.rows) ? { id: raw.id, cols: raw.cols as number, rows: raw.rows as number } : null),
  handle: ({ id, cols, rows }, { peer }) => {
    if (!ownShell(id, peer)) throw new RpcFail("shell_ended");
    resizeGuestShell(id, cols, rows);
    return null;
  },
});

registerMethod({
  name: "shell.close",
  capability: null, // closing is always allowed, and only ever the guest's own shell
  validate: (raw) => (isObj(raw) && shellId(raw.id) ? { id: raw.id } : null),
  handle: ({ id }, { peer }) => {
    const s = ownShell(id, peer);
    if (s) endShell(s);
    return null;
  },
});

listen<{ id: string; data: string }>("pty-data", (e) => {
  const s = shells.get(e.payload.id);
  if (s) queueOutput(s, e.payload.data);
});
listen<{ id: string }>("pty-exit", (e) => {
  const s = shells.get(e.payload.id);
  if (s) endShell(s, true);
});

onCapabilityRevoked((peer, cap) => {
  if (cap === "terminal") endPeerShells(peer);
});
peerGoneHooks.push(endPeerShells);

// ------------------------------------------------------------------ guest

interface GuestTab {
  id: string;
  tabId: string;
  pump: InputPump;
  decoder: TextDecoder;
  resizeTimer: number;
}

const open = new Map<string, GuestTab>();
let opening = 0;
/** Output that overtook the answer to `shell.open`. */
const early = new Map<string, Record<string, any>[]>();

function showData(g: GuestTab, msg: Record<string, any>) {
  if (msg.skipped) writeTerminal(g.tabId, `\r\n\x1b[2m${t("ai.collab.shell.skipped")}\x1b[0m\r\n`);
  for (const c of msg.chunks as string[]) {
    try {
      writeTerminal(g.tabId, g.decoder.decode(Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)), { stream: true }));
    } catch {
      /* not base64: nothing to show */
    }
  }
}

/** Guest: the shell is gone; its tab stays so the output can still be read. */
function shellEnded(g: GuestTab) {
  if (!open.delete(g.id)) return;
  g.pump.clear();
  clearTimeout(g.resizeTimer);
  writeTerminal(g.tabId, `\r\n\x1b[2m${t("ai.collab.shell.ended")}\x1b[0m\r\n\x1b[?25l`);
  markTerminalExited(g.tabId);
}

/** Guest: opens a shell on the host in a tab of its own. */
export async function openHostShell() {
  if (blockedByCapability("terminal")) return;
  const host = collab.participants.find((p) => p.role === "host")?.name ?? t("ai.collab.host");
  let g: GuestTab | null = null;
  const tabId = remoteTerminal(t("ai.collab.shell.tabTitle", { name: host }), (d) => g?.pump.push(d), {
    hostShell: true,
    onResize: () => {
      const cur = g;
      if (!cur) return;
      clearTimeout(cur.resizeTimer);
      cur.resizeTimer = window.setTimeout(() => {
        const z = terminalSize(cur.tabId);
        if (z && open.has(cur.id) && validTermSize(z.cols, z.rows)) void call("shell.resize", { id: cur.id, ...z });
      }, 120);
    },
    onClose: () => {
      if (!g || !open.delete(g.id)) return;
      g.pump.clear();
      clearTimeout(g.resizeTimer);
      void call("shell.close", { id: g.id });
    },
  });
  const size = terminalSize(tabId) ?? { cols: 80, rows: 24 };
  opening++;
  const r = await call("shell.open", size);
  opening--;
  const data = r.ok ? early.get(r.value.id) : undefined;
  if (!opening) early.clear();
  const tabOpen = terms.tabs.some((x) => x.id === tabId);
  if (!r.ok) {
    if (tabOpen) closeTerminal(tabId);
    const code = r.error.code;
    return ui.toast(code === "shell_limit" ? t("ai.collab.shell.limit") : code === "no_folder" ? t("ai.collab.shell.noFolder") : rpcErrorText(code), "error");
  }
  const id = r.value.id;
  if (!tabOpen || collab.role !== "guest") return void call("shell.close", { id });
  const entry: GuestTab = {
    id,
    tabId,
    decoder: new TextDecoder(),
    resizeTimer: 0,
    pump: new InputPump(
      async (chunk) => {
        const w = await call("shell.input", { id, data: chunk });
        if (w.ok) return true;
        if (w.error.code === "input_busy") ui.toast(t("ai.collab.inputBusy"));
        return false;
      },
      () => ui.toast(t("ai.collab.inputBusy")),
    ),
  };
  g = entry;
  open.set(id, entry);
  for (const msg of data ?? []) showData(entry, msg);
  const now = terminalSize(tabId);
  if (now && (now.cols !== size.cols || now.rows !== size.rows) && validTermSize(now.cols, now.rows)) void call("shell.resize", { id, ...now });
}
guestGuard.openHostShell = () => void openHostShell();

onCollabMessage((peer, msg) => {
  if (collab.role !== "guest" || peer !== collab.hostPeer || typeof msg.id !== "string") return;
  if (msg.t === "shell.data" && Array.isArray(msg.chunks) && msg.chunks.every((c: unknown) => typeof c === "string")) {
    const g = open.get(msg.id);
    if (g) return showData(g, msg);
    if (!opening) return;
    const list = early.get(msg.id) ?? [];
    if (list.length < 64) early.set(msg.id, [...list, msg]);
  } else if (msg.t === "shell.exit") {
    const g = open.get(msg.id);
    if (g) shellEnded(g);
  }
});

onCapabilitiesChanged((before, now) => {
  if (before.includes("terminal") && !now.includes("terminal")) for (const g of [...open.values()]) shellEnded(g);
});

sessionEndHooks.push((wasGuest) => {
  for (const s of [...shells.values()]) endShell(s);
  if (!wasGuest) return;
  const tabs = [...open.values()].map((g) => g.tabId);
  for (const g of open.values()) {
    g.pump.clear();
    clearTimeout(g.resizeTimer);
  }
  open.clear();
  early.clear();
  for (const id of tabs) if (terms.tabs.some((x) => x.id === id)) closeTerminal(id);
});

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
