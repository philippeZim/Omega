import { describe, expect, test } from "vitest";
import { groupOrder, initialGroups, neighbour, nextActive, parseLayout, removeFrom, saveLayout, splitAt, type LayoutNode } from "./editorGroups";

describe("editor group layout (#219)", () => {
  test("splitting next to a group in the same direction shares its space", () => {
    let root: LayoutNode = { group: "a" };
    root = splitAt(root, "a", "right", "b");
    expect(root).toEqual({ dir: "row", children: [{ group: "a" }, { group: "b" }], sizes: [0.5, 0.5] });
    root = splitAt(root, "b", "right", "c");
    expect(root).toEqual({ dir: "row", children: [{ group: "a" }, { group: "b" }, { group: "c" }], sizes: [0.5, 0.25, 0.25] });
  });

  test("splitting across nests, left/up go before", () => {
    let root: LayoutNode = splitAt({ group: "a" }, "a", "right", "b");
    root = splitAt(root, "b", "up", "c");
    expect(root).toEqual({ dir: "row", children: [{ group: "a" }, { dir: "col", children: [{ group: "c" }, { group: "b" }], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] });
    expect(groupOrder(root)).toEqual(["a", "c", "b"]);
  });

  test("removing collapses splits and merges same-direction ones", () => {
    let root: LayoutNode = splitAt({ group: "a" }, "a", "right", "b");
    root = splitAt(root, "b", "down", "c");
    root = splitAt(root, "c", "right", "d");
    // a | (b / (c | d)) → remove b → a | c | d (one row)
    root = removeFrom(root, "b");
    expect(groupOrder(root)).toEqual(["a", "c", "d"]);
    expect("dir" in root && root.dir).toBe("row");
    expect("dir" in root && root.sizes.reduce((x, y) => x + y)).toBeCloseTo(1);
    expect(removeFrom(removeFrom(root, "c"), "d")).toEqual({ group: "a" });
  });

  test("the neighbour and the next tab after closing", () => {
    const root = splitAt(splitAt({ group: "a" }, "a", "right", "b"), "b", "right", "c");
    expect(neighbour(root, "a")).toBe("b");
    expect(neighbour(root, "c")).toBe("b");
    expect(neighbour({ group: "a" }, "a")).toBe(null);
    expect(nextActive(["x", "y", "z"], "y")).toBe("z");
    expect(nextActive(["x", "y", "z"], "z")).toBe("y");
    expect(nextActive(["x"], "x")).toBe(null);
  });

  test("a saved layout round-trips by file; one group saves nothing", () => {
    const g = initialGroups();
    expect(saveLayout(g, () => "/f")).toBe(null);
    g.groups.main = { id: "main", tabs: ["1", "2"], active: "2", modes: { "1": "code", "2": "markdown" } };
    g.groups.b = { id: "b", tabs: ["2", "3"], active: "3", modes: { "2": "code" } };
    g.root = splitAt(g.root, "main", "right", "b");
    g.focused = "b";
    const files: Record<string, string | null> = { "1": "/p/a.py", "2": "/p/n.md", "3": null };
    const saved = saveLayout(g, (id) => files[id])!;
    expect(saved).toEqual({
      root: { dir: "row", children: [{ group: 0 }, { group: 1 }], sizes: [0.5, 0.5] },
      groups: [
        { files: ["/p/a.py", "/p/n.md"], active: "/p/n.md", modes: { "/p/a.py": "code", "/p/n.md": "markdown" } },
        { files: ["/p/n.md"], active: null, modes: { "/p/n.md": "code" } },
      ],
      focused: 1,
    });
    expect(parseLayout(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  test("a damaged saved layout is dropped", () => {
    const groups = [{ files: [], active: null, modes: {} }, { files: [], active: null, modes: {} }];
    expect(parseLayout(null)).toBe(null);
    expect(parseLayout({ groups, root: { dir: "row", children: [{ group: 0 }, { group: 0 }], sizes: [1, 1] } })).toBe(null);
    expect(parseLayout({ groups, root: { dir: "row", children: [{ group: 0 }, { group: 5 }] } })).toBe(null);
    expect(parseLayout({ groups, root: { dir: "diagonal", children: [{ group: 0 }, { group: 1 }] } })).toBe(null);
    // Bad sizes and modes are repaired, not fatal.
    const ok = parseLayout({ groups: [{ files: ["/a"], active: "/a", modes: { "/a": "bogus" } }, groups[1]], root: { dir: "col", children: [{ group: 0 }, { group: 1 }], sizes: [-1, 2] } });
    expect(ok?.root).toEqual({ dir: "col", children: [{ group: 0 }, { group: 1 }], sizes: [0.5, 0.5] });
    expect(ok?.groups[0].modes).toEqual({});
  });
});
