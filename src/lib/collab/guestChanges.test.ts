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

test("Compile doesn't release Metals, and allowing Metals doesn't resume LaTeX", () => {
  mod.noteGuestChange("g", "/p", "main.tex");
  expect(mod.metalsPausedBy("/p")).toBe("name-g");
  mod.resumeCompiling("t1", "/p/main.tex");
  expect(mod.pausedBy("t1", "/p/main.tex")).toBeNull();
  expect(mod.metalsPausedBy("/p")).toBe("name-g");

  mod.noteGuestChange("g", "/p", "main.tex");
  expect(mod.resumeMetals("/p", mod.metalsChangeCount())).toBe(true);
  expect(mod.metalsPausedBy("/p")).toBeNull();
  expect(mod.pausedBy("t1", "/p/main.tex")).toBe("name-g");
});

test("the Metals pause survives a restart and leaves LaTeX's stored data alone", async () => {
  mod.noteGuestChange("g", "/p", "a.scala");
  const latex = localStorage.getItem("latex.guestChanged");
  mod.resumeMetals("/p", mod.metalsChangeCount());
  expect(localStorage.getItem("latex.guestChanged")).toBe(latex);
  mod.noteGuestChange("g", "/p", "b.scala");
  vi.resetModules();
  const again = await import("./guestChanges");
  expect(again.metalsPausedBy("/p")).toBe("name-g");
});

test("a project LaTeX paused before Metals had a store counts, also after a later Compile", async () => {
  localStorage.setItem("latex.guestChanged", JSON.stringify({ "/old": "name-g" }));
  localStorage.removeItem("metals.guestChanged");
  vi.resetModules();
  const first = await import("./guestChanges");
  expect(first.metalsPausedBy("/old")).toBe("name-g");
  first.resumeCompiling("t1", "/old/main.tex");
  vi.resetModules();
  expect((await import("./guestChanges")).metalsPausedBy("/old")).toBe("name-g");
});

test("the Metals pause follows a move", async () => {
  mod.noteGuestChange("g", "/p/sub", "a.scala");
  mod.moveGuestChange("/p/sub", "/q/sub");
  expect(mod.metalsPausedBy("/q/sub")).toBe("name-g");
  expect(mod.metalsPausedBy("/p/sub")).toBeNull();
  vi.resetModules();
  expect((await import("./guestChanges")).metalsPausedBy("/q/sub")).toBe("name-g");
});

test("the Metals pause covers folders around and inside the changed one", () => {
  mod.noteGuestChange("g", "/p/sub", "a.scala");
  expect(mod.metalsPausedBy("/p")).toBe("name-g");
  expect(mod.metalsPausedBy("/p/sub/deep")).toBe("name-g");
  expect(mod.metalsPausedBy("/p/other")).toBeNull();
});

test("allowing Metals doesn't cover a change made after the question", () => {
  mod.noteGuestChange("g", "/p", "a.scala");
  const seen = mod.metalsChangeCount();
  mod.noteGuestChange("g", "/p", "build.sbt");
  expect(mod.resumeMetals("/p", seen)).toBe(false);
  expect(mod.metalsPausedBy("/p")).toBe("name-g");
});

test("a guest with run doesn't pause Metals", () => {
  mod.noteGuestChange("trusted", "/p", "a.scala");
  expect(mod.metalsPausedBy("/p")).toBeNull();
});

test("a guest's edit of an unsaved tab pauses Metals for the tab's project", () => {
  const fired = vi.fn();
  mod.onGuestChange(fired);
  const before = mod.metalsChangeCount();
  mod.noteGuestChange("g", "/p", "tab:u1");
  expect(mod.metalsPausedBy("/p")).toBe("name-g");
  expect(mod.metalsChangeCount()).toBeGreaterThan(before);
  expect(fired).toHaveBeenCalled();
  // LaTeX: still only that tab, and nothing stored.
  expect(mod.isPaused("/p", null)).toBe(false);
  expect(mod.pausedBy("u2", "/p/main.tex")).toBeNull();
  expect(localStorage.getItem("latex.guestChanged")).toBeNull();
});

test("without a folder, the pause moves to where the host saves the tab, before the write", () => {
  mod.noteGuestChange("g", null, "tab:u1");
  expect(mod.metalsPausedBy("/w")).toBeNull();
  const fired = vi.fn();
  mod.onGuestChange(fired);
  mod.metalsBeforeSave("u1", null, "/w/project/plugins.sbt");
  expect(mod.metalsPausedBy("/w")).toBe("name-g"); // the Metals root around that folder
  expect(fired).toHaveBeenCalled();
});

test("a failed save keeps the tab's pending pause for the next target", () => {
  mod.noteGuestChange("g", null, "tab:u1");
  mod.metalsBeforeSave("u1", null, "/bad/build.sbt")();
  mod.metalsBeforeSave("u1", null, "/w/build.sbt");
  expect(mod.metalsPausedBy("/w")).toBe("name-g");
});

test("saving a tab without guest text pauses nothing, and an allowed tab isn't paused again", () => {
  mod.metalsBeforeSave("clean", null, "/w/build.sbt");
  expect(mod.metalsPausedBy("/w")).toBeNull();
  mod.noteGuestChange("g", null, "tab:u1");
  mod.metalsBeforeSave("u1", null, "/w/build.sbt");
  mod.resumeMetals("/w", mod.metalsChangeCount());
  mod.metalsBeforeSave("u1", "/w/build.sbt", "/w/build.sbt");
  expect(mod.metalsPausedBy("/w")).toBeNull();
});

test("Save As of a paused project's file pauses the target folder too", () => {
  mod.noteGuestChange("g", "/p", "build.sbt");
  mod.metalsBeforeSave("t1", "/p/build.sbt", "/other/build.sbt");
  expect(mod.metalsPausedBy("/other")).toBe("name-g");
});

test("a guest with run doesn't pause Metals through a tab", () => {
  mod.noteGuestChange("trusted", null, "tab:u1");
  mod.metalsBeforeSave("u1", null, "/w/build.sbt");
  expect(mod.metalsPausedBy("/w")).toBeNull();
});
