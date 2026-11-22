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
  ensure: vi.fn(async () => true),
}));

vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn(), prompt: vi.fn() } }));
vi.mock("../tools.svelte", () => ({ ensureTools: () => h.ensure() }));
vi.mock("./versions", () => ({ versionSettings: async () => [] }));
vi.mock("../fsWatch.svelte", () => ({ onFilesChanged: (fn: (files: string[]) => void) => h.listeners.push(fn) }));
vi.mock("../terminal.svelte", () => ({ runCommand: h.runCommand, runTask: h.runTask, cancelTask: vi.fn(), interruptRun: vi.fn() }));
vi.mock("../state.svelte", () => ({
  app: { root: "/p", get tabs() { return h.tabs; } },
  activeTab: () => (h.tabs as { active?: boolean }[]).find((t) => t.active) ?? null,
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

const { runner, refreshProject, runAction, createProject, chooseVersion } = await import("./runner.svelte");
const { TEMPLATES } = await import("./projects");
const { ui } = await import("../ui.svelte");

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

describe("Code Together: an action run for a guest's file", () => {
  const project: Project = { kind: "file", root: "/p", label: "x", run: null, build: null, test: null, more: [], needs: [] };

  test("{file} is the guest's file, quoted, also with replacement patterns in its name", async () => {
    const { runGuestAction } = await import("./runner.svelte");
    for (const [file, quoted] of [
      ["/p/app.py", "/p/app.py"],
      ["/p/a b.py", "'/p/a b.py'"],
      ["/p/it's.py", `'/p/it'\\''s.py'`],
      ["/p/$(id).py", "'/p/$(id).py'"],
      ["/p/$&.py", "'/p/$&.py'"],
      ["/p/$'x.py", `'/p/$'\\''x.py'`],
    ]) {
      h.runCommand.mockClear();
      await runGuestAction({ id: "run", label: "Run", cmd: "python {file} --flag" }, project, file, { allowed: async () => true });
      expect(h.runCommand.mock.calls[0][0]).toBe(`python ${quoted} --flag`);
    }
  });

  test("the host keeps its focus and panel, through the build step too", async () => {
    const { runGuestAction } = await import("./runner.svelte");
    const allowed = async () => true;
    await runGuestAction({ id: "run", label: "Run", cmd: "./a" }, project, "/p/a.c", { allowed });
    expect(h.runCommand.mock.calls[0].slice(3)).toEqual([false, { background: true }]);
    await runGuestAction({ id: "run", label: "Run", cmd: "./a", pre: "cc a.c" }, project, "/p/a.c", { allowed });
    const [, , , , opts] = h.runTask.mock.calls[0];
    expect(opts).toMatchObject({ focus: false, background: true });
    opts.onExit(0);
    expect(h.runTask.mock.calls[1][4]).toEqual({ focus: false, background: true });
    h.runTask.mockClear();
    await runGuestAction({ id: "build", label: "Build", cmd: "make" }, project, null, { allowed });
    expect(h.runTask.mock.calls[0][4]).toEqual({ focus: false, background: true });
  });

  test("a package action for a guest stays in the background and is marked as a package task", async () => {
    const { runGuestAction } = await import("./runner.svelte");
    await runGuestAction({ id: "add", label: "Add", cmd: "uv add {}", ask: "x" }, { ...project, kind: "uv" }, null, { arg: "requests", allowed: async () => true });
    expect(h.runCommand.mock.calls[0][0]).toBe("uv add requests");
    expect(h.runCommand.mock.calls[0].slice(3)).toEqual([false, { packageTask: true, background: true }]);
  });

  test("the guest is checked after the tool prompt, and nothing starts if it's no longer allowed", async () => {
    const { runGuestAction } = await import("./runner.svelte");
    const order: string[] = [];
    h.ensure.mockImplementationOnce(async () => (order.push("tools"), true));
    await runGuestAction({ id: "run", label: "Run", cmd: "./a", pre: "cc a.c" }, project, "/p/a.c", { allowed: async () => (order.push("allowed"), false) });
    expect(order).toEqual(["tools", "allowed"]);
    expect(h.runTask).not.toHaveBeenCalled();
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  test("the host's own Run still takes the terminal and focus", async () => {
    await refreshProject();
    await runAction({ id: "x", label: "x", cmd: "echo x" });
    expect(h.runCommand.mock.calls[0]).toHaveLength(3);
  });

  test("a guest's refresh shows what's known and asks the host about its file", async () => {
    const { runnerRemote } = await import("./runner.svelte");
    const refresh = vi.fn();
    runnerRemote.project = () => project;
    runnerRemote.refresh = refresh;
    await refreshProject();
    runnerRemote.project = null;
    runnerRemote.refresh = null;
    expect(runner.project).toEqual(project);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("saving reports a tab of that file that stayed unsaved or was deleted", async () => {
    const { saveForGuestRun } = await import("./runner.svelte");
    h.tabs = [{ id: "a", path: "/p/a.py", dirty: true }];
    expect(await saveForGuestRun("/p/a.py")).toBe(true);
    expect(h.saved).toEqual(["a"]);
    h.tabs = [{ id: "b", path: "/p/b.py", dirty: false, deleted: true } as never];
    expect(await saveForGuestRun("/p/b.py")).toBe(false);
    expect(await saveForGuestRun(null)).toBe(true);
  });
});

test("names that can't be quoted safely for the Run terminal", async () => {
  const { quotablePath } = await import("../platform");
  for (const name of ["a b.py", "it's.py", "$(id).py", "ä.py", "a;b&c.py"]) expect(quotablePath(name, false)).toBe(true);
  for (const name of ["a\nb.py", "a\rb.py", "a\tb.py", "a\x03.py", "a\x7f.py", "a\x9b.py"]) expect(quotablePath(name, false)).toBe(false);
  expect(quotablePath("100%.py", false)).toBe(true);
  expect(quotablePath("100%.py", true)).toBe(false);
  expect(quotablePath('a".py', true)).toBe(false);
  expect(quotablePath("a!b.py", false)).toBe(true);
  expect(quotablePath("!PATH!.py", true)).toBe(false);
});

test("a command with a refused name starts nothing, not even its build step (#149)", async () => {
  const refused = "﷐"; // what q() returns on Windows for such a name
  await refreshProject();
  vi.mocked(ui.toast).mockClear();
  for (const a of [
    { id: "run", label: "Run", cmd: `app ${refused}`, pre: "cmake --build build" },
    { id: "run", label: "Run", cmd: "./app", pre: `cc ${refused}` },
    { id: "run", label: "Run", cmd: "./app", setup: { cmd: `cmake ${refused}`, unless: "build" } },
  ] as Action[]) await runAction(a);
  expect(h.runTask).not.toHaveBeenCalled();
  expect(h.runCommand).not.toHaveBeenCalled();
  expect(ui.toast).toHaveBeenCalledTimes(3);
  expect(vi.mocked(ui.toast).mock.calls[0][1]).toBe("error");
});

test("only actions tied to a file count as file-dependent", async () => {
  const { fileDependent } = await import("./runner.svelte");
  expect(fileDependent({ id: "run", label: "r", cmd: "uv run a.py", usesFile: true })).toBe(true);
  expect(fileDependent({ id: "run", label: "r", cmd: "python {file}" })).toBe(true);
  expect(fileDependent({ id: "build", label: "b", cmd: "cargo build" })).toBe(false);
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

test("a template isn't created inside a bare repository, because it would run git init there", async () => {
  const create = vi.fn(async () => ({ files: {}, cmds: ["git init -q"] }));
  TEMPLATES.push({ id: "bare-check", label: "T", tool: "t", needs: [], marker: "m", open: [], create } as never);
  const made: string[] = [];
  mockIPC((cmd, args) => {
    const a = args as { path: string };
    if (cmd === "path_exists") return false;
    if (cmd === "git_in_bare_repo") return a.path.startsWith("/bare/");
    if (cmd === "create_dir") made.push(a.path);
    return null;
  });
  vi.mocked(ui.toast).mockClear();
  try {
    await createProject("bare-check", "/bare", "x");
    expect(ui.toast).toHaveBeenCalledWith("This folder is a bare Git repository or inside one, so no new repository can be created here.", "error");
    expect(create).not.toHaveBeenCalled();
    expect(made).toEqual([]);
    expect(h.runCommand).not.toHaveBeenCalled();
  } finally {
    TEMPLATES.pop();
  }
});

describe("runAction with an argument checked for a Code Together guest", () => {
  const add = (over: Partial<Action> = {}): Action => ({ id: "add", label: "Add…", cmd: "uv add {}", ask: "Package", arg: async () => "--wrong", ...over });

  test("it goes in as it is, without a prompt on the host and without arg()", async () => {
    await refreshProject();
    vi.mocked(ui.prompt).mockClear();
    await runAction(add(), "'numpy>=1'");
    expect(ui.prompt).not.toHaveBeenCalled();
    expect(h.runCommand.mock.calls[0][0]).toBe("uv add 'numpy>=1'");
  });

  test("replacement patterns in it stay literal", async () => {
    await refreshProject();
    await runAction(add(), "$&$`$'");
    expect(h.runCommand.mock.calls[0][0]).toBe("uv add $&$`$'");
  });

  test("the host's own flow still prompts", async () => {
    await refreshProject();
    vi.mocked(ui.prompt).mockResolvedValueOnce("requests");
    await runAction(add({ arg: undefined }));
    expect(ui.prompt).toHaveBeenCalled();
    expect(h.runCommand.mock.calls[0][0]).toBe("uv add requests");
  });
});

describe("package actions on the host", () => {
  const add = (over: Partial<Action> = {}): Action => ({ id: "add", label: "Add…", cmd: "uv add {}", ask: "Package", ...over });

  test("a group name that fails validation stops with its message, nothing runs", async () => {
    await refreshProject();
    vi.mocked(ui.prompt).mockResolvedValueOnce("evil");
    vi.mocked(ui.toast).mockClear();
    await runAction(add({ arg: async () => { throw new Error("bad group"); } }));
    expect(ui.toast).toHaveBeenCalledWith("bad group", "error");
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  test("only package actions are marked as package tasks", async () => {
    await refreshProject();
    (runner.project as Project).kind = "uv";
    await runAction(add(), "requests");
    expect(h.runCommand.mock.calls[0][4]).toEqual({ packageTask: true });
    h.runCommand.mockReset();
    await runAction({ id: "fmt", label: "fmt", cmd: "uvx ruff format" });
    expect(h.runCommand.mock.calls[0][4]).toBeUndefined();
  });
});

describe("chooseVersion with a range from the project file", () => {
  const setting = (current: string) => ({ id: "node", label: "Node", current, chip: "Node", options: async () => [], apply: vi.fn(async (v: string) => `set ${v}`) });

  test.each([[" >=18 <21 ", ">=18 <21"], ["20  ||  22", "20 || 22"], [">=18\n<21", ">=18 <21"]])("picking the file's own value %j does nothing", async (current, returned) => {
    await refreshProject();
    const s = setting(current);
    vi.mocked(ui.prompt).mockResolvedValueOnce(returned);
    vi.mocked(ui.toast).mockClear();
    await chooseVersion(s);
    expect(s.apply).not.toHaveBeenCalled();
    expect(ui.toast).not.toHaveBeenCalled();
    expect(h.runCommand).not.toHaveBeenCalled();
  });

  test("a concrete version still applies", async () => {
    await refreshProject();
    const s = setting(">=18 <21");
    vi.mocked(ui.prompt).mockResolvedValueOnce("22");
    await chooseVersion(s);
    expect(s.apply).toHaveBeenCalledWith("22");
    expect(h.runCommand.mock.calls[0][0]).toBe("set 22");
  });
});

test("a large file: file-bound Run says why, project Run works without saving it (#174)", async () => {
  await refreshProject();
  const tab = { id: "big", path: "/p/big.py", dirty: true, large: true, active: true, name: "big.py" };
  (h.tabs as unknown[]).push(tab);
  try {
    vi.mocked(ui.toast).mockClear();
    h.runCommand.mockClear();
    h.runTask.mockClear();
    await runAction({ id: "run", label: "Run", cmd: "python {file}" } as Action);
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(h.runTask).not.toHaveBeenCalled();
    expect(vi.mocked(ui.toast).mock.calls[0][1]).toBe("error");
    expect(h.saved).not.toContain("big");
  } finally {
    (h.tabs as unknown[]).splice((h.tabs as unknown[]).indexOf(tab), 1);
  }
});

