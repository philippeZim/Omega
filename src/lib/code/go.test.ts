import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { getIndentation, indentUnit } from "@codemirror/language";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
const ipc = vi.hoisted(() => ({
  calls: [] as string[],
  sent: [] as string[],
  builds: [] as string[][],
  which: {} as Record<string, string>,
  onWhich: null as null | (() => void),
  onBuild: null as null | (() => void),
  holdBuild: null as null | Promise<void>,
  buildId: "",
  buildCode: 0,
  killed: [] as string[],
  spawned: [] as string[],
}));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, a?: { cmd?: string; args?: string[]; msg?: string; kind?: string }) => {
    ipc.calls.push(cmd);
    if (cmd === "proc_send") ipc.sent.push(a!.msg!);
    if (cmd === "tools_dir") return "/tools";
    if (cmd === "install_debugger" && a?.kind === "delve") ipc.which["/tools/go-tools/bin/dlv"] = "/tools/go-tools/bin/dlv";
    if (cmd === "lang_workdir") return "/private/s/bin";
    if (cmd === "lang_copy") return `/private/s/${(a as unknown as { part: string }).part}/${(a as unknown as { name: string }).name}`;
    if (cmd === "proc_spawn") ipc.spawned.push(a!.cmd!);
    if (cmd === "proc_kill") ipc.killed.push((a as { id: string }).id);
    if (cmd === "run_killable") {
      ipc.builds.push([a!.cmd!, ...a!.args!]);
      ipc.buildId = (a as { id: string }).id;
      ipc.onBuild?.();
      if (ipc.holdBuild) await ipc.holdBuild;
      return { code: ipc.killed.includes(ipc.buildId) ? -1 : ipc.buildCode, stdout: "", stderr: "build output" };
    }
    if (cmd !== "which_cmd") return null;
    const hook = ipc.onWhich;
    ipc.onWhich = null;
    hook?.();
    return ipc.which[a!.cmd!] ?? null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("../tools.svelte", async (orig) => ({ ...(await orig<typeof import("../tools.svelte")>()), ensureTools: async () => true }));
vi.mock("../platform", async (orig) => ({ ...(await orig<typeof import("../platform")>()), tmpPath: async (n: string) => `/tmp/${n}` }));

const disk = new Map<string, string>();
vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>();
  return {
    ...real,
    fsApi: {
      exists: async (p: string) => disk.has(p) || [...disk.keys()].some((k) => k.startsWith(`${p}/`)),
      readFile: async (p: string) => {
        if (!disk.has(p)) throw new Error("missing");
        return disk.get(p)!;
      },
      listDir: async (dir: string) => {
        const names = new Map<string, boolean>();
        for (const k of disk.keys()) {
          if (!k.startsWith(`${dir}/`)) continue;
          const [name, ...rest] = k.slice(dir.length + 1).split("/");
          names.set(name, rest.length > 0);
        }
        return [...names].map(([name, is_dir]) => ({ name, is_dir, path: `${dir}/${name}` }));
      },
    },
  };
});

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { modeForPath } from "../modes";
import { LANGUAGES, indentFor, langFor } from "./languages";
import { detectProject, runsAlone, TEMPLATES } from "./projects";
import { lspCopyName, overrideRun, runCopyName } from "./langRun";
import { goLocal, goModuleName, goPackageName, goPatterns, goRunTarget, goWorkUses } from "./go";
import { setLanguageOverride } from "./langOverride.svelte";
import { allClients, clientFor, lspState, neverInstall, restartServer, stopServers } from "./lsp.svelte";
import { noteGuestChange, metalsChangeCount, metalsPausedBy, moveGuestChange, resumeCompiling, resumeMetals, resumeTool, toolChangeCount, toolPausedBy, toolsBeforeSave } from "../collab/guestChanges";
import { planFor } from "../debug/adapters";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

const MAIN = "package main\n\nfunc main() {}\n";
const release = (root: string) => {
  for (const tool of ["gopls", "ocaml"] as const) resumeTool(tool, root, toolChangeCount(tool));
  resumeMetals(root, metalsChangeCount());
  resumeCompiling("", root);
};

beforeEach(() => {
  disk.clear();
  ipc.calls.length = ipc.sent.length = ipc.builds.length = ipc.killed.length = ipc.spawned.length = 0;
  ipc.holdBuild = null;
  ipc.buildCode = 0;
  ipc.which = {};
  ipc.onWhich = ipc.onBuild = null;
});
afterEach(() => vi.restoreAllMocks());

describe("Go files", () => {
  test.each(["main.go", "go.mod", "go.sum", "go.work", "go.work.sum"])("%s opens in Code mode as Go", (name) => {
    expect(langFor(`/w/${name}`)?.id).toBe("go");
    expect(modeForPath(`/w/${name}`)).toBe("code");
  });

  test("gopls gets the language id it parses by; go.sum has no server", () => {
    expect(langFor("/w/a.go")).toMatchObject({ lspId: "go", server: "go" });
    expect(langFor("/w/go.mod")).toMatchObject({ lspId: "go.mod", server: "go" });
    expect(langFor("/w/go.work")).toMatchObject({ lspId: "go.work", server: "go" });
    expect(langFor("/w/go.sum")?.server).toBeNull();
  });

  test("Go is in the picker", () => {
    expect(LANGUAGES.find((l) => l.id === "go")).toMatchObject({ label: "Go", lspId: "go" });
  });

  test("indents with tabs, also in a file that has spaces", () => {
    const state = EditorState.create({ doc: "func a() {\n    b()\n    c()\n}\n", extensions: [langFor("/w/a.go")!.ext(), indentFor(langFor("/w/a.go"))] });
    expect(state.facet(indentUnit)).toBe("\t");
    expect(getIndentation(state, state.doc.line(2).from)).toBe(state.tabSize);
  });
});

describe("Go helpers", () => {
  test("the package clause ignores comments", () => {
    expect(goPackageName("// package nope\n/* package no\n*/\npackage main\n")).toBe("main");
    expect(goPackageName("// only\n")).toBeNull();
  });

  test("go.work: folders inside it, single and in a block", () => {
    expect(goWorkUses('go 1.26\n\nuse ./a\nuse (\n\t./b // x\n\t"./c"\n\t../out\n\t/abs\n)\n')).toEqual(["a", "b", "c"]);
  });

  test("module names are valid", () => {
    expect(goModuleName("My App!")).toBe("my-app");
    expect(goModuleName("---")).toBe("app");
  });

  test("the toolchain setting works in both shells", () => {
    expect(goLocal(false)).toBe("GOTOOLCHAIN=local ");
    expect(goLocal(true)).toBe('set "GOTOOLCHAIN=local"&& ');
  });
});

describe("Go projects", () => {
  test("a module gets Run, Build and Test", async () => {
    disk.set("/m/go.mod", "module m\n");
    disk.set("/m/main.go", MAIN);
    const p = (await detectProject("/m/main.go", "/m"))!;
    expect(p).toMatchObject({ kind: "go", root: "/m", needs: ["go"] });
    expect(p.run?.cmd).toBe("go run .");
    expect(p.build?.cmd).toBe("go build ./...");
    expect(p.test?.cmd).toBe("go test ./...");
    expect(p.more.map((a) => a.id)).toEqual(expect.arrayContaining(["vet", "fmt", "tidy", "add", "clean"]));
  });

  test("runs the main package of the open file", async () => {
    disk.set("/m/go.mod", "module m\n");
    disk.set("/m/cmd/a/main.go", MAIN);
    disk.set("/m/cmd/b/main.go", MAIN);
    expect((await detectProject("/m/cmd/b/main.go", "/m"))!.run?.cmd).toBe("go run ./cmd/b");
  });

  test("a library file runs the module's command, a pure library has no Run", async () => {
    disk.set("/m/go.mod", "module m\n");
    disk.set("/m/lib/l.go", "package lib\n");
    expect((await detectProject("/m/lib/l.go", "/m"))!.run).toBeNull();
    disk.set("/m/cmd/app/main.go", MAIN);
    expect((await detectProject("/m/lib/l.go", "/m"))!.run?.cmd).toBe("go run ./cmd/app");
  });

  test("a build-ignored generator isn't taken for the program", async () => {
    disk.set("/m/go.mod", "module m\n");
    disk.set("/m/gen.go", "//go:build ignore\n\npackage main\n\nfunc main() {}\n");
    disk.set("/m/lib.go", "package m\n");
    expect(await goRunTarget("/m", "/m/lib.go")).toBeNull();
  });

  test("a workspace root builds the modules it names", async () => {
    disk.set("/w/go.work", "go 1.26\n\nuse (\n\t./a\n\t./b\n)\n");
    disk.set("/w/a/go.mod", "module a\n");
    disk.set("/w/a/main.go", MAIN);
    disk.set("/w/b/go.mod", "module b\n");
    expect(await goPatterns("/w")).toBe("./a/... ./b/...");
    expect(await goRunTarget("/w", null)).toBe("./a");
    expect((await detectProject("/w/a/main.go", "/w"))!.root).toBe("/w/a");
    expect((await detectProject("/w/go.work", "/w"))!.more.map((a) => a.id)).toContain("sync");
  });

  test("a Go file beats another project file in the same folder; other files keep theirs", async () => {
    disk.set("/m/go.mod", "module m\n");
    disk.set("/m/package.json", "{}");
    disk.set("/m/main.go", MAIN);
    disk.set("/m/web.ts", "");
    expect((await detectProject("/m/main.go", "/m"))!.kind).toBe("go");
    expect((await detectProject("/m/web.ts", "/m"))!.kind).toBe("pnpm");
  });

  test("the template makes a module with a runnable main", async () => {
    const tpl = TEMPLATES.find((x) => x.id === "go")!;
    const made = await tpl.create("My App");
    expect(made.cmds.at(-1)).toBe("go mod init my-app");
    expect(made.files!["main.go"]).toContain("package main");
    expect(tpl).toMatchObject({ marker: "go.mod", open: ["main.go"], needs: ["go"] });
  });
});

describe("A single Go file", () => {
  test("builds and runs on the local toolchain", async () => {
    disk.set("/f/a b.go", MAIN);
    const p = (await detectProject("/f/a b.go", "/f"))!;
    expect(p.kind).toBe("file");
    expect(p.run?.pre).toBe("GOTOOLCHAIN=local go build -o '/tmp/omega-a b' '/f/a b.go'");
    expect(p.test).toBeNull();
  });

  test("a test file runs its tests", async () => {
    disk.set("/f/a_test.go", "package a\n");
    const p = (await detectProject("/f/a_test.go", "/f"))!;
    expect(p.test?.cmd).toBe("GOTOOLCHAIN=local go test /f/a_test.go");
    expect(p.run?.cmd).toBe(p.test?.cmd);
  });

  test("go.sum on its own has nothing to run", async () => {
    disk.set("/f/go.sum", "");
    expect(await detectProject("/f/go.sum", "/f")).toBeNull();
  });
});

describe("A file set to Go by hand", () => {
  afterEach(() => void setLanguageOverride("/py/tool", null));

  test("gets a .go name for the compiler and the language server", () => {
    expect(runCopyName("go", "")).toBe("omega_main.go");
    expect(lspCopyName(langFor("/w/a.go")!, "")).toBe("omega_main.go");
  });

  test("builds in the private folder on the local toolchain", async () => {
    const r = (await overrideRun("go", "/py/tool", "tsx"))!;
    expect(r.pre).toBe("(cd /private/s/bin && GOTOOLCHAIN=local go build -o omega_out omega_main.go)");
    expect(r.cmd).toBe("/private/s/bin/omega_out");
    await r.prepare!();
    expect(ipc.calls).toContain("lang_copy");
  });

  test("runs alone, also inside a Go module", async () => {
    disk.set("/py/go.mod", "module m\n");
    disk.set("/py/tool", MAIN);
    await setLanguageOverride("/py/tool", "go");
    expect(await runsAlone("/py/tool", "/py")).toBe(true);
    const p = (await detectProject("/py/tool", "/py"))!;
    expect(p).toMatchObject({ kind: "file", isolated: true });
  });

  test("debugs its private copy, with breakpoints translated", async () => {
    disk.set("/py/pyproject.toml", "");
    disk.set("/py/tool", MAIN);
    ipc.which = { dlv: "/sw/dlv" };
    await setLanguageOverride("/py/tool", "go");
    const plan = await planFor({ file: "/py/tool", workspace: "/py", log: () => {}, askInstall: async () => true });
    expect(ipc.builds[0]).toEqual(["go", "build", "-gcflags=all=-N -l", "-o", "/private/s/bin/omega_dbg", "omega_main.go"]);
    expect(plan.shadow).toEqual({ file: "/py/tool", copy: "/private/s/bin/omega_main.go" });
    expect(plan.launch).toMatchObject({ mode: "exec", program: "/private/s/bin/omega_dbg", cwd: "/py" });
  });
});

describe("Debugging Go", () => {
  const ctx = (file = "/d/main.go") => ({ file, workspace: "/d", log: vi.fn(), askInstall: vi.fn(async () => true) });
  beforeEach(() => {
    disk.set("/d/go.mod", "module d\n");
    disk.set("/d/main.go", MAIN);
    ipc.which = { dlv: "/sw/dlv" };
  });
  afterEach(() => release("/d"));

  test("builds without optimisation and starts Delve's DAP server", async () => {
    const plan = await planFor(ctx());
    expect(ipc.builds[0]).toEqual(["go", "build", "-gcflags=all=-N -l", "-o", "/tmp/omega-dbg-go-main", "."]);
    expect(plan.adapter).toEqual({ kind: "tcp", cmd: "/sw/dlv", args: ["dap", "--listen=127.0.0.1:{port}"] });
    expect(plan.launch).toMatchObject({ type: "go", request: "launch", mode: "exec", program: "/tmp/omega-dbg-go-main", cwd: "/d" });
  });

  test("a test file is debugged as a test binary of its package", async () => {
    disk.set("/d/sub/a_test.go", "package sub\n");
    await planFor(ctx("/d/sub/a_test.go"));
    expect(ipc.builds[0]).toEqual(["go", "test", "-c", "-gcflags=all=-N -l", "-o", "/tmp/omega-dbg-go-a_test", "./sub"]);
  });

  test("a file outside a module is built on its own", async () => {
    disk.delete("/d/go.mod");
    await planFor(ctx());
    expect(ipc.builds[0].at(-1)).toBe("/d/main.go");
  });

  test("a module without a main package says so and builds nothing", async () => {
    disk.set("/d/main.go", "package lib\n");
    await expect(planFor(ctx())).rejects.toThrow(t("code.ad.goNoMain"));
    expect(ipc.builds).toEqual([]);
  });

  test("offers Delve when it is missing, and declining builds nothing", async () => {
    ipc.which = {};
    const c = ctx();
    c.askInstall.mockResolvedValue(false);
    await expect(planFor(c)).rejects.toThrow();
    expect(c.askInstall).toHaveBeenCalledWith("Delve");
    expect(ipc.builds).toEqual([]);
    await planFor(ctx());
    expect(ipc.calls).toContain("install_debugger");
  });

  test("a paused project shows the paused message and builds nothing", async () => {
    noteGuestChange("peer", "/d");
    await expect(planFor(ctx())).rejects.toThrow(t("code.lsp.goplsPaused"));
    expect(ipc.builds).toEqual([]);
  });

  test("a guest change kills the running build at once and says why", async () => {
    let finish = () => {};
    ipc.holdBuild = new Promise((r) => (finish = r));
    const outcome = expect(planFor(ctx())).rejects.toThrow(t("code.lsp.goplsPaused"));
    await vi.waitFor(() => expect(ipc.builds).toHaveLength(1));
    expect(ipc.killed).toEqual([]);
    noteGuestChange("peer", "/d");
    expect(ipc.killed).toEqual([ipc.buildId]);
    finish();
    await outcome;
  });

  test("a failed build shows its output, such as a newer go line", async () => {
    ipc.buildCode = 1;
    const c = ctx();
    await expect(planFor(c)).rejects.toThrow(t("code.ad.buildFailed"));
    expect(c.log).toHaveBeenCalledWith("build output", "error");
  });
});

// Loading a package runs gcc, ld and pkg-config on cgo code, which a guest could have written.
describe("gopls in Code Together", () => {
  const lang = langFor("/g/main.go")!;
  const spawned = () => ipc.spawned.length > 0;
  const running = () => allClients().filter((c) => c.kind === "go" && !c.stopping);
  let n = 0, root = "", file = "";

  beforeEach(() => {
    ipc.which = { gopls: "/sw/gopls" };
    root = `/g${++n}`;
    file = `${root}/main.go`;
    disk.set(`${root}/go.mod`, "module g\n");
    disk.set(file, MAIN);
  });
  afterEach(() => {
    release(root);
    stopServers("go");
  });

  const started = async () => {
    void clientFor(lang, file, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    return running()[0];
  };

  test("the host's own project starts it without asking", async () => {
    const confirm = vi.spyOn(ui, "confirm");
    await started();
    expect(ipc.spawned).toEqual(["/sw/gopls"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("one server at the go.work above the modules", async () => {
    disk.delete(`${root}/go.mod`);
    disk.set(`${root}/go.work`, "use ./a\n");
    disk.set(`${root}/a/go.mod`, "module a\n");
    void clientFor(lang, `${root}/a/x.go`, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    expect(running()[0].root).toBe(root);
  });

  test("a guest can't start it", async () => {
    expect(await clientFor(lang, file, root, neverInstall)).toBeNull();
    expect(spawned()).toBe(false);
  });

  test("the host can't start it by accident in a project a guest changed", async () => {
    noteGuestChange("peer", root);
    const ask = vi.fn(async () => true);
    expect(await clientFor(lang, file, root, ask)).toBeNull();
    expect(spawned()).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(lspState.status[`go|${root}`]).toBe("stopped");
    expect(lspState.message[`go|${root}`]).toBe(t("code.lsp.goplsPaused"));
  });

  test("a guest change during the install keeps it from starting", async () => {
    ipc.which = {};
    const ask = async () => {
      noteGuestChange("peer", root);
      ipc.which = { gopls: "/sw/gopls" };
      return true;
    };
    expect(await clientFor(lang, file, root, ask)).toBeNull();
    expect(ipc.calls).toContain("install_server");
    expect(spawned()).toBe(false);
  });

  test("a guest change while the command is looked up keeps it from starting", async () => {
    ipc.onWhich = () => noteGuestChange("peer", root);
    expect(await clientFor(lang, file, root, async () => true)).toBeNull();
    expect(spawned()).toBe(false);
  });

  test("a running server is killed at once, without a graceful stop", async () => {
    const c = await started();
    ipc.calls.length = 0;
    noteGuestChange("peer", root);
    expect(running()).toHaveLength(0);
    expect(ipc.calls).toContain("proc_kill");
    expect(ipc.calls).not.toContain("proc_send");
    expect(c.stopping).toBe(true);
  });

  test("the pause follows a move of the project", async () => {
    noteGuestChange("peer", root);
    moveGuestChange(root, `${root}-moved`);
    expect(toolPausedBy("gopls", `${root}-moved`)).not.toBeNull();
    release(`${root}-moved`);
  });

  test.each([
    ["with a folder", () => root],
    ["without a folder", () => null],
  ])("a guest's unsaved tab saved as go.mod (%s) stops it", async (_n, tabRoot) => {
    await started();
    noteGuestChange("peer", tabRoot(), "tab:g1");
    toolsBeforeSave("g1", null, `${root}/go.mod`);
    expect(running()).toHaveLength(0);
    expect(toolPausedBy("gopls", root)).not.toBeNull();
  });

  test("restart asks, then starts it, and leaves the other tools paused", async () => {
    noteGuestChange("peer", root);
    const confirm = vi.spyOn(ui, "confirm").mockResolvedValue(true);
    void restartServer(lang, file, root, async () => true);
    await vi.waitFor(() => expect(spawned()).toBe(true));
    expect(confirm).toHaveBeenCalledWith(t("code.lsp.goplsResumeTitle"), expect.any(String), t("code.lsp.goplsResumeOk"));
    expect(toolPausedBy("gopls", root)).toBeNull();
    expect(toolPausedBy("ocaml", root)).not.toBeNull();
    expect(metalsPausedBy(root)).not.toBeNull();
  });

  test("restart keeps the pause when the host declines", async () => {
    noteGuestChange("peer", root);
    vi.spyOn(ui, "confirm").mockResolvedValue(false);
    expect(await restartServer(lang, file, root, async () => true)).toBeNull();
    expect(spawned()).toBe(false);
    expect(toolPausedBy("gopls", root)).not.toBeNull();
  });

  test("a guest change during the restart dialog keeps the pause", async () => {
    noteGuestChange("peer", root);
    vi.spyOn(ui, "confirm").mockImplementation(async () => {
      noteGuestChange("peer", root);
      return true;
    });
    expect(await restartServer(lang, file, root, async () => true)).toBeNull();
    expect(spawned()).toBe(false);
    expect(toolPausedBy("gopls", root)).not.toBeNull();
  });
});
