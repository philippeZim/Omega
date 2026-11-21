// Guest session: the guest's own folder must not be mixed into the session, New File reaches the
// host's project, and Save As on a shared tab does something.
import { beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  share: { hostHasRoot: true },
  remoteCreate: vi.fn(async () => {}),
  saveCopyToHost: vi.fn(async () => true),
  openDialog: vi.fn(async () => "/mine"),
  toast: vi.fn(),
}));
vi.mock("./editor", async () => (await import("../test/fakes")).fakeEditor());
vi.mock("./ui.svelte", () => ({ ui: { toast: h.toast } }));
vi.mock("./native", () => ({ openDialog: h.openDialog, saveDialog: vi.fn(async () => null), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }) }));
vi.mock("./latex/controller.svelte", () => ({ schedule: vi.fn() }));
vi.mock("./code/lspExtension", () => ({ setLspHooks: vi.fn() }));
vi.mock("./code/lsp.svelte", () => ({ allClients: () => [], fileUri: (p: string) => "file://" + p, closeLspDoc: () => {}, saveLspDoc: async () => {} }));
vi.mock("./markdown/livePreview", () => ({ setLinkHandler: vi.fn(), resolvePath: vi.fn() }));
vi.mock("./modes", () => ({ modeForExtension: () => null }));
vi.mock("./fsWatch.svelte", () => ({ onFilesChanged: vi.fn(), watchRoot: vi.fn() }));
vi.mock("./i18n/index.svelte", () => ({ t: (k: string) => k }));
vi.mock("./collab/share.svelte", () => ({ share: h.share, remoteCreate: h.remoteCreate }));
vi.mock("./collab/guestFiles", () => ({ saveCopyToHost: h.saveCopyToHost }));

const { app, setRoot, openFolder, newFileInSession, save } = await import("./state.svelte");
const { guestGuard } = await import("./collab/guard");

beforeEach(() => {
  vi.clearAllMocks();
  h.share.hostHasRoot = true;
  app.root = null;
  app.tabs.length = 0;
  app.activeId = null;
  guestGuard.status = () => "connected";
});

test("a guest can't open a folder into the session", async () => {
  setRoot("/mine");
  expect(app.root).toBeNull();
  await openFolder();
  expect(h.openDialog).not.toHaveBeenCalled();
  expect(h.toast).toHaveBeenCalledWith("ai.collab.leaveFirst", "error");
});

test("joining can still put the guest's own folder aside", () => {
  guestGuard.status = () => "none";
  setRoot("/mine");
  guestGuard.status = () => "pending";
  setRoot(null);
  expect(app.root).toBeNull();
});

test("New File as a guest creates the file in the host's project", async () => {
  await newFileInSession();
  expect(h.remoteCreate).toHaveBeenCalledWith("", false);
  expect(app.tabs).toHaveLength(0);
});

test("New File without a host folder opens a local tab and says so", async () => {
  h.share.hostHasRoot = false;
  await newFileInSession();
  expect(h.remoteCreate).not.toHaveBeenCalled();
  expect(app.tabs).toHaveLength(1);
  expect(h.toast).toHaveBeenCalledWith("ai.collab.localFileHint");
});

test("Save As on a shared tab saves a copy, plain Save stays with the host", async () => {
  app.tabs.push({ id: "r", path: "collab:a.txt", name: "a.txt", dirty: false });
  expect(await save("r")).toBe(true);
  expect(h.saveCopyToHost).not.toHaveBeenCalled();
  await save("r", true);
  expect(h.saveCopyToHost).toHaveBeenCalledTimes(1);
});
