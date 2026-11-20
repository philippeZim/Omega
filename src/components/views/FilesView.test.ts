// #40: the Files header cuts off long project names, so it must show the full path on hover.
import { afterEach, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

const app = { root: "/home/u/omega-qa-markdown-handling-0kw6", treeVersion: 0 };
vi.mock("../../lib/state.svelte", () => ({ app, openFolder: vi.fn(), setRoot: vi.fn(), createEntry: vi.fn() }));
vi.mock("../TreeNode.svelte", () => ({ default: () => {} }));
vi.mock("../RemoteTree.svelte", () => ({ default: () => {} }));
vi.mock("../../lib/collab/collab.svelte", () => ({ collab: { role: null, status: "idle" } }));
vi.mock("../../lib/collab/share.svelte", () => ({ share: { hostRoot: "" } }));

const { default: FilesView } = await import("./FilesView.svelte");

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
});

test("header shows the folder name and the full path as tooltip (#40)", () => {
  cmp = mount(FilesView, { target: document.body });
  flushSync();
  const label = document.querySelector<HTMLElement>(".files .head .label")!;
  expect(label.textContent).toBe("omega-qa-markdown-handling-0kw6");
  expect(label.title).toBe("/home/u/omega-qa-markdown-handling-0kw6");
});
