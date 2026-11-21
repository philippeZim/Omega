import { beforeEach, describe, expect, it, vi } from "vitest";
import { isWindowKey, migrateToWindow, MIGRATED_KEY, onGlobalChange, pruneWindows, scopedStorage } from "./windowStorage";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe("window storage", () => {
  let real: Storage;
  beforeEach(() => {
    real = memory();
  });

  it("keeps per-window keys apart and shares settings", () => {
    const a = scopedStorage(real, "main");
    const b = scopedStorage(real, "w-b");
    a.setItem("root", "/a");
    b.setItem("root", "/b");
    a.setItem("termVisible:code", "true");
    a.setItem("appearance", "light");
    expect(a.getItem("root")).toBe("/a");
    expect(b.getItem("root")).toBe("/b");
    expect(b.getItem("termVisible:code")).toBeNull();
    expect(b.getItem("appearance")).toBe("light");
    b.removeItem("root");
    expect(a.getItem("root")).toBe("/a");
  });

  it("classifies state and settings", () => {
    for (const k of ["root", "mode", "layout", "session", "expanded", "find.query", "collab.guestSnapshot", "termVisible:latex"]) expect(isWindowKey(k), k).toBe(true);
    for (const k of ["appearance", "keybindings", "mcp.token", "uiLanguage", "breakpoints", "recentFolders", "latex.guestChanged", "metals.guestChanged", "ocaml.guestChanged", "runCmd:/x"]) expect(isWindowKey(k), k).toBe(false);
  });

  it("moves an old profile into its first window, once and without loss", () => {
    real.setItem("root", "/old");
    real.setItem("layout", "{}");
    real.setItem("termVisible:code", "false");
    real.setItem("appearance", "light");
    migrateToWindow(real, "main");
    const a = scopedStorage(real, "main");
    expect(a.getItem("root")).toBe("/old");
    expect(a.getItem("layout")).toBe("{}");
    expect(a.getItem("termVisible:code")).toBe("false");
    expect(real.getItem("root")).toBeNull();
    expect(real.getItem("appearance")).toBe("light");
    expect(real.getItem(MIGRATED_KEY)).toBe("1");

    // A later window starts empty and doesn't take the first one's state.
    migrateToWindow(real, "main");
    migrateToWindow(real, "w-b");
    expect(scopedStorage(real, "w-b").getItem("root")).toBeNull();
    expect(a.getItem("root")).toBe("/old");
  });

  it("only the main window takes over an old profile, whichever loads first", () => {
    real.setItem("root", "/old");
    real.setItem("layout", "{}");
    migrateToWindow(real, "w-0123456789abcdef");
    expect(real.getItem("root")).toBe("/old");
    expect(real.getItem("layout")).toBe("{}");
    expect(real.getItem(MIGRATED_KEY)).toBeNull();
    expect(real.getItem("w:w-0123456789abcdef:root")).toBeNull();
    migrateToWindow(real, "main");
    expect(real.getItem("w:main:root")).toBe("/old");
    expect(real.getItem("root")).toBeNull();
  });

  it("leaves the old profile alone when storage fails during the move", () => {
    real.setItem("root", "/old");
    const set = real.setItem;
    real.setItem = (k, v) => {
      if (k === MIGRATED_KEY) throw new Error("full");
      set(k, v);
    };
    migrateToWindow(real, "main");
    expect(real.getItem("root")).toBe("/old");
    expect(real.getItem("w:main:root")).toBeNull();
    real.setItem = set;
    migrateToWindow(real, "main");
    expect(scopedStorage(real, "main").getItem("root")).toBe("/old");
  });

  it("removes only the state of closed windows", () => {
    scopedStorage(real, "main").setItem("root", "/a");
    scopedStorage(real, "w-b").setItem("root", "/b");
    real.setItem("appearance", "dark");
    pruneWindows(real, ["main"]);
    expect(real.getItem("w:main:root")).toBe("/a");
    expect(real.getItem("w:w-b:root")).toBeNull();
    expect(real.getItem("appearance")).toBe("dark");
  });

  it("applies a global change from another window", () => {
    const fn = vi.fn();
    onGlobalChange("test.key", fn);
    window.dispatchEvent(new StorageEvent("storage", { key: "test.key", newValue: "v" }));
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "x" }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("v");
  });
});
