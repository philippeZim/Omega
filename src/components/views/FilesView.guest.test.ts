// Guest: creating files and folders at the top level, also in an empty project.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

const h = vi.hoisted(() => ({
  share: { hostRoot: "proj", hostHasRoot: true, treeGen: 0 },
  remoteCreate: vi.fn(),
  openMenu: vi.fn(),
}));
vi.mock("../../lib/state.svelte", () => ({ app: { root: null, treeVersion: 0 }, openFolder: vi.fn(), setRoot: vi.fn(), createEntry: vi.fn() }));
vi.mock("../TreeNode.svelte", () => ({ default: () => {} }));
vi.mock("../RemoteTree.svelte", () => ({ default: () => {} }));
vi.mock("../../lib/collab/collab.svelte", () => ({ collab: { role: "guest", status: "connected" } }));
vi.mock("../../lib/collab/share.svelte", () => ({ share: h.share, remoteCreate: h.remoteCreate }));
vi.mock("../../lib/commands.svelte", () => ({ shortcutLabel: () => "" }));
vi.mock("../../lib/ui.svelte", () => ({ ui: { openMenu: h.openMenu } }));

const { default: FilesView } = await import("./FilesView.svelte");

let cmp: ReturnType<typeof mount> | null = null;
const show = () => {
  cmp = mount(FilesView, { target: document.body });
  flushSync();
};
beforeEach(() => {
  vi.clearAllMocks();
  h.share.hostHasRoot = true;
});
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
});

test("header buttons create a file and a folder at the project root", () => {
  show();
  document.querySelector<HTMLElement>('.actions [aria-label="New File"]')!.click();
  expect(h.remoteCreate).toHaveBeenLastCalledWith("", false);
  document.querySelector<HTMLElement>('.actions [aria-label="New Folder"]')!.click();
  expect(h.remoteCreate).toHaveBeenLastCalledWith("", true);
});

test("the empty tree area has a menu, so an empty project has a mouse path", () => {
  show();
  document.querySelector(".tree")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const items = h.openMenu.mock.calls[0][1] as { label: string; action?: () => void }[];
  items.find((i) => i.label === "New Folder")!.action!();
  expect(h.remoteCreate).toHaveBeenCalledWith("", true);
});

test("without a host folder there is nothing to create in", () => {
  h.share.hostHasRoot = false;
  show();
  expect(document.querySelector(".actions")).toBeNull();
  document.querySelector(".tree")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(h.openMenu).not.toHaveBeenCalled();
});
