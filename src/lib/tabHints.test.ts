// #38: tabs of files with the same name get a hint from their parent folders.
import { expect, test } from "vitest";
import { tabHints } from "./tabHints";

const tab = (path: string | null, name = path ? path.split("/").pop()! : "Untitled") => ({ name, path });

test("unique names get no hint", () => {
  expect(tabHints([tab("/p/a.txt"), tab("/p/b.txt"), tab(null)])).toEqual(["", "", ""]);
});

test("the shortest distinguishing parent folder", () => {
  expect(tabHints([tab("/p/ext-created.txt"), tab("/p/sub/ext-created.txt"), tab("/p/x.txt")])).toEqual(["p", "sub", ""]);
});

test("more folders when the nearest parent is the same", () => {
  expect(tabHints([tab("/p/a/src/main.rs"), tab("/p/b/src/main.rs")])).toEqual(["a/src", "b/src"]);
});

test("three clashing tabs", () => {
  expect(tabHints([tab("/p/a/x.ts"), tab("/p/b/x.ts"), tab("/q/b/x.ts")])).toEqual(["a", "p/b", "q/b"]);
});

test("untitled tabs with the same name stay without hint", () => {
  expect(tabHints([tab(null, "Untitled"), tab(null, "Untitled")])).toEqual(["", ""]);
});
