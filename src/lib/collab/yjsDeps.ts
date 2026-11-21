/**
 * Whether a Yjs update can be integrated right now. Yjs itself holds back an update whose
 * dependencies are missing (`store.pendingStructs`, `pendingDs`) and integrates it later, inside
 * whichever transaction brings them: the change would then count as someone else's. So the host
 * asks before applying anything from a guest.
 */
import * as Y from "yjs";

export interface UpdateCheck {
  ready: boolean;
  /** Clients whose history it's missing: structs that can't go in, deletions of unknown items. */
  missing: number[];
}

type Dep = { client: number; clock: number } | null | undefined;

export function checkUpdate(doc: Y.Doc, update: Uint8Array): UpdateCheck {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return { ready: false, missing: [] };
  }
  const queues = new Map<number, (typeof decoded.structs)[number][]>();
  for (const s of decoded.structs) {
    const q = queues.get(s.id.client);
    if (q) q.push(s);
    else queues.set(s.id.client, [s]);
  }
  for (const q of queues.values()) q.sort((a, b) => a.id.clock - b.id.clock);

  // What the doc would know as the update's structs go in, in any order that works.
  const state = new Map<number, number>();
  const known = (client: number) => state.get(client) ?? Y.getState(doc.store, client);
  const has = (dep: Dep, self: { client: number; clock: number }) => {
    if (!dep) return true;
    // A struct can only build on what came before it in its own client's history.
    return dep.client === self.client ? dep.clock < self.clock : dep.clock < known(dep.client);
  };
  for (let progress = true; progress; ) {
    progress = false;
    for (const [client, q] of queues) {
      while (q.length) {
        const s = q[0];
        const end = s.id.clock + s.length;
        if (s instanceof Y.Skip || end <= known(client)) {
          q.shift(); // a gap in the update, or nothing new: a real gap shows at the next struct
          progress = true;
          continue;
        }
        if (s.id.clock > known(client)) break;
        if (s instanceof Y.Item) {
          const parent = s.parent instanceof Y.ID ? s.parent : null;
          if (!has(s.origin, s.id) || !has(s.rightOrigin, s.id) || !has(parent, s.id)) break;
        }
        state.set(client, end);
        q.shift();
        progress = true;
      }
    }
  }
  const missing = new Set([...queues].filter(([, q]) => q.length).map(([client]) => client));
  // A deletion of something the doc doesn't have yet would be held back the same way.
  for (const [client, items] of decoded.ds.clients) {
    if (items.some((item) => item.clock + item.len > known(client))) missing.add(client);
  }
  return { ready: missing.size === 0, missing: [...missing] };
}
