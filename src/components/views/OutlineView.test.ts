import { expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

const long = "A very long section title that does not fit into the outline column";
vi.mock("../../lib/latex/controller.svelte", () => ({
  latex: { outline: [{ level: 2, title: "A very long section title that does not fit into the outline column", line: 3, pos: 10 }] },
}));
vi.mock("../../lib/editor", () => ({ getView: () => null }));
vi.mock("../../lib/state.svelte", () => ({ focusLatexGroup: () => {} }));

import OutlineView from "./OutlineView.svelte";

test("outline entries carry the full title as tooltip (#58)", () => {
  const target = document.createElement("div");
  const c = mount(OutlineView, { target });
  const item = target.querySelector<HTMLElement>(".oitem")!;
  expect(item.querySelector(".otitle")!.textContent).toBe(long);
  expect(item.closest("[title]")?.getAttribute("title")).toBe(long);
  unmount(c);
});
