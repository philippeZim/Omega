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
    if (cmd === "install_debugger" && a?.kind === "earlybird") ipc.which.ocamlearlybird = "/sw/bin/ocamlearlybird";
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
import { modeForExtension } from "../modes";
import { indentFor, langFor, ocamlOpensBlock } from "./languages";
import { detectProject, TEMPLATES } from "./projects";
import { duneExecutables, duneProjectIssue, duneSourcePath, duneTarget, findDuneExecutables, parseSexps, pickExecutable, sameToolchain } from "./dune";
import { allClients, clientFor, lspState, neverInstall, restartServer, stopServers } from "./lsp.svelte";
import { noteGuestChange, resumeCompiling, resumeMetals, metalsChangeCount, metalsPausedBy, resumeTool, toolChangeCount, toolPausedBy, toolsBeforeSave } from "../collab/guestChanges";
import { planFor } from "../debug/adapters";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

const GOOD_PROJECT = "(lang dune 3.7)\n(map_workspace_root false)\n";
const BYTE_EXE = "(executable\n (name main)\n (modes byte exe))\n";

beforeEach(() => {
  disk.clear();
  ipc.calls.length = ipc.sent.length = ipc.builds.length = ipc.killed.length = 0;
  ipc.holdBuild = null;
  ipc.buildCode = 0;
  ipc.which = {};
  ipc.onWhich = ipc.onBuild = null;
});
afterEach(() => vi.restoreAllMocks());

describe("OCaml files", () => {
  test.each(["ml", "mli"])(".%s opens in Code mode with ocamllsp", (ext) => {
    expect(modeForExtension(ext)).toBe("code");
    expect(langFor(`a.${ext}`)).toMatchObject({ id: "ocaml", label: "OCaml", server: "ocaml" });
  });

  test("an interface is sent as one, or ocamllsp parses it as an implementation", () => {
    expect(langFor("a.ml")!.lspId).toBe("ocaml");
    expect(langFor("a.mli")!.lspId).toBe("ocaml.interface");
  });

  test.each(["let f x =", "| Some y ->", "match x with", "if a then", "else", "begin", "module M = struct", "fun x ->", "let x = (* note *) 1 =", "for i = 0 to 3 do", "try"])("%s opens a block", (l) => {
    expect(ocamlOpensBlock(l)).toBe(true);
  });

  test.each(["let a = 1", 'print_endline "x ="', "a >= b", "a <= b", "x <> y", "end", "done", "let c = '='"])("%s does not", (l) => {
    expect(ocamlOpensBlock(l)).toBe(false);
  });

  test("indents two spaces after an opener and keeps the indent otherwise", () => {
    const after = (text: string) => {
      const lang = langFor("a.ml")!;
      const state = EditorState.create({ doc: `${text}\n`, extensions: [lang.ext(), indentFor(lang)] });
      return { indent: getIndentation(state, state.doc.length), unit: state.facet(indentUnit) };
    };
    expect(after("let f x =")).toEqual({ indent: 2, unit: "  " });
    expect(after("let f x =\n  let y = 1 in").indent).toBe(2);
  });
});

describe("dune files", () => {
  test("reads comments, strings and nested lists", () => {
    expect(parseSexps('; c\n(a "b c" (d)) #;(gone) #| block |# e')).toEqual([["a", "b c", ["d"]], "e"]);
  });

  test.each(["(a", "a)", '(a "b', "#| open"])("%s is not readable", (s) => {
    expect(parseSexps(s)).toBeNull();
  });

  test("a dune file in OCaml syntax is left alone", () => {
    expect(parseSexps("(* -*- tuareg -*- *)\nlet () = ()")).toBeNull();
    expect(duneExecutables('(* -*- tuareg -*- *)\nlet () = Jbuild_plugin.V1.send "(executable (name x))"', "")).toEqual([]);
  });

  test.each([
    ["(executable (name m) (modes byte exe))", true],
    ["(executable (name m) (modes byte))", true],
    ["(executable (name m))", false],
    ["(executable (name m) (modes exe))", false],
    ["(executable (name m) (modes (byte exe)))", false], // links to m.bc.exe, no m.bc
    ["(executable (name m) (modes :standard byte))", true],
    ["(executable (name m) (modes byte \\ byte))", false],
    ["(executable (name m) (modes :standard \\ byte))", false],
  ])("%s: bytecode target %s", (text, byte) => {
    expect(duneExecutables(text, "bin")).toEqual([{ dir: "bin", name: "m", byte }]);
  });

  test("names several executables, ignores other stanzas", () => {
    const list = duneExecutables("(library (name l))\n(executables (names a b) (modes byte))", "x");
    expect(list.map((e) => e.name)).toEqual(["a", "b"]);
  });

  test.each([
    ["(lang dune 3.7)\n(map_workspace_root false)", null],
    ["(lang dune 3.25)\n(map_workspace_root false)", null],
    ["(lang dune 4.0)\n(map_workspace_root false)", null],
    ["(lang dune 3.7)", "map"],
    ["(lang dune 3.7)\n(map_workspace_root true)", "map"],
    ["(lang dune 3.6)\n(map_workspace_root false)", "lang"],
    ["(lang dune 2.9)", "lang"],
    ["", "lang"],
  ])("project %j: %s", (text, issue) => {
    expect(duneProjectIssue(text)).toBe(issue);
  });

  test("finds executables and skips build output", async () => {
    disk.set("/p/bin/dune", BYTE_EXE);
    disk.set("/p/_build/default/bin/dune", "(executable (name stale))");
    disk.set("/p/.hidden/dune", "(executable (name hidden))");
    expect((await findDuneExecutables("/p")).map((e) => e.name)).toEqual(["main"]);
  });

  test("picks the executable of the open file", () => {
    const exes = [{ dir: "a", name: "one", byte: true }, { dir: "b", name: "two", byte: true }, { dir: "b", name: "three", byte: true }];
    expect(pickExecutable(exes, "/p/b/three.ml", "/p")?.name).toBe("three");
    expect(pickExecutable(exes, "/p/b/three.mli", "/p")?.name).toBe("three");
    expect(pickExecutable(exes, "/p/b/lib.ml", "/p")?.name).toBe("two");
    expect(pickExecutable(exes, "/p/c/x.ml", "/p")?.name).toBe("one");
    expect(pickExecutable([], "/p/x.ml", "/p")).toBeNull();
  });

  test("targets are relative to the project root", () => {
    expect(duneTarget({ dir: "bin", name: "main", byte: true }, "bc")).toBe("./bin/main.bc");
    expect(duneTarget({ dir: "", name: "main", byte: true }, "exe")).toBe("./main.exe");
  });

  test("the debugger must come from the compiler's installation", () => {
    expect(sameToolchain("/sw/bin/ocamlearlybird", "/sw/bin/ocamlc")).toBe(true);
    expect(sameToolchain("/other/bin/ocamlearlybird", "/sw/bin/ocamlc")).toBe(false);
    expect(sameToolchain("/sw/bin/ocamlearlybird", null)).toBe(false);
  });
});

describe("dune projects", () => {
  test("Run stays native, Build and Test go through dune", async () => {
    disk.set("/p/dune-project", GOOD_PROJECT);
    disk.set("/p/bin/dune", BYTE_EXE);
    disk.set("/p/bin/main.ml", "");
    const p = (await detectProject("/p/bin/main.ml", "/p"))!;
    expect(p).toMatchObject({ kind: "dune", root: "/p", needs: ["ocaml"] });
    expect(p.run!.cmd).toContain("dune exec");
    expect(p.run!.cmd).toContain("./bin/main.exe");
    expect(p.run!.cmd).not.toContain(".bc");
    expect(p.build!.cmd).toBe("dune build");
    expect(p.test!.cmd).toBe("dune test");
  });

  test("the build root is the outermost dune project", async () => {
    disk.set("/w/dune-project", GOOD_PROJECT);
    disk.set("/w/sub/dune-project", GOOD_PROJECT);
    disk.set("/w/sub/bin/dune", BYTE_EXE);
    expect((await detectProject("/w/sub/bin/main.ml", "/w"))!.root).toBe("/w");
  });

  test("a dune project with a package.json stays on dune", async () => {
    disk.set("/p/dune-project", GOOD_PROJECT);
    disk.set("/p/package.json", "{}");
    expect((await detectProject("/p/a.ml", "/p"))!.kind).toBe("dune");
  });

  test("a project without an executable has no Run", async () => {
    disk.set("/p/dune-project", GOOD_PROJECT);
    disk.set("/p/lib/dune", "(library (name l))");
    expect((await detectProject("/p/lib/l.ml", "/p"))!.run).toBeNull();
  });

  test("a lone .ml runs with the toplevel, a lone .mli doesn't run", async () => {
    disk.set("/x/a.ml", "");
    expect((await detectProject("/x/a.ml", "/x"))!.run!.cmd).toMatch(/^ocaml /);
    expect(await detectProject("/x/a.mli", "/x")).toBeNull();
  });

  test("the template can be debugged and creates the build config for ocamllsp", async () => {
    const tpl = TEMPLATES.find((x) => x.id === "ocaml")!;
    expect(tpl).toMatchObject({ marker: "dune-project", open: ["bin/main.ml"], needs: ["ocaml"] });
    const plan = await tpl.create("demo");
    expect(Object.keys(plan.files!)[0]).toBe("dune-project");
    expect(duneProjectIssue(plan.files!["dune-project"])).toBeNull();
    expect(duneExecutables(plan.files!["bin/dune"], "bin")).toEqual([{ dir: "bin", name: "main", byte: true }]);
    expect(plan.cmds.at(-1)).toBe("dune build");
  });
});

describe("Omega's own OCaml comes first", () => {
  const BIN = "/tools/ocaml/root/omega/bin";
  const ctx = { file: "/d/bin/main.ml", workspace: "/d", log() {}, askInstall: async () => true };

  beforeEach(() => {
    disk.set("/d/dune-project", GOOD_PROJECT);
    disk.set("/d/bin/dune", BYTE_EXE);
    disk.set("/d/bin/main.ml", "");
    // A system OCaml is found first on the PATH.
    ipc.which = { dune: "/usr/bin/dune", ocamlc: "/usr/bin/ocamlc", ocamlearlybird: "/usr/bin/ocamlearlybird", ocamllsp: "/usr/bin/ocamllsp" };
  });
  const managed = () => {
    Object.assign(ipc.which, { "/tools/ocaml/run": "/tools/ocaml/run", [`${BIN}/dune`]: `${BIN}/dune`, [`${BIN}/ocamlc`]: `${BIN}/ocamlc`, [`${BIN}/ocamlearlybird`]: `${BIN}/ocamlearlybird`, [`${BIN}/ocamllsp`]: `${BIN}/ocamllsp` });
  };

  test("Run, Build and Test go through its launcher", async () => {
    managed();
    const p = (await detectProject("/d/bin/main.ml", "/d"))!;
    expect(p.run!.cmd).toBe("/tools/ocaml/run dune exec ./bin/main.exe");
    expect(p.build!.cmd).toBe("/tools/ocaml/run dune build");
    expect(p.test!.cmd).toBe("/tools/ocaml/run dune test");
  });

  test("a system OCaml stays usable without a managed one", async () => {
    const p = (await detectProject("/d/bin/main.ml", "/d"))!;
    expect(p.run!.cmd).toBe("dune exec ./bin/main.exe");
    const plan = await planFor(ctx);
    expect(ipc.builds).toEqual([["dune", "build", "./bin/main.bc"]]);
    expect(plan.adapter).toMatchObject({ cmd: "/usr/bin/ocamlearlybird" });
    expect(plan.launch.env).toBeUndefined();
  });

  test("debugging uses its dune and Earlybird and clears another switch for the program", async () => {
    managed();
    const plan = await planFor(ctx);
    expect(ipc.builds).toEqual([[`${BIN}/dune`, "build", "./bin/main.bc"]]);
    expect(plan.adapter).toMatchObject({ cmd: `${BIN}/ocamlearlybird` });
    expect(plan.launch.env).toMatchObject({ CAML_LD_LIBRARY_PATH: null, OCAMLPATH: null });
  });

  test("a system Earlybird doesn't stand in for a missing managed one", async () => {
    managed();
    delete ipc.which[`${BIN}/ocamlearlybird`];
    const ask = vi.fn(async () => false);
    await expect(planFor({ ...ctx, askInstall: ask })).rejects.toThrow();
    expect(ask).toHaveBeenCalledWith("Earlybird");
    expect(ipc.builds).toEqual([]);
  });

  test("the language server is its ocamllsp", async () => {
    managed();
    const c = clientFor(langFor("/d/bin/main.ml")!, "/d/bin/main.ml", "/d", async () => true);
    await vi.waitFor(() => expect(allClients().some((x) => x.kind === "ocaml")).toBe(true));
    expect(ipc.spawned.at(-1)).toBe(`${BIN}/ocamllsp`);
    stopServers("ocaml");
    void c.catch(() => {});
  });
});

describe("Debugging OCaml", () => {
  const ctx = (ask = async () => true) => ({ file: "/d/bin/main.ml", workspace: "/d", log() {}, askInstall: ask });

  beforeEach(() => {
    ipc.which = { dune: "/sw/bin/dune", ocamlc: "/sw/bin/ocamlc", ocamlearlybird: "/sw/bin/ocamlearlybird" };
    disk.set("/d/dune-project", GOOD_PROJECT);
    disk.set("/d/bin/dune", BYTE_EXE);
    disk.set("/d/bin/main.ml", "let () = ()\n");
  });
  afterEach(() => {
    resumeTool("ocaml", "/d", toolChangeCount("ocaml"));
    resumeMetals("/d", metalsChangeCount());
    resumeCompiling("", "/d");
  });

  test("builds only the bytecode target and starts it under Earlybird", async () => {
    const plan = await planFor(ctx());
    expect(ipc.builds).toEqual([["dune", "build", "./bin/main.bc"]]);
    expect(plan.adapter).toEqual({ kind: "stdio", cmd: "/sw/bin/ocamlearlybird", args: ["debug"] });
    expect(plan.launch).toMatchObject({ type: "ocaml.earlybird", request: "launch", program: "/d/_build/default/bin/main.bc", cwd: "/d" });
  });

  test("a stop in dune's build copy shows the source file, a generated file stays", async () => {
    expect(duneSourcePath("/d", "/d/_build/default/bin/main.ml")).toBe("/d/bin/main.ml");
    expect(duneSourcePath("/d", "/other/_build/default/a.ml")).toBe("/other/_build/default/a.ml");
    const plan = await planFor(ctx());
    expect(await plan.sourcePath!("/d/_build/default/bin/main.ml")).toBe("/d/bin/main.ml");
    expect(await plan.sourcePath!("/d/_build/default/bin/parser.ml")).toBe("/d/_build/default/bin/parser.ml");
  });

  test("a project without a bytecode target gets a hint and its files stay as they are", async () => {
    disk.set("/d/bin/dune", "(executable (name main))\n");
    const before = new Map(disk);
    await expect(planFor(ctx())).rejects.toThrow(t("code.ad.ocamlNoByte", { name: "main", file: "bin/dune" }));
    expect(disk).toEqual(before);
    expect(ipc.builds).toEqual([]);
  });

  test("a project that maps its workspace root gets a hint instead of ignored breakpoints", async () => {
    disk.set("/d/dune-project", "(lang dune 3.7)\n");
    await expect(planFor(ctx())).rejects.toThrow(t("code.ad.ocamlNeedsMap", { file: "dune-project" }));
    expect(ipc.builds).toEqual([]);
  });

  test("an old dune language version gets a hint", async () => {
    disk.set("/d/dune-project", "(lang dune 2.9)\n");
    await expect(planFor(ctx())).rejects.toThrow(t("code.ad.ocamlNeedsLang", { file: "dune-project" }));
  });

  test("a root with only dune-workspace uses the package's dune-project", async () => {
    disk.clear();
    disk.set("/d/dune-workspace", "(lang dune 3.7)\n");
    disk.set("/d/pkg/dune-project", GOOD_PROJECT);
    disk.set("/d/pkg/bin/dune", BYTE_EXE);
    disk.set("/d/pkg/bin/main.ml", "");
    const plan = await planFor({ ...ctx(), file: "/d/pkg/bin/main.ml" });
    expect(ipc.builds).toEqual([["dune", "build", "./pkg/bin/main.bc"]]);
    expect(plan.launch.program).toBe("/d/_build/default/pkg/bin/main.bc");
  });

  test("the package's own setting decides, not the root's", async () => {
    disk.clear();
    disk.set("/d/dune-project", GOOD_PROJECT);
    disk.set("/d/pkg/dune-project", "(lang dune 3.7)\n");
    disk.set("/d/pkg/bin/dune", BYTE_EXE);
    disk.set("/d/pkg/bin/main.ml", "");
    await expect(planFor({ ...ctx(), file: "/d/pkg/bin/main.ml" })).rejects.toThrow(t("code.ad.ocamlNeedsMap", { file: "pkg/dune-project" }));
    expect(ipc.builds).toEqual([]);
  });

  test("without a dune project it says so", async () => {
    disk.clear();
    disk.set("/d/bin/main.ml", "");
    await expect(planFor(ctx())).rejects.toThrow(t("code.ad.ocamlNeedsDune"));
  });

  test("offers Earlybird when it is missing", async () => {
    delete ipc.which.ocamlearlybird;
    const ask = vi.fn(async () => true);
    await planFor(ctx(ask));
    expect(ask).toHaveBeenCalledWith("Earlybird");
    expect(ipc.calls).toContain("install_debugger");
  });

  test("declining Earlybird builds nothing", async () => {
    delete ipc.which.ocamlearlybird;
    await expect(planFor(ctx(async () => false))).rejects.toThrow();
    expect(ipc.builds).toEqual([]);
  });

  test("an Earlybird from another installation is refused before building", async () => {
    ipc.which.ocamlearlybird = "/other/bin/ocamlearlybird";
    await expect(planFor(ctx())).rejects.toThrow(t("code.ad.ocamlMismatch", { adapter: "/other/bin", compiler: "/sw/bin" }));
    expect(ipc.builds).toEqual([]);
  });

  test("a paused project shows the paused message and builds nothing", async () => {
    noteGuestChange("peer", "/d");
    await expect(planFor(ctx())).rejects.toThrow(t("code.lsp.ocamlPaused"));
    expect(ipc.builds).toEqual([]);
  });

  test("a guest change during the build doesn't start the program", async () => {
    ipc.onBuild = () => noteGuestChange("peer", "/d");
    await expect(planFor(ctx())).rejects.toThrow(t("code.lsp.ocamlPaused"));
  });

  test("a guest change kills the running build at once and says why", async () => {
    let finish = () => {};
    ipc.holdBuild = new Promise((r) => (finish = r));
    const outcome = expect(planFor(ctx())).rejects.toThrow(t("code.lsp.ocamlPaused"));
    await vi.waitFor(() => expect(ipc.builds).toHaveLength(1));
    expect(ipc.killed).toEqual([]);
    noteGuestChange("peer", "/d");
    expect(ipc.killed).toEqual([ipc.buildId]); // before anything else runs
    finish();
    await outcome;
  });

  test("the kill is repeated until the build has really ended", async () => {
    let finish = () => {};
    ipc.holdBuild = new Promise((r) => (finish = r));
    const outcome = expect(planFor(ctx())).rejects.toThrow(t("code.lsp.ocamlPaused"));
    await vi.waitFor(() => expect(ipc.builds).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      noteGuestChange("peer", "/d");
      vi.advanceTimersByTime(250);
      expect(ipc.killed.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
    finish();
    await outcome;
  });

  test("a change in another project leaves the build alone", async () => {
    let finish = () => {};
    ipc.holdBuild = new Promise((r) => (finish = r));
    const plan = planFor(ctx());
    await vi.waitFor(() => expect(ipc.builds).toHaveLength(1));
    noteGuestChange("peer", "/elsewhere");
    expect(ipc.killed).toEqual([]);
    finish();
    await expect(plan).resolves.toMatchObject({ label: "OCaml · main.bc" });
    resumeTool("ocaml", "/elsewhere", toolChangeCount("ocaml"));
    resumeMetals("/elsewhere", metalsChangeCount());
    resumeCompiling("", "/elsewhere");
  });

  test("a failed build shows its output", async () => {
    ipc.buildCode = 1;
    const log = vi.fn();
    await expect(planFor({ ...ctx(), log })).rejects.toThrow(t("code.ad.buildFailed"));
    expect(log).toHaveBeenCalledWith("build output", "error");
  });
});

// Merlin runs the preprocessors a .merlin file or the build config names, through `sh -c`.
describe("ocamllsp in Code Together", () => {
  const lang = langFor("/o/bin/main.ml")!;
  const spawned = () => ipc.calls.includes("proc_spawn");
  const running = () => allClients().filter((c) => c.kind === "ocaml" && !c.stopping);
  let n = 0, root = "", file = "";

  beforeEach(() => {
    ipc.which = { ocamllsp: "/sw/bin/ocamllsp" };
    root = `/o${++n}`;
    file = `${root}/bin/main.ml`;
    disk.set(`${root}/dune-project`, GOOD_PROJECT);
  });
  afterEach(() => {
    resumeTool("ocaml", root, toolChangeCount("ocaml"));
    resumeMetals(root, metalsChangeCount());
    resumeCompiling("", root);
    stopServers("ocaml");
  });

  const started = async () => {
    void clientFor(lang, file, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    return running()[0];
  };

  test("a multi-package repo gets one server, at the outermost dune root", async () => {
    disk.set(`${root}/a/dune-project`, GOOD_PROJECT);
    disk.set(`${root}/b/dune-project`, GOOD_PROJECT);
    const langA = langFor(`${root}/a/x.ml`)!;
    void clientFor(langA, `${root}/a/x.ml`, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    void clientFor(langA, `${root}/b/y.ml`, root, async () => true);
    await new Promise((r) => setTimeout(r, 10));
    expect(running()).toHaveLength(1);
    expect(running()[0].root).toBe(root);
  });

  test("a dune-workspace above the packages is the root too", async () => {
    disk.delete(`${root}/dune-project`);
    disk.set(`${root}/dune-workspace`, "(lang dune 3.7)\n");
    disk.set(`${root}/a/dune-project`, GOOD_PROJECT);
    void clientFor(lang, `${root}/a/x.ml`, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    expect(running()[0].root).toBe(root);
  });

  test("a git repository around a dune project doesn't become its root", async () => {
    disk.delete(`${root}/dune-project`);
    disk.set(`${root}/.git/HEAD`, "");
    disk.set(`${root}/sub/dune-project`, GOOD_PROJECT);
    void clientFor(lang, `${root}/sub/x.ml`, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    expect(running()[0].root).toBe(`${root}/sub`);
  });

  test.each(["a", "b/deep"])("a guest change in package %s stops the shared server and holds it", async (pkg) => {
    disk.set(`${root}/a/dune-project`, GOOD_PROJECT);
    disk.set(`${root}/b/dune-project`, GOOD_PROJECT);
    void clientFor(lang, `${root}/a/x.ml`, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    noteGuestChange("peer", `${root}/${pkg}`);
    expect(running()).toHaveLength(0);
    expect(await clientFor(lang, `${root}/a/x.ml`, root, async () => true)).toBeNull();
    resumeTool("ocaml", `${root}/${pkg}`, toolChangeCount("ocaml"));
    resumeMetals(`${root}/${pkg}`, metalsChangeCount());
    resumeCompiling("", `${root}/${pkg}`);
  });

  test("the host's own project starts it without asking", async () => {
    const confirm = vi.spyOn(ui, "confirm");
    await started();
    expect(spawned()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
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
    expect(lspState.status[`ocaml|${root}`]).toBe("stopped");
    expect(lspState.message[`ocaml|${root}`]).toBe(t("code.lsp.ocamlPaused"));
  });

  test("a guest change during the install keeps it from starting", async () => {
    ipc.which = {};
    const ask = async () => {
      noteGuestChange("peer", root);
      ipc.which = { ocamllsp: "/sw/bin/ocamllsp" };
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

  test("a running server is killed at once when a guest changes the project", async () => {
    const c = await started();
    ipc.calls.length = 0;
    noteGuestChange("peer", root);
    expect(running()).toHaveLength(0);
    expect(ipc.calls).toContain("proc_kill");
    expect(ipc.calls).not.toContain("proc_send"); // no graceful shutdown request
    expect(c.stopping).toBe(true);
  });

  test.each([
    ["with a folder", () => root],
    ["without a folder", () => null],
  ])("a guest's unsaved tab saved as .merlin (%s) stops it", async (_n, tabRoot) => {
    await started();
    noteGuestChange("peer", tabRoot(), "tab:m1");
    toolsBeforeSave("m1", null, `${root}/.merlin`);
    expect(running()).toHaveLength(0);
    expect(ipc.calls).toContain("proc_kill");
    expect(toolPausedBy("ocaml", root)).not.toBeNull();
  });

  test("restart asks, then starts it, and leaves Metals and LaTeX paused", async () => {
    noteGuestChange("peer", root);
    const confirm = vi.spyOn(ui, "confirm").mockResolvedValue(true);
    void restartServer(lang, file, root, async () => true);
    await vi.waitFor(() => expect(spawned()).toBe(true));
    expect(confirm).toHaveBeenCalledWith(t("code.lsp.ocamlResumeTitle"), expect.any(String), t("code.lsp.ocamlResumeOk"));
    expect(toolPausedBy("ocaml", root)).toBeNull();
    expect(metalsPausedBy(root)).not.toBeNull();
  });

  test("restart keeps the pause when the host declines", async () => {
    noteGuestChange("peer", root);
    vi.spyOn(ui, "confirm").mockResolvedValue(false);
    expect(await restartServer(lang, file, root, async () => true)).toBeNull();
    expect(spawned()).toBe(false);
    expect(toolPausedBy("ocaml", root)).not.toBeNull();
  });

  test("a guest change during the restart dialog keeps the pause", async () => {
    noteGuestChange("peer", root);
    vi.spyOn(ui, "confirm").mockImplementation(async () => {
      noteGuestChange("peer", root);
      return true;
    });
    expect(await restartServer(lang, file, root, async () => true)).toBeNull();
    expect(spawned()).toBe(false);
    expect(toolPausedBy("ocaml", root)).not.toBeNull();
  });
});
