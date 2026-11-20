// #39: keyboard navigation in the file tree.
import { afterEach, describe, expect, test } from "vitest";
import { focusTreeRow, treeKeyAction } from "./treeNav";

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

describe("treeKeyAction", () => {
  test("arrows, Home/End, F2 and Delete", () => {
    const file = { isDir: false, open: false };
    expect(treeKeyAction(key("ArrowDown"), file)).toBe("next");
    expect(treeKeyAction(key("ArrowUp"), file)).toBe("prev");
    expect(treeKeyAction(key("Home"), file)).toBe("first");
    expect(treeKeyAction(key("End"), file)).toBe("last");
    expect(treeKeyAction(key("F2"), file)).toBe("rename");
    expect(treeKeyAction(key("Delete"), file)).toBe("delete");
    expect(treeKeyAction(key("ArrowRight"), file)).toBeNull();
    expect(treeKeyAction(key("ArrowLeft"), file)).toBe("parent");
  });
  test("right/left expand and collapse folders", () => {
    expect(treeKeyAction(key("ArrowRight"), { isDir: true, open: false })).toBe("expand");
    expect(treeKeyAction(key("ArrowRight"), { isDir: true, open: true })).toBe("next");
    expect(treeKeyAction(key("ArrowLeft"), { isDir: true, open: true })).toBe("collapse");
    expect(treeKeyAction(key("ArrowLeft"), { isDir: true, open: false })).toBe("parent");
  });
  test("modifiers and other keys are left alone", () => {
    expect(treeKeyAction(key("Delete", { shiftKey: true }), { isDir: false, open: false })).toBeNull();
    expect(treeKeyAction(key("ArrowDown", { ctrlKey: true }), { isDir: false, open: false })).toBeNull();
    expect(treeKeyAction(key("a"), { isDir: false, open: false })).toBeNull();
  });
});

describe("focusTreeRow", () => {
  afterEach(() => (document.body.innerHTML = ""));
  const setup = () => {
    document.body.innerHTML = `<div role="tree">
      <button role="treeitem" aria-level="1" id="src">src</button>
      <button role="treeitem" aria-level="2" id="lib">lib</button>
      <button role="treeitem" aria-level="3" id="a">a.ts</button>
      <button role="treeitem" aria-level="2" id="main">main.ts</button>
      <button role="treeitem" aria-level="1" id="readme">README</button>
    </div>`;
    return (id: string) => document.getElementById(id)!;
  };
  test("next, prev, first, last", () => {
    const el = setup();
    focusTreeRow(el("lib"), "next");
    expect(document.activeElement?.id).toBe("a");
    focusTreeRow(el("lib"), "prev");
    expect(document.activeElement?.id).toBe("src");
    focusTreeRow(el("a"), "last");
    expect(document.activeElement?.id).toBe("readme");
    focusTreeRow(el("a"), "first");
    expect(document.activeElement?.id).toBe("src");
  });
  test("parent is the nearest row above with a lower level; no move past the ends", () => {
    const el = setup();
    focusTreeRow(el("main"), "parent");
    expect(document.activeElement?.id).toBe("src");
    focusTreeRow(el("a"), "parent");
    expect(document.activeElement?.id).toBe("lib");
    el("readme").focus();
    focusTreeRow(el("readme"), "next");
    expect(document.activeElement?.id).toBe("readme");
    focusTreeRow(el("src"), "parent");
    expect(document.activeElement?.id).toBe("readme");
  });
});
