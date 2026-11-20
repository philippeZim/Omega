import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Action, Project } from "./projects";

const h = vi.hoisted(() => ({
  target: "app",
  saved: [] as string[],
  tabs: [] as { id: string; path: string; dirty: boolean }[],
  listeners: [] as ((files: string[]) => void)[],
  runTask: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn(), prompt: vi.fn() } }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true }));
vi.mock("./versions", () => ({ versionSettings: async () => [] }));
vi.mock("../fsWatch.svelte", () => ({ onFilesChanged: (fn: (files: string[]) => void) => h.listeners.push(fn) }));
vi.mock("../terminal.svelte", () => ({ runCommand: h.runCommand, runTask: h.runTask, cancelTask: vi.fn(), interruptRun: vi.fn() }));
vi.mock("../state.svelte", () => ({
  app: { root: "/p", get tabs() { return h.tabs; } },
  activeTab: () => null,
  save: async (id: string) => {
    h.saved.push(id);
    for (const t of h.tabs) if (t.id === id) t.dirty = false;
    // Saving CMakeLists.txt renames the executable.
    h.target = "app2";
  },
  setRoot: vi.fn(),
  openFile: vi.fn(),
  setMode: vi.fn(),
}));
vi.mock("./projects", () => ({
  TEMPLATES: [],
  detectProject: async (): Promise<Project> => {
    const run: Action = { id: "run", label: "Run", cmd: `./build/${h.target}`, pre: "cmake --build build" };
    return { kind: "cmake", root: "/p", label: "CMake", run, build: { id: "build", label: "Build", cmd: "cmake --build build" }, test: null, more: [{ id: "x", label: "x", cmd: "echo x" }], needs: [] };
  },
}));

const { runner, refreshProject, runAction } = await import("./runner.svelte");

beforeEach(() => {
  h.target = "app";
  h.saved = [];
  h.tabs = [];
  h.runTask.mockReset();
  h.runCommand.mockReset();
});

describe("runAction uses the project as saved (#79)", () => {
  test("Run after saving CMakeLists.txt starts the renamed executable", async () => {
    await refreshProject();
    expect(runner.project?.run?.cmd).toBe("./build/app");
    h.tabs = [{ id: "cm", path: "/p/CMakeLists.txt", dirty: true }];
    await runAction(runner.project?.run);
    expect(h.saved).toEqual(["cm"]);
    expect(runner.project?.run?.cmd).toBe("./build/app2");
    const [slot, , , , opts] = h.runTask.mock.calls[0];
    expect(slot).toBe("build");
    opts.onExit(0);
    expect(h.runTask.mock.calls[1].slice(0, 2)).toEqual(["run", "./build/app2"]);
  });

  test("a changed project file on disk refreshes the project", async () => {
    await refreshProject();
    h.target = "app3";
    for (const fn of h.listeners) fn(["/p/src/main.c"]);
    await Promise.resolve();
    expect(runner.project?.run?.cmd).toBe("./build/app");
    for (const fn of h.listeners) fn(["/p/CMakeLists.txt"]);
    await vi.waitFor(() => expect(runner.project?.run?.cmd).toBe("./build/app3"));
  });

  test("other actions run as given", async () => {
    await refreshProject();
    await runAction({ id: "x", label: "x", cmd: "echo x" });
    expect(h.runCommand.mock.calls[0][0]).toBe("echo x");
  });
});
