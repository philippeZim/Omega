// A shared file on a guest gets the host's language features, and the path-based ones under its shared path.
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

test("shared files get the debug gutter and the git extensions under their shared path", () => {
  remoteLsp.extension = vi.fn(() => []);
  modeExtensions("code", "collab:src/a.py");
  expect(h.debug).toHaveBeenCalledWith("collab:src/a.py");
  expect(h.blame).toHaveBeenCalledWith("collab:src/a.py");
  expect(h.gutter).toHaveBeenCalledWith("collab:src/a.py");
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
