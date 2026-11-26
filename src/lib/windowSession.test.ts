import { describe, expect, it } from "vitest";
import { handsOverFolder, keepsSession, parseSession, sessionOf } from "./windowSessionData";

describe("window session", () => {
  it("keeps tabs with a file, not unsaved or shared ones", () => {
    const tabs = [
      { id: "1", path: "/p/a.py" },
      { id: "2", path: null },
      { id: "3", path: "collab:x.py" },
      { id: "4", path: "/p/b.py" },
    ];
    expect(sessionOf(tabs, "4")).toEqual({ files: ["/p/a.py", "/p/b.py"], active: "/p/b.py" });
    expect(sessionOf(tabs, "3").active).toBeNull();
    expect(sessionOf(tabs, "2").active).toBeNull();
  });

  it("a window sent to another folder doesn't bring back the old tabs", () => {
    expect(keepsSession(null, "/a", false)).toBe(true);
    expect(keepsSession("/a", "/a", false)).toBe(true);
    expect(keepsSession("/b", "/a", false)).toBe(false);
    expect(keepsSession(null, "/a", true)).toBe(false);
  });

  it("a window without a folder keeps its loose tabs when it gets one", () => {
    expect(keepsSession("/new", null, false)).toBe(true);
    expect(keepsSession("/new", null, true)).toBe(false);
  });

  it("a workspace taken over from an old profile isn't replaced by a cold omega <folder>", () => {
    expect(handsOverFolder(true, "/cli", "/old")).toBe(true);
    expect(handsOverFolder(true, "/old", "/old")).toBe(false);
    expect(handsOverFolder(true, "/cli", null)).toBe(false);
    expect(handsOverFolder(false, "/cli", "/old")).toBe(false);
    expect(handsOverFolder(true, null, "/old")).toBe(false);
  });

  it("reads a damaged session as none", () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession("{")).toBeNull();
    expect(parseSession('{"files":3}')).toBeNull();
    expect(parseSession('{"files":["/a",5],"active":7}')).toEqual({ files: ["/a"], active: null });
  });

  it("keeps a saved split layout and drops a broken one (#219)", () => {
    const layout = { root: { dir: "row", children: [{ group: 0 }, { group: 1 }], sizes: [0.5, 0.5] }, groups: [{ files: ["/a"], active: "/a", modes: {} }, { files: ["/a"], active: "/a", modes: { "/a": "code" } }], focused: 1 };
    expect(parseSession(JSON.stringify({ files: ["/a"], active: "/a", layout }))?.layout).toEqual(layout);
    expect(parseSession(JSON.stringify({ files: ["/a"], active: "/a", layout: { groups: [] } }))).toEqual({ files: ["/a"], active: "/a" });
  });
});
