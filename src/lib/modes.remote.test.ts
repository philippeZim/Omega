// A shared file on a guest gets the host's language features, and still no path-based extensions.
import { afterEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ lsp: vi.fn(() => []), debug: vi.fn(() => []), blame: vi.fn(() => []), gutter: vi.fn(() => []) }));
vi.mock("./code/lspExtension", () => ({ lspExtension: h.lsp }));
vi.mock("./debug/editorExt", () => ({ debugExtension: h.debug }));
vi.mock("./git/blame.svelte", () => ({ gitBlame: h.blame }));
vi.mock("./git/gutter", () => ({ gitGutter: h.gutter }));

const { modeExtensions } = await import("./modes");
const { remoteLsp } = await import("./code/remoteLsp");

afterEach(() => {
  remoteLsp.extension = null;
  vi.clearAllMocks();
});

test("a shared Python file uses the guest's language extension with its relative path", () => {
  const ext = vi.fn(() => []);
  remoteLsp.extension = ext;
  modeExtensions("code", "collab:src/a.py");
  expect(ext).toHaveBeenCalledWith("src/a.py");
  expect(h.lsp).not.toHaveBeenCalled();
});

test("git and debug extensions stay off for shared files", () => {
  remoteLsp.extension = vi.fn(() => []);
  modeExtensions("code", "collab:src/a.py");
  expect(h.debug).not.toHaveBeenCalled();
  expect(h.blame).not.toHaveBeenCalled();
  expect(h.gutter).not.toHaveBeenCalled();
});

test("a shared file without a language server doesn't ask for one", () => {
  const ext = vi.fn(() => []);
  remoteLsp.extension = ext;
  modeExtensions("code", "collab:notes.xyz");
  expect(ext).not.toHaveBeenCalled();
});

test("local files keep the local language server", () => {
  const ext = vi.fn(() => []);
  remoteLsp.extension = ext;
  modeExtensions("code", "/p/a.py");
  expect(h.lsp).toHaveBeenCalledOnce();
  expect(ext).not.toHaveBeenCalled();
});
