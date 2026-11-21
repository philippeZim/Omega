import { beforeEach, describe, expect, it, vi } from "vitest";

describe("guest pauses across windows", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("a pause set in another window holds here at once", async () => {
    const g = await import("./guestChanges");
    expect(g.pausedBy("tab", "/p/main.tex")).toBeNull();
    localStorage.setItem("latex.guestChanged", JSON.stringify({ "/p": "Eve" }));
    expect(g.pausedBy("tab", "/p/main.tex")).toBe("Eve");
    localStorage.setItem("metals.guestChanged", JSON.stringify({ "/p": "Eve" }));
    expect(g.metalsPausedBy("/p")).toBe("Eve");
  });

  it("saving here doesn't drop a pause another window just set", async () => {
    const g = await import("./guestChanges");
    localStorage.setItem("metals.guestChanged", JSON.stringify({ "/other": "Eve" }));
    g.resumeMetals("/unrelated", g.metalsChangeCount());
    expect(JSON.parse(localStorage.getItem("metals.guestChanged")!)).toEqual({ "/other": "Eve" });
  });

  it("missing or broken data never lifts a pause", async () => {
    localStorage.setItem("latex.guestChanged", JSON.stringify({ "/p": "Eve" }));
    const g = await import("./guestChanges");
    localStorage.removeItem("latex.guestChanged");
    expect(g.pausedBy("tab", "/p/main.tex")).toBe("Eve");
    localStorage.setItem("latex.guestChanged", "{broken");
    expect(g.pausedBy("tab", "/p/main.tex")).toBe("Eve");
  });
});
