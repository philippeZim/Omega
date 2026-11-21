import { beforeEach, expect, test, vi } from "vitest";

let mod: typeof import("./guestChanges");

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  mod = await import("./guestChanges");
  mod.guestChangeHooks.mayRun = (peer) => peer === "trusted";
  mod.guestChangeHooks.name = (peer) => `name-${peer}`;
});

test("an edit by a guest without run pauses that project only", () => {
  mod.noteGuestChange("g", "/p", "main.tex");
  expect(mod.pausedBy("t1", "/p/ch/a.tex")).toBe("name-g");
  expect(mod.isPaused("/p", null)).toBe(true);
  expect(mod.pausedBy("t1", "/project/a.tex")).toBeNull();
  expect(mod.pausedBy("t1", null)).toBeNull();
});

test("a guest with run, or no change at all, pauses nothing", () => {
  mod.noteGuestChange("trusted", "/p", "main.tex");
  expect(mod.pausedBy("t1", "/p/main.tex")).toBeNull();
  expect(mod.isPaused("/p", null)).toBe(false);
});

test("an unsaved shared tab is paused on its own", () => {
  mod.noteGuestChange("g", "/p", "tab:u1");
  expect(mod.pausedBy("u1", null)).toBe("name-g");
  expect(mod.pausedBy("u2", "/p/main.tex")).toBeNull();
  expect(mod.isPaused(null, "u1")).toBe(true);
  mod.resumeCompiling("u1", null);
  expect(mod.pausedBy("u1", null)).toBeNull();
});

test("Compile resumes until the next change", () => {
  mod.noteGuestChange("g", "/p", "main.tex");
  mod.resumeCompiling("t1", "/p/main.tex");
  expect(mod.pausedBy("t1", "/p/main.tex")).toBeNull();
  mod.noteGuestChange("g", "/p", "ch.tex");
  expect(mod.pausedBy("t1", "/p/main.tex")).toBe("name-g");
});

test("the pause survives a restart, so leaving doesn't launder the text", async () => {
  mod.noteGuestChange("g", "/p", "main.tex");
  vi.resetModules();
  const again = await import("./guestChanges");
  expect(again.pausedBy("t1", "/p/main.tex")).toBe("name-g");
  again.resumeCompiling("t1", "/p/main.tex");
  vi.resetModules();
  expect((await import("./guestChanges")).pausedBy("t1", "/p/main.tex")).toBeNull();
});

test("until the session says otherwise, nobody counts as allowed to run", async () => {
  vi.resetModules();
  const fresh = await import("./guestChanges");
  fresh.noteGuestChange("anyone", "/q", "a.tex");
  expect(fresh.isPaused("/q", null)).toBe(true);
});

test("a !TEX root in a paused project pauses a tab outside it", () => {
  mod.noteGuestChange("g", "/p", "main.tex");
  expect(mod.texRootOf("/o/x/a.tex", "% !TEX root = ../../p/main.tex\n")).toBe("/p/main.tex");
  expect(mod.pausedBy("t1", "/o/x/a.tex", "% !TEX root = ../../p/main.tex\n")).toBe("name-g");
  expect(mod.pausedBy("t1", "/o/x/a.tex", "%!TeX root=/p/main.tex\n")).toBe("name-g");
  expect(mod.pausedBy("t1", "/o/x/a.tex", "no comment\n")).toBeNull();
  mod.resumeCompiling("t1", "/o/x/a.tex", "% !TEX root = ../../p/main.tex\n");
  expect(mod.isPaused("/p", null)).toBe(false);
});

test("the pause follows a moved folder, and a file moved out of the project", () => {
  mod.noteGuestChange("g", "/w/p", "main.tex");
  mod.moveGuestChange("/w/p", "/w/renamed");
  expect(mod.pausedBy("t", "/w/renamed/main.tex")).toBe("name-g");
  expect(mod.pausedBy("t", "/w/p/main.tex")).toBeNull();
  mod.moveGuestChange("/w/renamed/main.tex", "/other/main.tex");
  expect(mod.pausedBy("t", "/other/main.tex")).toBe("name-g");
  expect(mod.pausedBy("t", "/w/renamed/x.tex")).toBe("name-g");
  mod.moveGuestChange("/elsewhere/a", "/elsewhere/b");
  expect(mod.pausedBy("t", "/elsewhere/b")).toBeNull();
});
