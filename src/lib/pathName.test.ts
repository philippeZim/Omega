// #90: Rename must not move the file elsewhere through "../" or a path in the new name.
import { describe, expect, test } from "vitest";
import { renameTarget, validEntryName } from "./pathName";

describe("renameTarget (#90)", () => {
  test("plain names stay in the same folder", () => {
    expect(renameTarget("/p/sub/a.txt", "b.txt")).toBe("/p/sub/b.txt");
    expect(renameTarget("/p/sub/a.txt", ".env")).toBe("/p/sub/.env");
    expect(renameTarget("/p/sub/a.txt", "a..b")).toBe("/p/sub/a..b");
  });
  test("names that leave the folder or contain a path are rejected", () => {
    for (const n of ["../../escape.txt", "../x", "..", ".", "", "x/y", "x\\y", "/abs", "x/"]) {
      expect(renameTarget("/p/sub/a.txt", n), n).toBeNull();
    }
  });
});

describe("validEntryName", () => {
  test("nested names are allowed only when asked for", () => {
    expect(validEntryName("sub/x.txt")).toBe(false);
    expect(validEntryName("sub/x.txt", true)).toBe(true);
    expect(validEntryName("sub/../x.txt", true)).toBe(false);
    expect(validEntryName("/x.txt", true)).toBe(false);
  });
});
