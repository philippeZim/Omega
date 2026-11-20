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

  test("a consecutive exact match ranks above a scattered word-start match", () => {
    expect(fuzzy("test", "test.ts")!.score).toBeGreaterThan(fuzzy("test", "t_e_s_t.ts")!.score);
    expect(fuzzy("testing", "testing.ts")!.score).toBeGreaterThan(fuzzy("testing", "t_e_s_t_i_n_g.ts")!.score);
  });

  test("a prefix of the file name ranks above a match scattered over word starts", () => {
    expect(fuzzy("lay", "src/lib/layout.svelte.ts")!.score).toBeGreaterThan(fuzzy("lay", "src/l_a_y.ts")!.score);
  });

  test("command labels: a contiguous prefix ranks above word starts spread over the label", () => {
    expect(fuzzy("save", "Save All")!.score).toBeGreaterThan(fuzzy("save", "Show All Version Entries")!.score);
  });

  test("camelCase humps still match and rank above a plain scattered match", () => {
    const m = fuzzy("qo", "QuickOpen.svelte")!;
    expect(m.positions).toEqual([0, 5]);
    expect(m.score).toBeGreaterThan(fuzzy("qo", "quota.ts")!.score);
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
