import { describe, expect, test } from "vitest";
import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { lineDiff } from "./lineDiff";

/** Applies the changes to `a`; must give `b`, and the changes must be ordered and disjoint. */
function apply(a: string, b: string) {
  let out = "", pos = 0, posB = 0;
  for (const c of lineDiff(a, b)) {
    expect(c.fromA).toBeGreaterThanOrEqual(pos);
    expect(c.fromA - pos).toBe(c.fromB - posB); // unchanged runs line up
    out += a.slice(pos, c.fromA) + b.slice(c.fromB, c.toB);
    pos = c.toA;
    posB = c.toB;
  }
  return out + a.slice(pos);
}

describe("lineDiff (#74)", () => {
  test("edge cases turn a into b", () => {
    const cases: [string, string][] = [
      ["", ""], ["", "x"], ["x", ""], ["x", "x\ny"], ["x\ny", "x"], ["x\n", "x"], ["x", "x\n"],
      ["a\nb\nc", "a\nB\nc"], ["a\nb\nc\n", "z\na\nb\nc\n"], ["a\nb", "b\na"], ["\n\n", "\n"], ["a\n\nb", "a\nb\n"],
    ];
    for (const [a, b] of cases) expect(apply(a, b), JSON.stringify([a, b])).toBe(b);
  });

  test("random edits turn a into b", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const words = ["foo", "bar", "", "baz", "qux quux"];
    for (let i = 0; i < 300; i++) {
      const a = Array.from({ length: rnd(12) }, () => words[rnd(words.length)]);
      const b = a.flatMap((l) => (rnd(4) === 0 ? [] : rnd(4) === 0 ? [l + "!", words[rnd(words.length)]] : [l]));
      if (rnd(3) === 0) b.push(words[rnd(words.length)]);
      const [sa, sb] = [a.join("\n") + (rnd(2) ? "\n" : ""), b.join("\n") + (rnd(2) ? "\n" : "")];
      expect(apply(sa, sb), JSON.stringify([sa, sb])).toBe(sb);
    }
  });

  test("scattered changes in 5000 lines: one small chunk each", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const a = Text.of(lines);
    const b = Text.of(lines.map((l, i) => ((i + 1) % 7 === 0 ? l + " CHANGED" : l)));
    const chunks = Chunk.build(a, b, { override: lineDiff });
    expect(chunks.length).toBe(714);
    // Only the appended text is marked inside the changed line.
    expect(chunks[0].changes).toHaveLength(1);
    expect(b.sliceString(chunks[0].fromB + chunks[0].changes[0].fromB, chunks[0].fromB + chunks[0].changes[0].toB)).toBe(" CHANGED");
  });
});
