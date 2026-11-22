import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  open: vi.fn(async () => "/picked"),
  save: vi.fn(async () => "/saved"),
  openUrl: vi.fn(async () => {}),
  reveal: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.open, save: h.save }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl, revealItemInDir: h.reveal }));

import { mockIPC } from "@tauri-apps/api/mocks";
import { linkTarget, openDialog, openUrl, revealItemInDir, sandboxNative, saveDialog } from "./native";

beforeEach(() => {
  vi.clearAllMocks();
  sandboxNative(null);
});

describe("without sandbox", () => {
  test("passes calls through to the plugins with the same arguments", async () => {
    const o = { directory: true, title: "Pick" };
    expect(await openDialog(o)).toBe("/picked");
    expect(h.open).toHaveBeenCalledWith(o);
    expect(await saveDialog({ defaultPath: "/x.txt" })).toBe("/saved");
    expect(h.save).toHaveBeenCalledWith({ defaultPath: "/x.txt" });
    await openUrl("https://example.com", "firefox");
    expect(h.openUrl).toHaveBeenCalledWith("https://example.com", "firefox");
    await revealItemInDir("/a/b");
    expect(h.reveal).toHaveBeenCalledWith("/a/b");
  });
});

describe("links", () => {
  test("a plain link leaves through the backend, which cleans the AppImage environment", async () => {
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
    });
    await openUrl("https://example.com/");
    expect(calls).toEqual([["open_external", { url: "https://example.com/" }]]);
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  test("only new-window web links are taken over", () => {
    const click = (href: string, target: string | null, init: MouseEventInit = {}) => {
      const a = document.createElement("a");
      a.href = href;
      if (target) a.target = target;
      document.body.append(a);
      let got: string | null = null;
      a.addEventListener("click", (e) => {
        got = linkTarget(e);
        e.preventDefault();
      });
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
      a.remove();
      return got;
    };
    expect(click("https://example.com/", "_blank")).toBe("https://example.com/");
    expect(click("https://example.com/", null, { ctrlKey: true })).toBe("https://example.com/");
    expect(click("https://example.com/", null)).toBeNull();
    expect(click("file:///etc/passwd", "_blank")).toBeNull();
  });
});

describe("with sandbox", () => {
  test("routes dialogs and opener to the sandbox, never to the plugins", async () => {
    const dialog = vi.fn(async () => "/from-prompt");
    const open = vi.fn();
    sandboxNative({ dialog, open });
    expect(await openDialog({ directory: true })).toBe("/from-prompt");
    expect(dialog).toHaveBeenLastCalledWith("open folder", { directory: true });
    await openDialog({});
    expect(dialog).toHaveBeenLastCalledWith("open file", {});
    await saveDialog();
    expect(dialog).toHaveBeenLastCalledWith("save file", {});
    await openUrl("https://example.com");
    await revealItemInDir("/a/b");
    expect(open.mock.calls).toEqual([["https://example.com"], ["reveal /a/b"]]);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.openUrl).not.toHaveBeenCalled();
    expect(h.reveal).not.toHaveBeenCalled();
  });
});
