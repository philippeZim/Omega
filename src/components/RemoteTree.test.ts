// Guest tree: same keys and menu entries as the host's tree.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

const h = vi.hoisted(() => ({
  share: { treeGen: 0, hostHasRoot: true, hostTabs: [], presence: {} },
  remoteRename: vi.fn(), remoteDelete: vi.fn(), remoteCreate: vi.fn(), openRemote: vi.fn(),
  openMenu: vi.fn(),
}));
vi.mock("../lib/collab/share.svelte", () => ({
  share: h.share, remoteRename: h.remoteRename, remoteDelete: h.remoteDelete, remoteCreate: h.remoteCreate, openRemote: h.openRemote,
  listRemote: async () => [{ name: "a.txt", rel: "src/a.txt", is_dir: false }],
}));
vi.mock("../lib/state.svelte", () => ({ activeTab: () => null }));
vi.mock("../lib/ui.svelte", () => ({ ui: { openMenu: h.openMenu } }));

const { default: RemoteTree } = await import("./RemoteTree.svelte");

let cmp: ReturnType<typeof mount>;
let row: HTMLElement;
beforeEach(async () => {
  vi.clearAllMocks();
  cmp = mount(RemoteTree, { target: document.body });
  flushSync();
  await tick();
  await new Promise((r) => setTimeout(r));
  flushSync();
  row = document.querySelector<HTMLElement>('[role="treeitem"]')!;
});
afterEach(() => unmount(cmp));

test("F2 renames, Delete deletes", () => {
  row.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  expect(h.remoteRename).toHaveBeenCalledWith("src/a.txt");
  row.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
  expect(h.remoteDelete).toHaveBeenCalledWith("src/a.txt");
});

test("the menu copies the relative path", () => {
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const items = h.openMenu.mock.calls[0][1] as { label: string; action?: () => void }[];
  items.find((i) => i.label === "Copy Relative Path")!.action!();
  expect(writeText).toHaveBeenCalledWith("src/a.txt");
});
