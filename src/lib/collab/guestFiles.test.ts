import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  share: { hostHasRoot: true, treeGen: 0 },
  app: { tabs: [] as { id: string; path: string | null; name: string; dirty: boolean }[] },
  remoteFsOp: vi.fn(),
  openRemote: vi.fn(),
  prompt: vi.fn(),
  toast: vi.fn(),
  replaceDocText: vi.fn(),
}));
vi.mock("./share.svelte", () => ({ REMOTE: "collab:", share: h.share, remoteFsOp: h.remoteFsOp, openRemote: h.openRemote, opErrorText: (e: string) => (e === "exists" ? "code.existsAlready" : e) }));
vi.mock("../state.svelte", () => ({ app: h.app }));
vi.mock("../editor", () => ({ getText: () => "hello", replaceDocText: h.replaceDocText }));
vi.mock("../ui.svelte", () => ({ ui: { prompt: h.prompt, toast: h.toast } }));
vi.mock("../i18n/index.svelte", () => ({ t: (k: string) => k }));

const { saveCopyToHost } = await import("./guestFiles");
const tab = { id: "a", path: "collab:src/a.txt", name: "a.txt", dirty: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.share.hostHasRoot = true;
  h.app.tabs = [tab];
  h.remoteFsOp.mockResolvedValue(null);
  h.openRemote.mockImplementation(async (rel: string) => void h.app.tabs.push({ id: "b", path: "collab:" + rel, name: rel, dirty: false }));
});

test("creates the file on the host and writes the tab's text into the new shared tab", async () => {
  h.prompt.mockResolvedValue("src/b.txt");
  expect(await saveCopyToHost(tab)).toBe(true);
  expect(h.remoteFsOp).toHaveBeenCalledWith("create", "src/b.txt");
  expect(h.replaceDocText).toHaveBeenCalledWith("b", "hello");
});

test("an existing name is reported and nothing is overwritten", async () => {
  h.prompt.mockResolvedValue("src/b.txt");
  h.remoteFsOp.mockResolvedValue("exists");
  expect(await saveCopyToHost(tab)).toBe(false);
  expect(h.toast).toHaveBeenCalledWith("code.existsAlready", "error");
  expect(h.replaceDocText).not.toHaveBeenCalled();
});

test("without a host folder it explains why instead of doing nothing", async () => {
  h.share.hostHasRoot = false;
  expect(await saveCopyToHost(tab)).toBe(false);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(h.toast).toHaveBeenCalledWith("ai.collab.saveCopyNoFolder", "error");
});
