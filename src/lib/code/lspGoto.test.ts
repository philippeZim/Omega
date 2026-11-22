import { describe, expect, test, vi } from "vitest";
import { MAX_PICKS, gotoTargets, pickerItems } from "./lspGoto";

const path = (u: string) => u.replace("file://", "");
const at = (line: number, character = 0) => ({ start: { line, character }, end: { line, character: character + 1 } });

describe("gotoTargets", () => {
  test("a single Location", () => {
    expect(gotoTargets({ uri: "file:///a.c", range: at(3, 2) }, path)).toEqual([{ path: "/a.c", line: 3, character: 2 }]);
  });

  test("a LocationLink goes to the symbol, not the whole declaration", () => {
    expect(gotoTargets([{ targetUri: "file:///a.c", targetRange: at(1), targetSelectionRange: at(2, 4) }], path)).toEqual([{ path: "/a.c", line: 2, character: 4 }]);
  });

  test("nothing", () => {
    expect(gotoTargets(null, path)).toEqual([]);
    expect(gotoTargets([], path)).toEqual([]);
  });

  test("the same place twice counts once, order stays", () => {
    const res = [{ uri: "file:///b.c", range: at(1) }, { uri: "file:///a.c", range: at(1) }, { targetUri: "file:///b.c", targetSelectionRange: at(1) }];
    expect(gotoTargets(res, path).map((t) => t.path)).toEqual(["/b.c", "/a.c"]);
  });

  test("malformed entries are left out", () => {
    const res = [null, {}, { uri: 3, range: at(1) }, { uri: "file:///a.c" }, { uri: "file:///a.c", range: { start: { line: -1, character: 0 } } }, { uri: "file:///ok.c", range: at(0) }];
    expect(gotoTargets(res, path).map((t) => t.path)).toEqual(["/ok.c"]);
  });

  test("a private copy maps to its real file, also when two answers meet there", () => {
    const real = (u: string) => (u === "file:///tmp/copy/a.c" ? "/p/a.txt" : path(u));
    const res = [{ uri: "file:///tmp/copy/a.c", range: at(1) }, { uri: "file:///p/a.txt", range: at(1) }];
    expect(gotoTargets(res, real)).toEqual([{ path: "/p/a.txt", line: 1, character: 0 }]);
  });
});

describe("pickerItems", () => {
  const target = (p: string, line: number) => ({ path: p, line, character: 0 });

  test("file, 1-based line, folder and full path", () => {
    const [item] = pickerItems([target("/p/src/a.c", 4)], vi.fn(), String);
    expect(item).toMatchObject({ label: "a.c:5", shortcut: "src", title: "/p/src/a.c" });
  });

  test("choosing a row goes there", () => {
    const go = vi.fn();
    const t = target("/p/a.c", 1);
    pickerItems([target("/p/b.c", 0), t], go, String)[1].action!();
    expect(go).toHaveBeenCalledWith(t);
  });

  test("a long list is cut with a row saying how many are left", () => {
    const many = Array.from({ length: MAX_PICKS + 3 }, (_, i) => target("/p/a.c", i));
    const items = pickerItems(many, vi.fn(), (n) => `+${n}`);
    expect(items.length).toBe(MAX_PICKS + 1);
    expect(items[MAX_PICKS]).toMatchObject({ label: "+3", disabled: true });
  });
});
