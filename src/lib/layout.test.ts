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

  // #30: a zone absent from the saved data keeps its defaults; they must not be appended a second time.
  test("a missing zone keeps its defaults without duplicates", () => {
    save({ zones: { left: { views: ["files"] } } });
    const { zones } = load();
    expect(zones.left.views).toEqual(["files", "changes", "outline"]);
    expect(zones.bottom.views).toEqual(["terminal", "console", "search"]);
    expect(new Set(allViews(zones)).size).toBe(VIEWS.length);
  });

  // #30: a stale/unknown active id is dropped.
  test("active must be one of the zone's views", () => {
    save({ zones: { left: { views: ["files"], active: "bogus" } } });
    expect(load().zones.left.active).not.toBe("bogus");
  });

  // #30: a non-array `views` (corrupted data) must not make load() throw at startup.
  test("corrupted views value does not throw", () => {
    save({ zones: { left: { views: 5 } } });
    expect(() => load()).not.toThrow();
  });

  test("a view moved out of a missing zone is not duplicated there", () => {
    save({ zones: { left: { views: ["files", "terminal"], active: "terminal" } } });
    const { zones } = load();
    expect(zones.left.views).toEqual(["files", "terminal", "changes", "outline"]);
    expect(zones.bottom.views).toEqual(["console", "search"]);
    expect(zones.bottom.active).toBeNull();
    expect(new Set(allViews(zones)).size).toBe(VIEWS.length);
  });

  test("corrupt open state is dropped, valid entries kept (#92)", () => {
    save({ open: 5 });
    expect(load().open).toEqual({});
    save({ open: [true] });
    expect(load().open).toEqual({});
    save({ open: { code: "x", markdown: { left: true, bottom: "yes", nowhere: false }, latex: null, text: { right: false } } });
    expect(load().open).toEqual({ markdown: { left: true }, text: { right: false } });
  });
});
