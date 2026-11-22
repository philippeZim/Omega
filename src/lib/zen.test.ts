import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./state.svelte", () => ({ app: { mode: "code", activeId: null } }));
vi.mock("./debug/store.svelte", () => ({ dbg: { status: "idle", console: [] } }));
vi.mock("./search/search.svelte", () => ({ find: { docked: false } }));
vi.mock("./editor", () => ({ getView: () => null, focus: vi.fn() }));

import { layout, setOpen, setActive, setSize, saveLayout, moveView } from "./layout.svelte";
import { enterZen, exitZen, toggleZen, zen } from "./zen.svelte";

describe("zen mode", () => {
  beforeEach(async () => {
    await exitZen();
    localStorage.clear();
  });

  test("toggles on and off", async () => {
    toggleZen();
    expect(zen.on).toBe(true);
    await toggleZen();
    expect(zen.on).toBe(false);
  });

  test("returns to exactly the previous layout", async () => {
    setOpen("bottom", true);
    setSize("left", 333);
    const before = JSON.stringify({ zones: layout.zones, open: layout.open });
    enterZen();
    setOpen("bottom", false);
    setActive("left", "changes");
    setSize("left", 500);
    moveView("terminal", "right");
    await exitZen();
    expect(JSON.stringify({ zones: layout.zones, open: layout.open })).toBe(before);
  });

  test("saves nothing while on, so a restart restores the normal layout", async () => {
    setOpen("bottom", true);
    const saved = localStorage.getItem("layout");
    enterZen();
    setOpen("bottom", false);
    setSize("left", 500);
    saveLayout();
    expect(localStorage.getItem("layout")).toBe(saved);
    await exitZen();
    expect(localStorage.getItem("layout")).toBe(saved);
  });

  test("takes focus away from a panel that gets hidden and gives it back", async () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();
    enterZen();
    expect(document.activeElement).not.toBe(input);
    await exitZen();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  test("saving works again afterwards", async () => {
    enterZen();
    await exitZen();
    setSize("left", 412);
    saveLayout();
    expect(JSON.parse(localStorage.getItem("layout")!).zones.left.size).toBe(412);
  });
});
