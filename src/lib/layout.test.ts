import { describe, expect, test, vi } from "vitest";

vi.mock("./state.svelte", () => ({ app: { mode: "code", activeId: null } }));
vi.mock("./debug/store.svelte", () => ({ dbg: { status: "idle", console: [] } }));
vi.mock("./search/search.svelte", () => ({ find: { docked: false } }));
vi.mock("./editor", () => ({ getView: () => null }));

import { VIEWS, load } from "./layout.svelte";

const save = (v: unknown) => localStorage.setItem("layout", JSON.stringify(v));
const allViews = (z: ReturnType<typeof load>["zones"]) => [...z.left.views, ...z.right.views, ...z.bottom.views];

describe("layout load()", () => {
  test("defaults, with sizes from the pre-dock keys", () => {
    localStorage.setItem("sidebarWidth", "300");
    localStorage.setItem("termHeight", "-5");
    const { zones, open } = load();
    expect(zones.left).toEqual({ views: ["files", "changes", "outline"], active: "files", size: 300 });
    expect(zones.bottom.size).toBe(260);
    expect(zones.right.size).toBe(560);
    expect(open).toEqual({});
  });

  test("invalid JSON falls back to defaults", () => {
    localStorage.setItem("layout", "{oops");
    expect(load().zones.left.active).toBe("files");
  });

  test("drops unknown and duplicate views, re-adds missing ones to their default zone", () => {
    save({
      zones: {
        left: { views: ["terminal", "bogus", "files"], active: "terminal", size: 400 },
        right: { views: ["files", "pdf"], active: null, size: 0 },
        bottom: { views: [], active: null, size: 200 },
      },
      open: { code: { bottom: false } },
    });
    const { zones, open } = load();
    expect(zones.left.views).toEqual(["terminal", "files", "changes", "outline"]);
    expect(zones.right.views).toEqual(["pdf", "debug"]);
    expect(zones.bottom.views).toEqual(["console", "search"]);
    expect(zones.left.size).toBe(400);
    expect(zones.right.size).toBe(560); // 0 is not a valid size
    expect(open).toEqual({ code: { bottom: false } });
    expect(allViews(zones).sort()).toEqual([...VIEWS].sort());
  });

  // bug: a zone absent from the saved data keeps its default views but they are not marked as seen,
  // so the "views added in a later version" loop appends them a second time (duplicate tabs).
  test.fails("a missing zone keeps its defaults without duplicates", () => {
    save({ zones: { left: { views: ["files"] } } });
    const { zones } = load();
    expect(zones.left.views).toEqual(["files", "changes", "outline"]);
    expect(zones.bottom.views).toEqual(["terminal", "console", "search"]);
    expect(new Set(allViews(zones)).size).toBe(VIEWS.length);
  });

  // bug: `active` is copied unchecked, so a stale/unknown id survives load() (activeView() masks it at runtime).
  test.fails("active must be one of the zone's views", () => {
    save({ zones: { left: { views: ["files"], active: "bogus" } } });
    expect(load().zones.left.active).not.toBe("bogus");
  });

  // bug: a non-array `views` (e.g. a number from a corrupted file) makes load() throw at startup.
  test.fails("corrupted views value does not throw", () => {
    save({ zones: { left: { views: 5 } } });
    expect(() => load()).not.toThrow();
  });
});
