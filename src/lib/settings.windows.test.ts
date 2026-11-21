import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./terminal.svelte", () => ({ setTerminalPalette: vi.fn(), setTerminalFontSize: vi.fn() }));
vi.mock("./editor", () => ({ getView: () => null }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: async () => {} }) }));

const fromOtherWindow = (key: string, value: string) => {
  // What the other window stored is already there when the event arrives.
  localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
};

describe("settings across windows", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("starting a window writes no setting", async () => {
    const set = vi.spyOn(localStorage, "setItem");
    await import("./settings.svelte");
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it("a change from another window is applied and never written back", async () => {
    const { settings } = await import("./settings.svelte");
    localStorage.setItem("uiScale", "1.2");
    const set = vi.spyOn(localStorage, "setItem");
    window.dispatchEvent(new StorageEvent("storage", { key: "uiScale", newValue: "1.2" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "appearance", newValue: "light" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "material", newValue: "liquid" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "syntaxThemeDark", newValue: "xcode" }));
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
    expect(settings.uiScale).toBe(1.2);
    expect(settings.appearance).toBe("light");
    expect(settings.material).toBe("liquid");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("changing one size stores only that size", async () => {
    const { setSize } = await import("./settings.svelte");
    fromOtherWindow("codeFontSize", "20");
    const set = vi.spyOn(localStorage, "setItem");
    setSize("uiScale", 1.1);
    expect(set.mock.calls).toEqual([["uiScale", "1.1"]]);
    set.mockRestore();
    expect(localStorage.getItem("codeFontSize")).toBe("20");
  });
});
