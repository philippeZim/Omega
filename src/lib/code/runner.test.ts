import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
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

const { runner, refreshProject, runAction, createProject } = await import("./runner.svelte");

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

test("a guest's Edit Run command stores nothing and says where it is set", async () => {
  const { editRunCommand, runnerRemote } = await import("./runner.svelte");
  const { ui } = await import("../ui.svelte");
  const set = vi.spyOn(Storage.prototype, "setItem");
  runner.project = { kind: "cmake", root: "collab:", label: "x", run: { id: "run", label: "Run", cmd: "on host" }, build: null, test: null, more: [], needs: [] };
  runnerRemote.project = () => runner.project;
  await editRunCommand();
  runnerRemote.project = null;
  expect(ui.prompt).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  expect(ui.toast).toHaveBeenCalled();
  set.mockRestore();
});

test("New Project stays closed during a guest session", async () => {
  const { openNewProject } = await import("./runner.svelte");
  const { guestGuard } = await import("../collab/guard");
  runner.newProject = false;
  guestGuard.status = () => "connected";
  openNewProject();
  guestGuard.status = () => "none";
  expect(runner.newProject).toBe(false);
  openNewProject();
  expect(runner.newProject).toBe(true);
  runner.newProject = false;
});

describe("New Project when the user becomes a guest meanwhile", () => {
  const tpl = { id: "tool", marker: "marker", open: ["main.py"], needs: [], create: async () => ({ files: { a: "1" }, cmds: ["scaffold"] }) };
  const setup = async (flipOn: string) => {
    const { TEMPLATES } = await import("./projects");
    const { guestGuard } = await import("../collab/guard");
    const { ui } = await import("../ui.svelte");
    const state = await import("../state.svelte");
    (TEMPLATES as unknown[]).splice(0, TEMPLATES.length, tpl, { id: "empty", marker: "", open: [], needs: [] });
    for (const f of [ui.toast, state.setRoot, state.openFile, state.setMode]) vi.mocked(f).mockClear();
    h.runCommand.mockReset();
    mockIPC((cmd) => {
      if (cmd === flipOn) guestGuard.status = () => "connected";
      return cmd === "path_exists" ? false : null;
    });
    return { guestGuard, ui, state };
  };

  test.each(["tool", "empty"])("template %s: files stay, nothing opens, one message", async (id) => {
    const { guestGuard, ui, state } = await setup("create_dir");
    await createProject(id, "/home/me", "proj");
    guestGuard.status = () => "none";
    expect(state.setRoot).not.toHaveBeenCalled();
    expect(state.setMode).not.toHaveBeenCalled();
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledTimes(1);
  });

  test("stops waiting for the project file as soon as the user is a guest", async () => {
    const { guestGuard, ui, state } = await setup("none");
    h.runCommand.mockImplementation(() => void (guestGuard.status = () => "connected"));
    await createProject("tool", "/home/me", "proj"); // would poll for 2 minutes
    guestGuard.status = () => "none";
    expect(state.setRoot).not.toHaveBeenCalled();
    expect(state.openFile).not.toHaveBeenCalled();
    expect(ui.toast).toHaveBeenCalledTimes(1);
  });
});
