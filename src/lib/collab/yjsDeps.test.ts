import { expect, test } from "vitest";
import * as Y from "yjs";
import { checkUpdate } from "./yjsDeps";

function doc(client: number, from?: Y.Doc) {
  const d = new Y.Doc();
  d.clientID = client;
  if (from) Y.applyUpdate(d, Y.encodeStateAsUpdate(from));
  return d;
}
const text = (d: Y.Doc) => d.getText("content");
/** Runs `edit` on `d` and returns the update it produced. */
function updateOf(d: Y.Doc, edit: () => void) {
  let out: Uint8Array | null = null;
  const on = (u: Uint8Array) => (out = u);
  d.on("update", on);
  edit();
  d.off("update", on);
  return out!;
}
const noPending = (d: Y.Doc) => d.store.pendingStructs === null && d.store.pendingDs === null;

test("the reviewer's case: an update resting on another guest's next edit is not ready", () => {
  const host = doc(1);
  text(host).insert(0, "abc");
  const b = doc(2, host);
  const a = doc(3, host);
  const bNext = updateOf(b, () => text(b).insert(3, "X"));
  Y.applyUpdate(a, bNext);
  const evil = updateOf(a, () => text(a).insert(4, "EVIL"));
  expect(checkUpdate(host, evil).ready).toBe(false);
  // Once B's edit is in, the same update is fine.
  Y.applyUpdate(host, bNext);
  expect(checkUpdate(host, evil).ready).toBe(true);
  Y.applyUpdate(host, evil);
  expect(noPending(host)).toBe(true);
  expect(text(host).toString()).toBe("abcXEVIL");
});

test("a gap in the sender's own history is not ready", () => {
  const host = doc(1);
  const a = doc(3, host);
  const first = updateOf(a, () => text(a).insert(0, "a"));
  const second = updateOf(a, () => text(a).insert(1, "b"));
  expect(checkUpdate(host, second).ready).toBe(false);
  Y.applyUpdate(host, first);
  expect(checkUpdate(host, second).ready).toBe(true);
});

test("deleting what the host doesn't have yet is not ready", () => {
  const host = doc(1);
  text(host).insert(0, "abc");
  const b = doc(2, host);
  const a = doc(3, host);
  const bNext = updateOf(b, () => text(b).insert(0, "XY"));
  Y.applyUpdate(a, bNext);
  const del = updateOf(a, () => text(a).delete(0, 1)); // a delete set only, on B's unseen item
  expect(checkUpdate(host, del).ready).toBe(false);
  Y.applyUpdate(host, bNext);
  expect(checkUpdate(host, del).ready).toBe(true);
  Y.applyUpdate(host, del);
  expect(noPending(host)).toBe(true);
  expect(text(host).toString()).toBe("Yabc");
});

test("a dependency inside the same update counts, in any client order", () => {
  const host = doc(1);
  const b = doc(2);
  const a = doc(3);
  text(b).insert(0, "b");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  text(a).insert(1, "a");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  text(b).insert(2, "c");
  const merged = Y.encodeStateAsUpdate(b);
  expect(checkUpdate(host, merged).ready).toBe(true);
  Y.applyUpdate(host, merged);
  expect(noPending(host)).toBe(true);
  expect(text(host).toString()).toBe("bac");
});

test("an update naming a later clock of its own client, or garbage, is not ready", () => {
  const host = doc(1);
  expect(checkUpdate(host, new Uint8Array([255, 255, 1, 2, 3])).ready).toBe(false);
  const a = doc(3);
  const u = updateOf(a, () => text(a).insert(0, "ab"));
  expect(checkUpdate(host, u)).toEqual({ ready: true, missing: [] });
  const next = updateOf(a, () => text(a).insert(2, "c"));
  expect(checkUpdate(host, next)).toEqual({ ready: false, missing: [3] });
});

test("an update the host already has is ready and changes nothing", () => {
  const host = doc(1);
  const a = doc(3);
  const u = updateOf(a, () => text(a).insert(0, "ab"));
  Y.applyUpdate(host, u);
  expect(checkUpdate(host, u).ready).toBe(true);
});

test("random concurrent edits relayed through a host are never refused and converge", () => {
  let seed = 12345;
  const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
  const host = doc(1);
  text(host).insert(0, "shared text");
  const guests = [doc(2, host), doc(3, host), doc(4, host)];
  // What each guest still has to send to the host, and to receive from it, in order.
  const up = guests.map(() => [] as Uint8Array[]);
  const down = guests.map(() => [] as Uint8Array[]);
  guests.forEach((g, i) => g.on("update", (u: Uint8Array, origin: unknown) => origin !== "relay" && up[i].push(u)));
  for (let step = 0; step < 3000; step++) {
    const i = rnd(guests.length);
    const g = guests[i];
    const action = rnd(4);
    if (action === 0) {
      const t = text(g);
      if (t.length && rnd(3) === 0) t.delete(rnd(t.length), 1);
      else t.insert(rnd(t.length + 1), "xyz"[rnd(3)]);
    } else if (action === 1 && up[i].length) {
      const u = up[i].shift()!;
      expect(checkUpdate(host, u).ready).toBe(true);
      Y.applyUpdate(host, u, "g");
      expect(noPending(host)).toBe(true);
      down.forEach((q, k) => k !== i && q.push(u));
    } else if (down[i].length) {
      Y.applyUpdate(g, down[i].shift()!, "relay");
    }
  }
  guests.forEach((g, i) => {
    for (const u of up[i].splice(0)) {
      expect(checkUpdate(host, u).ready).toBe(true);
      Y.applyUpdate(host, u, "g");
      down.forEach((q, k) => k !== i && q.push(u));
    }
  });
  guests.forEach((g, i) => down[i].splice(0).forEach((u) => Y.applyUpdate(g, u, "relay")));
  for (const g of guests) expect(text(g).toString()).toBe(text(host).toString());
});
