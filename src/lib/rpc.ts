/** Shared event bus for JSON-RPC child processes/connections (LSP + DAP) managed by proc.rs. */
import { listen } from "./windowEvents";

type Fn<T> = (v: T) => void;
const messages = new Map<string, Fn<any>>();
const exits = new Map<string, Fn<void>>();
const stderrs = new Map<string, Fn<string>>();

listen<{ id: string; msg: string }>("proc-msg", (e) => {
  const h = messages.get(e.payload.id);
  if (!h) return;
  try {
    h(JSON.parse(e.payload.msg));
  } catch (err) {
    console.error("rpc parse", err);
  }
});
listen<string>("proc-exit", (e) => exits.get(e.payload)?.());
listen<{ id: string; msg: string }>("proc-stderr", (e) => stderrs.get(e.payload.id)?.(e.payload.msg));

export function onRpc(id: string, h: { message?: Fn<any>; exit?: Fn<void>; stderr?: Fn<string> }) {
  if (h.message) messages.set(id, h.message);
  if (h.exit) exits.set(id, h.exit);
  if (h.stderr) stderrs.set(id, h.stderr);
  return () => {
    messages.delete(id);
    exits.delete(id);
    stderrs.delete(id);
  };
}
