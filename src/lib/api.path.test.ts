import { describe, expect, test } from "vitest";
import { basename, dirname, extname, isAbsolute, isRoot, joinPath, normPath } from "./api";

describe("path helpers", () => {
  test("basename", () => {
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("/a/b/")).toBe("b");
    expect(basename("C:/Users")).toBe("Users");
    expect(basename("file")).toBe("file");
    expect(basename("/")).toBe("/");
  });

  test("dirname", () => {
    expect(dirname("/a/b/c.txt")).toBe("/a/b");
    expect(dirname("/a/b/")).toBe("/a");
    expect(dirname("/a")).toBe("/");
    expect(dirname("C:/Users/me")).toBe("C:/Users");
    expect(dirname("C:/Users")).toBe("C:/");
  });

  test("joinPath", () => {
    expect(joinPath("/a", "b")).toBe("/a/b");
    expect(joinPath("/", "b")).toBe("/b");
    expect(joinPath("C:/", "x")).toBe("C:/x");
  });

  test("extname (lowercase, no dotfiles)", () => {
    expect(extname("/a/B.MD")).toBe("md");
    expect(extname("/a/archive.tar.gz")).toBe("gz");
    expect(extname("/a/.gitignore")).toBe("");
    expect(extname("/a/Makefile")).toBe("");
    expect(extname("/a.d/file")).toBe("");
  });

  test("isRoot", () => {
    expect(isRoot("/")).toBe(true);
    expect(isRoot("C:/")).toBe(true);
    expect(isRoot("C:")).toBe(true);
    expect(isRoot("/a")).toBe(false);
    expect(isRoot("C:/a")).toBe(false);
  });

  test("isAbsolute / normPath", () => {
    expect(isAbsolute("/x")).toBe(true);
    expect(isAbsolute("C:\\x")).toBe(true);
    expect(isAbsolute("x/y")).toBe(false);
    expect(normPath("C:\\a\\b")).toBe("C:/a/b");
    expect(normPath("\\\\server\\share")).toBe("//server/share");
    expect(normPath("/a\\b")).toBe("/a\\b");
  });
});
