import { Change, diff } from "@codemirror/merge";

/**
 * Line-first diff for the side-by-side view (#74). @codemirror/merge diffs characters; with many
 * scattered changes a full scan is slow (seconds for 5000 lines), and its default scanLimit gives up
 * and reports the whole file as one block. Here every distinct line becomes one character, those
 * strings are diffed (cheap: one step per line), and only the changed line ranges are diffed again
 * character by character for the inline highlights.
 */
export function lineDiff(a: string, b: string): readonly Change[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const ids = new Map<string, string>();
  let next = 0x100;
  const token = (line: string) => {
    let c = ids.get(line);
    if (c === undefined) {
      if (next === 0xd800) next = 0xe000; // skip surrogates: one line = one UTF-16 code unit
      c = String.fromCharCode(next++);
      ids.set(line, c);
    }
    return c;
  };
  const ta = la.map(token).join("");
  const tb = lb.map(token).join("");
  // More distinct lines than code units: fall back to the plain character diff.
  if (next > 0xffff) return diff(a, b, { scanLimit: 5000 });

  const offsets = (lines: string[]) => {
    const o = [0];
    for (const l of lines) o.push(o[o.length - 1] + l.length + 1);
    return o;
  };
  const oa = offsets(la);
  const ob = offsets(lb);
  const out: Change[] = [];
  for (const ch of diff(ta, tb, { scanLimit: 1e9 })) {
    let fromA = oa[ch.fromA], fromB = ob[ch.fromB], toA = oa[ch.toA], toB = ob[ch.toB];
    // A hunk that reaches the end (on one side it does, on both: what follows is common) has no
    // "\n" after its last line; take the "\n" before it instead, so the unchanged text matches.
    if (ch.toA === la.length) {
      toA = a.length;
      toB = b.length;
      if (ch.fromA > 0) {
        fromA--;
        fromB--;
      }
    }
    for (const c of diff(a.slice(fromA, toA), b.slice(fromB, toB), { scanLimit: 500 }))
      out.push(new Change(c.fromA + fromA, c.toA + fromA, c.fromB + fromB, c.toB + fromB));
  }
  return out;
}
