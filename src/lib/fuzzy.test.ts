import { describe, expect, test } from "vitest";
import { fuzzy, highlight } from "./fuzzy";

describe("fuzzy", () => {
  test("empty query matches everything with score 0", () => {
    expect(fuzzy("", "anything")).toEqual({ score: 0, positions: [] });
  });

  test("characters must appear in order", () => {
    expect(fuzzy("abc", "a_b_c")).not.toBeNull();
    expect(fuzzy("cba", "abc")).toBeNull();
    expect(fuzzy("xyz", "abc")).toBeNull();
  });

  test("case-insensitive, spaces ignored", () => {
    const m = fuzzy("M S", "src/MainScreen.ts")!;
    expect(m.positions.map((i) => "src/MainScreen.ts"[i])).toEqual(["M", "S"]);
  });

  test("prefers word starts (camelCase humps, separators)", () => {
    const m = fuzzy("ms", "src/MainScreen.ts")!;
    expect(m.positions).toEqual([4, 8]);
  });

  test("file name matches rank above directory matches", () => {
    const inName = fuzzy("app", "src/lib/app.ts")!;
    const inDir = fuzzy("app", "app/lib/index.ts")!;
    expect(inName.score).toBeGreaterThan(inDir.score);
  });

  // bug: the word-start bonus (+8 per char) outweighs the run bonus (+5), so "t_e_s_t.ts" (51.5) beats the exact "test.ts" (42.65).
  test.fails("a consecutive exact match ranks above a scattered word-start match", () => {
    expect(fuzzy("test", "test.ts")!.score).toBeGreaterThan(fuzzy("test", "t_e_s_t.ts")!.score);
  });

  test("shorter candidates rank higher for the same match", () => {
    expect(fuzzy("main", "main.rs")!.score).toBeGreaterThan(fuzzy("main", "main_long_suffix.rs")!.score);
  });

  test("positions point at matching characters", () => {
    const text = "packages/editor/src/state.ts";
    const m = fuzzy("edst", text)!;
    expect(m.positions.map((i) => text[i]).join("")).toBe("edst");
    expect([...m.positions].sort((a, b) => a - b)).toEqual(m.positions);
  });
});

describe("highlight", () => {
  test("splits into plain and matched segments", () => {
    expect(highlight("abcde", [0, 1, 3])).toEqual([
      { t: "ab", m: true },
      { t: "c", m: false },
      { t: "d", m: true },
      { t: "e", m: false },
    ]);
  });
  test("no positions → one plain segment; empty text → []", () => {
    expect(highlight("abc", [])).toEqual([{ t: "abc", m: false }]);
    expect(highlight("", [])).toEqual([]);
  });
});
