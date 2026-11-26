import { describe, expect, test, vi } from "vitest";

vi.mock("./state.svelte", () => ({ moveTab: vi.fn() }));
const { bodyTarget } = await import("./tabDrag.svelte");

describe("dropping a tab on a group's body (#219)", () => {
  const r = { left: 0, top: 0, width: 400, height: 200 };
  test("the edges split, the middle moves into the group", () => {
    expect(bodyTarget(r, 20, 100).side).toBe("left");
    expect(bodyTarget(r, 390, 100).side).toBe("right");
    expect(bodyTarget(r, 200, 10).side).toBe("up");
    expect(bodyTarget(r, 200, 190).side).toBe("down");
    expect(bodyTarget(r, 200, 100).side).toBeUndefined();
  });
  test("the preview is the half the new group would take", () => {
    expect(bodyTarget(r, 390, 100).preview).toEqual({ x: 200, y: 0, w: 200, h: 200 });
    expect(bodyTarget(r, 200, 190).preview).toEqual({ x: 0, y: 100, w: 400, h: 100 });
    expect(bodyTarget(r, 200, 100).preview).toEqual({ x: 0, y: 0, w: 400, h: 200 });
  });
});
