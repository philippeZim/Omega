import { expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

vi.mock("../lib/debug/debugger.svelte", () => ({ toggleNode: () => {}, setVariable: () => {}, addWatch: () => {} }));

import VarTree from "./VarTree.svelte";
import type { VarNode } from "../lib/debug/store.svelte";

const node = (name: string, value: string, ref = 0): VarNode => ({ name, value, ref, parentRef: 1, children: null, expanded: false });

test("variables without a value show no dangling '=' (#106)", () => {
  const target = document.createElement("div");
  const c = mount(VarTree, { target, props: { nodes: [node("special variables", "", 5), node("total", "0")], depth: 1 } });
  const rows = target.querySelectorAll(".row");
  expect(rows[0].querySelector(".eq")).toBeNull();
  expect(rows[0].textContent!.trim()).toBe("special variables");
  expect(rows[1].querySelector(".eq")?.textContent).toBe("=");
  expect(rows[1].querySelector(".value")?.textContent).toBe("0");
  unmount(c);
});
