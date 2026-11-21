import { describe, expect, test, vi } from "vitest";
import { AssetCache, ASSET_PREFIX, guestFile, imageDataUrl, remoteRel } from "./guestAssets";
import { ImageWidget, imageHooks } from "../markdown/widgets";

describe("paths in a shared doc", () => {
  const from = "collab:docs/notes/a.md";
  test("relative paths resolve inside the project", () => {
    expect(remoteRel("b.png", from)).toBe("docs/notes/b.png");
    expect(remoteRel("./img/b.png", from)).toBe("docs/notes/img/b.png");
    expect(remoteRel("../../top.md#part", from)).toBe("top.md");
    expect(remoteRel("my%20pic.png?x=1", from)).toBe("docs/notes/my pic.png");
  });
  test.each(["/etc/passwd", "../../../etc/passwd", "C:/x.png", "..\\..\\x", "file:///etc/passwd", "https://a.b/c.png", "", "#only"])("%s is not a project path", (href) => {
    expect(remoteRel(href, from)).toBeNull();
  });
  test("an unsaved shared tab has no folder, a local file isn't remote", () => {
    expect(remoteRel("b.png", "collab:tab:abc")).toBeNull();
    expect(remoteRel("b.png", "/home/u/a.md")).toBeNull();
    expect(remoteRel("b.png", null)).toBeNull();
  });
  test("only project-relative files become guest tabs", () => {
    expect(guestFile("ch/one.tex")).toBe("collab:ch/one.tex");
    for (const bad of ["", "/etc/passwd", "../x.tex", null]) expect(guestFile(bad)).toBe("");
  });
});

describe("guest images", () => {
  test("a project image goes through the loader and never becomes a file URL", () => {
    const load = vi.fn();
    imageHooks.load = load;
    const img = new ImageWidget(`${ASSET_PREFIX}docs/a.png`, "alt").toDOM();
    expect(img.tagName).toBe("IMG");
    expect(load).toHaveBeenCalledWith(img, "docs/a.png");
    expect(img.getAttribute("src")).toBeNull();
    imageHooks.load = null;
  });
  test("only image types make a data URL", () => {
    expect(imageDataUrl("image/svg+xml", "PHN2Zz4=")).toBe("data:image/svg+xml;base64,PHN2Zz4=");
    expect(imageDataUrl("text/html", "PHN2Zz4=")).toBeNull();
    expect(imageDataUrl("image/png", 'x"><script>')).toBeNull();
  });
  test("the cache is bounded and drops the least recently used", () => {
    const c = new AssetCache(10);
    c.set("a", "aaaa");
    c.set("b", "bbbb");
    c.get("a");
    c.set("c", "cccc");
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual(["aaaa", undefined, "cccc"]);
    c.set("big", "x".repeat(11));
    expect(c.get("big")).toBeUndefined();
    c.clear();
    expect(c.get("a")).toBeUndefined();
  });
});
