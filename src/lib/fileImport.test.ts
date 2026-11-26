import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ innerSize: async () => ({ width: window.innerWidth * 2 }), scaleFactor: async () => 2 }),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readImage: async () => Promise.reject(new Error("no image")) }));
const app = vi.hoisted(() => ({ root: "/p" as string | null, treeVersion: 0 }));
vi.mock("./state.svelte", () => ({ app }));
const ui = vi.hoisted(() => ({ toast: (..._a: unknown[]) => {} }));
vi.mock("./ui.svelte", () => ({ ui }));

const { folderOf, pastedImageName, handleDragDrop, externalDrop, pasteInto } = await import("./fileImport.svelte");

function tree() {
  document.body.innerHTML = `
    <div class="files"><div class="tree" data-tree-path="/p" data-tree-dir="1">
      <button id="dir" data-tree-path="/p/img" data-tree-dir="1">img</button>
      <button id="file" data-tree-path="/p/a.md" data-tree-dir="0">a.md</button>
    </div></div>`;
}

describe("fileImport (#299)", () => {
  beforeEach(() => {
    invoke.mockReset();
    app.root = "/p";
    tree();
  });

  it("a folder row is the target itself, a file row its folder, the empty area the root", () => {
    expect(folderOf(document.getElementById("dir"))).toBe("/p/img");
    expect(folderOf(document.getElementById("file"))).toBe("/p");
    expect(folderOf(document.querySelector(".tree"))).toBe("/p");
    expect(folderOf(document.body)).toBe(null);
  });

  it("names pasted images by date and time", () => {
    expect(pastedImageName(new Date(2026, 10, 26, 9, 5, 3))).toBe("image-2026-11-26-090503.png");
  });

  it("dropping on a folder row copies the files into it", async () => {
    const dir = document.getElementById("dir")!;
    document.elementFromPoint = vi.fn(() => dir);
    invoke.mockResolvedValue(["/p/img/x.png"]);
    await handleDragDrop({ type: "enter", paths: ["/home/u/x.png"], position: { x: 10, y: 10 } });
    expect(externalDrop.target).toBe("/p/img");
    await handleDragDrop({ type: "drop", paths: ["/home/u/x.png"], position: { x: 10, y: 10 } });
    expect(externalDrop.target).toBe(null);
    expect(invoke).toHaveBeenCalledWith("copy_into", { sources: ["/home/u/x.png"], dir: "/p/img" });
  });

  it("dropping outside the explorer copies nothing", async () => {
    document.elementFromPoint = vi.fn(() => document.body);
    await handleDragDrop({ type: "drop", paths: ["/home/u/x.png"], position: { x: 10, y: 10 } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("paste copies the files from the clipboard, or says there is nothing", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "clipboard_files" ? ["/home/u/doc.pdf"] : ["/p/doc.pdf"]));
    await pasteInto("/p");
    expect(invoke).toHaveBeenCalledWith("copy_into", { sources: ["/home/u/doc.pdf"], dir: "/p" });

    invoke.mockReset();
    invoke.mockResolvedValue([]);
    const toast = vi.spyOn(ui, "toast");
    await pasteInto("/p");
    expect(toast).toHaveBeenLastCalledWith(expect.any(String), "error");
    expect(invoke).not.toHaveBeenCalledWith("copy_into", expect.anything());
  });
});
