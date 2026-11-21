import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
const ipc = vi.hoisted(() => ({ calls: [] as { cmd: string; args: any }[], which: new Set<string>() }));
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, args?: any) => {
    ipc.calls.push({ cmd, args });
    if (cmd === "tools_dir") return "/tools";
    if (cmd === "lang_workdir") return `/private/x/${args.part}`;
    if (cmd === "lang_copy") return `/private/x/${args.part}/${args.name}`;
    if (cmd === "which_cmd") return ipc.which.has(args.cmd) ? (args.cmd.startsWith("/") ? args.cmd : `/bin/${args.cmd}`) : null;
    if (cmd === "run_capture" || cmd === "run_killable") return { code: 0, stdout: "", stderr: "" };
    return null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("../tools.svelte", async (orig) => ({ ...(await orig<typeof import("../tools.svelte")>()), ensureTools: async () => true }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fsApi: {
    exists: async (p: string) => files.has(p),
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error("not found");
      return files.get(p)!;
    },
    writeFile: async (p: string, c: string) => void files.set(p, c),
    listDir: async () => [],
  },
}));

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { effectiveLang, isForeignLang, moveLanguageOverrides, overrideFor, setLanguageOverride } from "./langOverride.svelte";
import { LANGUAGES, langFor } from "./languages";
import { clangdFlags, lspCopyName, overrideRun, runCopyName } from "./langRun";
import { detectProject, runsAlone } from "./projects";
import { clientFor, neverInstall, realPathOf, registerShadow, shadowOf, stopServers } from "./lsp.svelte";
import { noteGuestChange, resumeTool, toolChangeCount } from "../collab/guestChanges";
import { planFor } from "../debug/adapters";
import { modeExtensions } from "../modes";

const PY = "/w/py";
const cleared: string[] = [];
const choose = (path: string, id: Parameters<typeof setLanguageOverride>[1]) => {
  cleared.push(path);
  return setLanguageOverride(path, id);
};

beforeEach(() => {
  files.clear();
  ipc.calls.length = 0;
  ipc.which.clear();
  files.set(`${PY}/pyproject.toml`, "[project]\nname='x'\n");
  files.set(`${PY}/main.py`, "print(1)\n");
  files.set(`${PY}/prog`, "int main(void){return 0;}\n");
});
afterEach(() => {
  for (const p of cleared.splice(0)) setLanguageOverride(p, null);
  stopServers("scala");
  stopServers("clangd");
});

describe("the stored choice", () => {
  test("wins over the extension, and Automatic returns to it", () => {
    expect(effectiveLang("/a/x.py")?.id).toBe("python");
    choose("/a/x.py", "c");
    expect(effectiveLang("/a/x.py")?.id).toBe("c");
    expect(isForeignLang("/a/x.py")).toBe(true);
    setLanguageOverride("/a/x.py", null);
    expect(effectiveLang("/a/x.py")?.id).toBe("python");
    expect(isForeignLang("/a/x.py")).toBe(false);
  });

  test("affects no other file", () => {
    choose("/a/prog", "c");
    expect(effectiveLang("/a/prog2")).toBeNull();
    expect(effectiveLang("/a/prog.py")?.id).toBe("python");
  });

  test("is persisted without touching the file", () => {
    choose("/a/prog", "rust");
    expect(JSON.parse(localStorage.getItem("code.languageOverrides")!)["/a/prog"]).toBe("rust");
    expect(ipc.calls.some((c) => c.cmd === "write_file")).toBe(false);
  });

  test("the same language keeps the extension's variant", () => {
    choose("/a/x.tsx", "typescript");
    expect(effectiveLang("/a/x.tsx")?.lspId).toBe("typescriptreact");
    expect(isForeignLang("/a/x.tsx")).toBe(false);
  });

  test("follows a rename and a folder move, and ends with a delete", () => {
    choose("/a/prog", "c");
    choose("/a/sub/deep", "rust");
    cleared.push("/b/prog", "/b/new/deep");
    moveLanguageOverrides("/a/prog", "/b/prog");
    expect(overrideFor("/a/prog")).toBeNull();
    expect(overrideFor("/b/prog")).toBe("c");
    moveLanguageOverrides("/a/sub", "/b/new");
    expect(overrideFor("/b/new/deep")).toBe("rust");
    moveLanguageOverrides("/b/prog", null);
    expect(overrideFor("/b/prog")).toBeNull();
  });

  test("a file moved onto a path doesn't inherit that path's choice", () => {
    choose("/a/target", "scala");
    moveLanguageOverrides("/a/other", "/a/target");
    expect(overrideFor("/a/target")).toBeNull();
  });

  test("a sibling with the same prefix is not moved along", () => {
    choose("/a/prog2", "c");
    moveLanguageOverrides("/a/prog", "/b/prog");
    expect(overrideFor("/a/prog2")).toBe("c");
  });

  test("a guest's shared file can't get one", () => {
    expect(setLanguageOverride("collab:src/main.py", "scala")).toBe(false);
    expect(overrideFor("collab:src/main.py")).toBeNull();
    expect(effectiveLang("collab:src/main.py")?.id).toBe("python");
  });

  test("the editor's highlighting uses it for a file without extension", () => {
    expect(langFor(`${PY}/prog`)).toBeNull();
    choose(`${PY}/prog`, "c");
    expect(() => modeExtensions("code", `${PY}/prog`)).not.toThrow();
    expect(effectiveLang(`${PY}/prog`)?.label).toBe("C");
  });
});

describe("Run for a file set to another language", () => {
  test("C in a Python project ignores the project and compiles the real file", async () => {
    choose(`${PY}/prog`, "c");
    const p = (await detectProject(`${PY}/prog`, PY))!;
    expect(p.kind).toBe("file");
    expect(p.isolated).toBe(true);
    expect(p.run!.pre).toBe(`gcc -x c -g -Wall ${PY}/prog -o /private/x/bin/omega_out -lm`);
    expect(p.run!.cmd).toBe("/private/x/bin/omega_out");
  });

  test.each(["c", "cpp", "rust"] as const)("Build compiles %s once", async (id) => {
    choose(`${PY}/prog`, id);
    const p = (await detectProject(`${PY}/prog`, PY))!;
    expect(p.build!.cmd).toBe(p.run!.pre);
    expect(p.build!.pre).toBeUndefined();
  });

  test("the project's Python files still run through the project", async () => {
    choose(`${PY}/prog`, "c");
    const p = (await detectProject(`${PY}/main.py`, PY))!;
    expect(p.kind).toBe("uv");
    expect(p.run!.cmd).toBe("uv run main.py");
  });

  test("Python in a Python project stays in the project, without uv taking the name for a command", async () => {
    choose(`${PY}/prog`, "python");
    const p = (await detectProject(`${PY}/prog`, PY))!;
    expect(p.kind).toBe("uv");
    expect(p.run!.cmd).toBe("uv run python prog");
  });

  test("JSON and TOML have nothing to run, so no Run button", async () => {
    for (const id of ["json", "toml"] as const) {
      choose(`${PY}/prog`, id);
      expect(await detectProject(`${PY}/prog`, PY)).toBeNull();
    }
  });

  test.each([
    ["python", "uv run --no-project --script /w/f"],
    ["java", "java /private/x/run/OmegaMain.java"],
    ["javascript", "node /private/x/run/omega_main.js"],
    ["mojo", "mojo run /private/x/run/omega_main.mojo"],
    ["scala", "scala-cli run /private/x/run/omega_main.sc"],
  ] as const)("%s has its own command", async (id, cmd) => {
    files.set("/w/f", "x");
    expect((await overrideRun(id, "/w/f", "tsx"))!.cmd).toBe(cmd);
  });

  test("every language either runs or says it doesn't", async () => {
    files.set("/w/f", "x");
    for (const l of LANGUAGES) {
      const r = await overrideRun(l.id, "/w/f", "tsx");
      if (l.id === "json" || l.id === "toml") expect(r).toBeNull();
      else expect(r?.cmd).toBeTruthy();
    }
  });

  test("Rust gets a crate name, since a file name may not be one", async () => {
    files.set("/w/my-prog.x", "fn main(){}");
    expect((await overrideRun("rust", "/w/my-prog.x", "tsx"))!.pre).toContain("--crate-name omega_main /w/my-prog.x");
  });

  test("a hostile file name stays one argument", async () => {
    const f = "/w/a'; rm -rf x #";
    files.set(f, "");
    expect((await overrideRun("c", f, "tsx"))!.pre).toContain(`'/w/a'\\''; rm -rf x #'`);
  });

  test("a copy is refreshed right before the command, as a plain name", async () => {
    files.set("/w/f", "console.log(1)");
    const r = (await overrideRun("typescript", "/w/f", "tsx"))!;
    expect(ipc.calls.some((c) => c.cmd === "lang_copy")).toBe(false);
    await r.prepare!();
    expect(ipc.calls.find((c) => c.cmd === "lang_copy")!.args).toEqual({ file: "/w/f", part: "run", name: "omega_main.ts", link: true });
  });

  test("Scala picks script or program by the text", () => {
    expect(runCopyName("scala", 'println("x")')).toBe("omega_main.sc");
    expect(runCopyName("scala", '@main def hi() = println("x")')).toBe("OmegaMain.scala");
    expect(runCopyName("scala", "object A extends App {}")).toBe("OmegaMain.scala");
  });
});

describe("the one decision whether a file is alone", () => {
  test.each([
    ["pyproject.toml", "python", false],
    ["pyproject.toml", "c", true],
    ["Cargo.toml", "rust", false],
    ["CMakeLists.txt", "cpp", false],
    ["package.json", "typescript", true], // node and tsx go by the extension
    ["Cargo.toml", "python", true],
  ] as const)("%s with a file set to %s: alone = %s", async (marker, id, alone) => {
    files.clear();
    files.set(`/w/k/${marker}`, "");
    files.set("/w/k/tool", "");
    choose("/w/k/tool", id);
    expect(await runsAlone("/w/k/tool", "/w/k")).toBe(alone);
  });

  test("a file on its extension's language never is", async () => {
    expect(await runsAlone(`${PY}/main.py`, PY)).toBe(false);
  });
});

describe("language server of a file set to another language", () => {
  test("Java's copy is named after its public class", () => {
    const java = LANGUAGES.find((l) => l.id === "java")!;
    expect(lspCopyName(java, "public final class Hello {}\n")).toBe("Hello.java");
    expect(lspCopyName(java, "class hidden {}")).toBe("OmegaMain.java");
    expect(lspCopyName(java, "package demo.app;\n\npublic class Hello {}\n")).toBe("demo/app/Hello.java");
    expect(lspCopyName(java, "package ../evil;\npublic class X {}")).toBe("X.java");
  });

  test("clangd looks for includes next to the real file; a line break can't add a flag", () => {
    expect(clangdFlags("c", "/w/src/prog")).toBe("-I/w/src\n");
    expect(clangdFlags("cpp", "/w/src/prog")).toBe("-std=c++20\n-I/w/src\n");
    expect(clangdFlags("c", "/w/a\n-fplugin=evil/prog")).toBeNull();
  });

  test("the copy maps back to the real file", () => {
    registerShadow("/w/prog", "/private/h/lsp/omega_main.c");
    expect(shadowOf("/w/prog")).toBe("/private/h/lsp/omega_main.c");
    expect(realPathOf("/private/h/lsp/omega_main.c")).toBe("/w/prog");
    expect(realPathOf("/usr/include/stdio.h")).toBe("/usr/include/stdio.h");
  });

  test("Metals stays off for a copy of a file in a paused project", async () => {
    const root = "/w/paused-scala";
    noteGuestChange("peer", root);
    ipc.which.add("/tools/metals/metals");
    choose(`${root}/prog`, "scala");
    registerShadow(`${root}/prog`, "/private/s1/lsp/omega_main.scala");
    expect(await clientFor(LANGUAGES.find((l) => l.id === "scala")!, "/private/s1/lsp/omega_main.scala", root, async () => true)).toBeNull();
    expect(ipc.calls.some((c) => c.cmd === "proc_spawn")).toBe(false);
    resumeTool("metals", root, toolChangeCount("metals"));
    resumeTool("ocaml", root, toolChangeCount("ocaml"));
  });

  test("ocamllsp stays off for such a copy too", async () => {
    const root = "/w/paused-ocaml";
    noteGuestChange("peer", root);
    ipc.which.add("/tools/ocaml/root/omega/bin/ocamllsp");
    registerShadow(`${root}/prog`, "/private/s2/lsp/omega_main.ml");
    expect(await clientFor(LANGUAGES.find((l) => l.id === "ocaml")!, "/private/s2/lsp/omega_main.ml", root, async () => true)).toBeNull();
    expect(ipc.calls.some((c) => c.cmd === "proc_spawn")).toBe(false);
    resumeTool("metals", root, toolChangeCount("metals"));
    resumeTool("ocaml", root, toolChangeCount("ocaml"));
  });

  test("a guest's request never starts Metals for a copy", async () => {
    ipc.which.add("/tools/metals/metals");
    registerShadow("/w/free/prog", "/private/s3/lsp/omega_main.scala");
    expect(await clientFor(LANGUAGES.find((l) => l.id === "scala")!, "/private/s3/lsp/omega_main.scala", "/w/free", neverInstall)).toBeNull();
    expect(ipc.calls.some((c) => c.cmd === "proc_spawn")).toBe(false);
  });

  test("a marker file above the copy doesn't change its root", async () => {
    ipc.which.add("clangd");
    files.set("/private/compile_commands.json", "[]");
    registerShadow("/w/py/prog", "/private/s4/lsp/omega_main.c");
    void clientFor(LANGUAGES.find((l) => l.id === "c")!, "/private/s4/lsp/omega_main.c", PY, async () => true);
    await vi.waitFor(() => expect(ipc.calls.some((c) => c.cmd === "proc_spawn")).toBe(true));
    expect(ipc.calls.find((c) => c.cmd === "proc_spawn")!.args.cwd).toBe("/private/s4/lsp");
  });
});

describe("Debug for a file set to another language", () => {
  const ctx = (file: string) => ({ file, workspace: PY, log: () => {}, askInstall: async () => true });

  test("C compiles the real file, so stops map to it without a copy", async () => {
    choose(`${PY}/prog`, "c");
    files.set("/tools/codelldb/extension/adapter/codelldb", "");
    const plan = await planFor(ctx(`${PY}/prog`));
    const build = ipc.calls.find((c) => c.cmd === "run_capture")!.args;
    expect(build.cmd).toBe("gcc");
    expect(build.args).toEqual(["-g", "-O0", "-x", "c", `${PY}/prog`, "-o", "/private/x/bin/omega_dbg", "-lm"]);
    expect(plan.launch.program).toBe("/private/x/bin/omega_dbg");
    expect(plan.shadow).toBeUndefined();
  });

  test("TypeScript without a local tsx runs one node process with tsx's loader", async () => {
    choose(`${PY}/prog`, "typescript");
    files.set("/tools/js-debug/src/dapDebugServer.js", "");
    files.set("/tools/tsx/node_modules/tsx/dist/loader.mjs", "");
    ipc.which.add("node");
    const plan = await planFor(ctx(`${PY}/prog`));
    expect(plan.launch.runtimeExecutable).toBe("/bin/node");
    expect(plan.launch.runtimeArgs).toEqual(["--import", "file:///tools/tsx/node_modules/tsx/dist/loader.mjs"]);
    expect(plan.launch.program).toBe("/private/x/run/omega_main.ts");
  });

  const OCAML = "/tools/ocaml/root/omega/bin";
  const ocamlTools = () => ["ocamlc", "ocamlearlybird"].forEach((t) => ipc.which.add(`${OCAML}/${t}`));

  test("OCaml builds bytecode of a private copy with Omega's compiler, killable", async () => {
    choose(`${PY}/prog`, "ocaml");
    ocamlTools();
    const plan = await planFor(ctx(`${PY}/prog`));
    expect(ipc.calls.find((c) => c.cmd === "lang_copy")!.args).toEqual({ file: `${PY}/prog`, part: "bin", name: "omega_main.ml", link: false });
    const build = ipc.calls.find((c) => c.cmd === "run_killable")!.args;
    expect(build).toMatchObject({ cmd: `${OCAML}/ocamlc`, args: ["-g", "-o", "omega_dbg.bc", "omega_main.ml"], cwd: "/private/x/bin" });
    expect(plan.launch.program).toBe("/private/x/bin/omega_dbg.bc");
    expect(plan.shadow).toEqual({ file: `${PY}/prog`, copy: "/private/x/bin/omega_main.ml" });
  });

  test("OCaml builds nothing while a guest's change holds the project", async () => {
    const root = "/w/held-ml";
    files.set(`${root}/prog`, "let () = ()");
    choose(`${root}/prog`, "ocaml");
    ocamlTools();
    noteGuestChange("peer", root);
    try {
      await expect(planFor({ ...ctx(`${root}/prog`), workspace: root })).rejects.toThrow();
      expect(ipc.calls.some((c) => c.cmd === "run_killable" || c.cmd === "lang_copy")).toBe(false);
    } finally {
      resumeTool("metals", root, toolChangeCount("metals"));
      resumeTool("ocaml", root, toolChangeCount("ocaml"));
    }
  });

  test("Scala writes and starts nothing while a guest's change holds the project", async () => {
    const root = "/w/held-scala";
    files.set(`${root}/prog`, "@main def a() = ()");
    choose(`${root}/prog`, "scala");
    ipc.which.add("javac");
    ipc.which.add("/tools/metals/metals");
    noteGuestChange("peer", root);
    try {
      await expect(planFor({ ...ctx(`${root}/prog`), workspace: root })).rejects.toThrow();
      expect(ipc.calls.some((c) => ["lang_copy", "run_killable", "proc_spawn"].includes(c.cmd))).toBe(false);
    } finally {
      resumeTool("metals", root, toolChangeCount("metals"));
      resumeTool("ocaml", root, toolChangeCount("ocaml"));
    }
  });

  test("Java without a JDK says so before starting anything", async () => {
    choose(`${PY}/prog`, "java");
    await expect(planFor(ctx(`${PY}/prog`))).rejects.toThrow(/JDK/);
    expect(ipc.calls.some((c) => c.cmd === "proc_spawn" || c.cmd === "lang_copy")).toBe(false);
  });

  test("JavaScript runs a copy and says which real file it stands for", async () => {
    choose(`${PY}/prog`, "javascript");
    files.set("/tools/js-debug/src/dapDebugServer.js", "");
    const plan = await planFor(ctx(`${PY}/prog`));
    expect(plan.launch.program).toBe("/private/x/run/omega_main.js");
    expect(plan.shadow).toEqual({ file: `${PY}/prog`, copy: "/private/x/run/omega_main.js" });
  });
});
