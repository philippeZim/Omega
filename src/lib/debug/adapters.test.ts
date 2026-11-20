import { describe, expect, test, vi } from "vitest";

vi.mock("../code/lsp.svelte", () => ({ toolsDir: async () => "/tools", clientFor: async () => null, javaDebugBundles: async () => [] }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => {}, withInstallProgress: async () => {} }));
import { cmakeProgram } from "./adapters";

describe("cmakeProgram", () => {
  test("expands ${PROJECT_NAME} like Run does", () => {
    expect(cmakeProgram("/p/folder", "project(demo)\nadd_executable(${PROJECT_NAME} main.cpp)\n")).toBe("/p/folder/build/demo");
  });

  test("skips commented-out targets", () => {
    expect(cmakeProgram("/p/folder", "# add_executable(old main.cpp)\nadd_executable(app main.cpp)\n")).toBe("/p/folder/build/app");
  });

  test("falls back to the folder name", () => {
    expect(cmakeProgram("/p/folder", "")).toBe("/p/folder/build/folder");
  });
});
