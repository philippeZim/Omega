/**
 * "Zusammen coden": session state and protocol on top of the iroh pipe (collab.rs).
 * Host = the person whose project is shared; guests join with an invite code and need approval.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ui } from "../ui.svelte";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export const PEER_COLORS = ["#6b9be0", "#7bbf8e", "#d6a35f", "#cf8fb4", "#86b9cc", "#a996cf", "#df7067", "#c8b77e"];

export interface Participant {
  peer: string; // transport id ("self" for me)
  name: string;
  color: string;
  role: "host" | "guest";
  /** Connection quality (host↔guest), refreshed periodically. */
  direct?: boolean;
  rtt?: number;
  addr?: string;
}

export interface JoinRequest {
  peer: string;
  name: string;
}

export const collab = $state({
  role: null as null | "host" | "guest",
  status: "idle" as "idle" | "starting" | "hosting" | "joining" | "waiting" | "connected" | "error",
  ticket: "",
  error: "",
  me: { name: localStorage.getItem("collab.name") || "", color: localStorage.getItem("collab.color") || PEER_COLORS[0] },
  participants: [] as Participant[],
  requests: [] as JoinRequest[],
  hostPeer: null as string | null,
  open: false,
});

type Msg = { t: string; [k: string]: any };
const handlers = new Set<(peer: string, msg: Msg) => void>();
/** Lets later layers (document sync, cursors, file tree) hook into the message stream. */
export function onCollabMessage(fn: (peer: string, msg: Msg) => void) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export function send(peer: string, msg: Msg) {
  return invoke("collab_send", { peer, msg: JSON.stringify(msg) }).catch(() => {});
}
/** Host: send to every approved guest (optionally except one). */
export function broadcast(msg: Msg, except?: string) {
  for (const p of collab.participants) if (p.role === "guest" && p.peer !== "self" && p.peer !== except) send(p.peer, msg);
}

async function defaultName() {
  if (collab.me.name) return;
  try {
    const r = await invoke<{ code: number; stdout: string }>("git", { root: "/", args: ["config", "--global", "user.name"] });
    collab.me.name = r.stdout.trim() || "Ich";
  } catch {
    collab.me.name = "Ich";
  }
}

// Show the git name right away in the panel.
defaultName();

export function setMyName(name: string) {
  collab.me.name = name.trim() || collab.me.name;
  localStorage.setItem("collab.name", collab.me.name);
}

// ------------------------------------------------------------------ host

export async function startHosting() {
  await defaultName();
  collab.role = "host";
  collab.status = "starting";
  collab.error = "";
  try {
    collab.ticket = await invoke<string>("collab_host");
    collab.status = "hosting";
    // Like PyCharm: the invite is ready to paste right away.
    writeText(collab.ticket).then(() => ui.toast("Einladungscode kopiert – einfach im Chat einfügen")).catch(() => {});
    collab.participants = [{ peer: "self", name: collab.me.name, color: collab.me.color, role: "host" }];
  } catch (e) {
    collab.status = "error";
    collab.error = String(e);
  }
}

function nextColor() {
  const used = new Set(collab.participants.map((p) => p.color));
  return PEER_COLORS.find((c) => !used.has(c)) ?? PEER_COLORS[collab.participants.length % PEER_COLORS.length];
}

export function approve(req: JoinRequest) {
  collab.requests = collab.requests.filter((r) => r.peer !== req.peer);
  const p: Participant = { peer: req.peer, name: req.name, color: nextColor(), role: "guest" };
  collab.participants.push(p);
  send(req.peer, { t: "welcome", you: { name: p.name, color: p.color }, participants: collab.participants.map(publicInfo) });
  broadcast({ t: "participants", participants: collab.participants.map(publicInfo) });
  ui.toast(`${req.name} ist beigetreten`);
}

/** Approves the oldest pending request (command palette). */
export function approveNext() {
  if (collab.requests[0]) approve(collab.requests[0]);
}

/** Reads an invite code from the clipboard, if there is one. */
export async function clipboardTicket(): Promise<string | null> {
  try {
    const t = (await readText())?.trim() ?? "";
    return t.startsWith("studio-") ? t : null;
  } catch {
    return null;
  }
}

/** Joins with the code from the clipboard (command palette). */
export async function joinFromClipboard() {
  const t = await clipboardTicket();
  if (!t) return ui.toast("Kein Einladungscode in der Zwischenablage", "error");
  collab.open = true;
  await join(t);
}

export function deny(req: JoinRequest) {
  collab.requests = collab.requests.filter((r) => r.peer !== req.peer);
  send(req.peer, { t: "denied" }).then(() => setTimeout(() => invoke("collab_kick", { peer: req.peer }), 300));
}

export function kick(peer: string) {
  send(peer, { t: "kicked" });
  setTimeout(() => invoke("collab_kick", { peer }), 200);
}

const publicInfo = (p: Participant) => ({ peer: p.peer === "self" ? "host" : p.peer, name: p.name, color: p.color, role: p.role });

// ------------------------------------------------------------------ guest

export async function join(ticket: string) {
  await defaultName();
  collab.role = "guest";
  collab.status = "joining";
  collab.error = "";
  try {
    const host = await invoke<string>("collab_join", { ticket });
    collab.hostPeer = host;
    collab.status = "waiting";
    await send(host, { t: "hello", name: collab.me.name, version: 1 });
  } catch (e) {
    collab.status = "error";
    collab.error = String(e);
    collab.role = null;
  }
}

// ------------------------------------------------------------------ leave / stop

let leaving = false;
export async function leave() {
  if (leaving) return;
  leaving = true;
  if (collab.role === "host") broadcast({ t: "ended" });
  // Mark as idle first so the connection-closed events of our own leave don't show an error.
  collab.status = "idle";
  await invoke("collab_stop");
  const { teardownShare } = await import("./share.svelte");
  await teardownShare();
  Object.assign(collab, { role: null, status: "idle", ticket: "", participants: [], requests: [], hostPeer: null, error: "" });
  leaving = false;
}

// ------------------------------------------------------------------ transport events

listen<{ peer: string; msg: string }>("collab-msg", (e) => {
  let msg: Msg;
  try {
    msg = JSON.parse(e.payload.msg);
  } catch {
    return;
  }
  const peer = e.payload.peer;

  if (collab.role === "host") {
    if (msg.t === "hello") {
      // Unknown peers must be approved first (the code alone is not enough).
      if (!collab.requests.some((r) => r.peer === peer) && !collab.participants.some((p) => p.peer === peer))
        collab.requests.push({ peer, name: String(msg.name || "Gast").slice(0, 40) });
      collab.open = true;
      return;
    }
    // Ignore everything from guests that weren't approved.
    if (!collab.participants.some((p) => p.peer === peer)) return;
  } else if (collab.role === "guest") {
    if (msg.t === "welcome") {
      collab.status = "connected";
      collab.me.color = msg.you.color;
      collab.participants = msg.participants;
      ui.toast("Verbunden – du bist in der Session");
    } else if (msg.t === "participants") collab.participants = msg.participants;
    else if (msg.t === "denied") {
      ui.toast("Der Host hat den Beitritt abgelehnt", "error");
      leave();
      return;
    } else if (msg.t === "kicked" || msg.t === "ended") {
      ui.toast(msg.t === "kicked" ? "Du wurdest aus der Session entfernt" : "Der Host hat die Session beendet");
      leave();
      return;
    }
  }
  for (const h of handlers) h(peer, msg);
});

listen<{ peer: string; reason: string }>("collab-closed", (e) => {
  const peer = e.payload.peer;
  if (collab.role === "host") {
    const p = collab.participants.find((x) => x.peer === peer);
    collab.participants = collab.participants.filter((x) => x.peer !== peer);
    collab.requests = collab.requests.filter((x) => x.peer !== peer);
    if (p) {
      ui.toast(`${p.name} hat die Session verlassen`);
      broadcast({ t: "participants", participants: collab.participants.map(publicInfo) });
    }
  } else if (collab.role === "guest" && peer === collab.hostPeer && collab.status !== "idle") {
    ui.toast("Verbindung zum Host getrennt", "error");
    leave();
  }
});

// Connection quality (direct vs. relay) for the participant list.
setInterval(async () => {
  if (!collab.role) return;
  const peers = collab.role === "host" ? collab.participants.filter((p) => p.peer !== "self").map((p) => p.peer) : collab.hostPeer ? [collab.hostPeer] : [];
  for (const peer of peers) {
    const info = await invoke<{ direct: boolean; rtt_ms: number; addr: string } | null>("collab_conn_info", { peer });
    if (!info) continue;
    if (collab.role === "host") {
      const p = collab.participants.find((x) => x.peer === peer);
      if (p) Object.assign(p, { direct: info.direct, rtt: info.rtt_ms, addr: info.addr });
    } else {
      const h = collab.participants.find((x) => x.role === "host");
      if (h) Object.assign(h, { direct: info.direct, rtt: info.rtt_ms, addr: info.addr });
    }
  }
}, 2000);
