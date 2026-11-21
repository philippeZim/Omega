import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
const ipc = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: any }[],
  which: {} as Record<string, string>,
  installable: ["uv", "cc", "mojo"],
  onInstall: () => {},
  failWrite: false,
  partialWrite: false,
  writes: [] as string[],
}));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, a?: any) => {
    ipc.calls.push({ cmd, args: a });
    if (cmd === "tools_dir") return "/tools";
    if (cmd === "tool_installable") return ipc.installable;
    if (cmd === "which_cmd") return ipc.which[a.cmd] ?? null;
    if (cmd === "run_capture") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "install_debugger") ipc.onInstall();
    return null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: async () => {} }) }));
vi.mock("../platform", async (orig) => ({ ...(await orig<typeof import("../platform")>()), OS: "linux", IS_WIN: false, tmpPath: async (n: string) => `/tmp/${n}` }));

const disk = new Map<string, string>();
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fsApi: {
    exists: async (p: string) => disk.has(p) || [...disk.keys()].some((k) => k.startsWith(`${p}/`)),
    readFile: async (p: string) => disk.get(p) ?? "",
    writeFile: async (p: string, text: string) => {
      if (ipc.failWrite) throw new Error("read-only");
      ipc.writes.push(p);
      if (ipc.partialWrite) {
        disk.set(p, text.slice(0, 10));
        await Promise.resolve();
      }
      disk.set(p, text);
    },
    // Like the backend's rename_path: never replaces an existing target.
    rename: async (from: string, to: string) => {
      if (disk.has(to)) throw new Error("fs:exists");
      disk.set(to, disk.get(from)!);
      disk.delete(from);
    },
    remove: async (p: string) => void disk.delete(p),
    listDir: async () => [],
  },
}));

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { StringStream } from "@codemirror/language";
import { extname } from "../api";
import { modeForExtension } from "../modes";
import { fileUri, uriPath } from "./lsp.svelte";
import { indentFor, langFor } from "./languages";
import { isMojoFile, mojoCompiles, mojoEntry, mojoStem, pixiLauncherPath, pixiMojoLauncher, pixiUsesMojo } from "./mojo";
import { mojoIndentStep, mojoParser } from "./mojoMode";
import { detectProject, TEMPLATES } from "./projects";
import { planFor } from "../debug/adapters";
import { t } from "../i18n/index.svelte";

function styles(line: string) {
  const state = mojoParser.startState!(4);
  const stream = new StringStream(line, 4, 4);
  const out: Record<string, string | null> = {};
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = mojoParser.token(stream, state);
    if (stream.pos === stream.start) stream.next();
    const word = stream.current().trim();
    if (word) out[word] = style ?? null;
  }
  return out;
}

const ctx = (file: string, askInstall = async () => true) => ({ file, workspace: "/p", log: () => {}, askInstall });
const LAUNCHER = pixiLauncherPath("/tools");
const PIXI_MOJO = '[workspace]\nname = "x"\n\n[dependencies]\nmojo = ">=1.2,<25"\n';

beforeEach(() => {
  disk.clear();
  ipc.calls.length = 0;
  ipc.which = { cc: "/usr/bin/cc", gcc: "/usr/bin/gcc", mojo: "/tools/mojo/bin/mojo" };
  ipc.installable = ["uv", "cc", "mojo"];
  ipc.onInstall = () => {};
  ipc.failWrite = false;
  ipc.partialWrite = false;
  ipc.writes.length = 0;
});

describe("file names", () => {
  test.each(["/p/a.mojo", "/p/a.🔥", "/p/hällo wörld.🔥"])("%s opens as Mojo in Code mode", (f) => {
    expect(isMojoFile(f)).toBe(true);
    expect(modeForExtension(extname(f))).toBe("code");
    expect(langFor(f)).toMatchObject({ id: "mojo", lspId: "mojo", server: "mojo" });
  });

  test("the emoji extension survives the path handling", () => {
    expect(extname("/p/a.🔥")).toBe("🔥");
    expect(mojoStem("/p/a.b.🔥")).toBe("a.b");
    expect(mojoStem("/p/a.mojo")).toBe("a");
    const uri = fileUri("/p/hällo wörld.🔥");
    expect(uri).toBe("file:///p/h%C3%A4llo%20w%C3%B6rld.%F0%9F%94%A5");
    expect(uriPath(uri)).toBe("/p/hällo wörld.🔥");
  });

  test("only .mojo compiles: Mojo 1.x refuses .🔥", () => {
    expect(mojoCompiles("/p/a.mojo")).toBe(true);
    expect(mojoCompiles("/p/a.🔥")).toBe(false);
  });

  test("other files aren't Mojo", () => {
    expect(isMojoFile("/p/mojo")).toBe(false);
    expect(isMojoFile("/p/a.mojo.txt")).toBe(false);
    expect(langFor("/p/a.py")?.id).toBe("python");
  });
});

describe("highlighting and indentation", () => {
  test("Mojo's keywords on top of Python's", () => {
    expect(styles("struct Point:")).toMatchObject({ struct: "keyword" });
    expect(styles("trait Shape:")).toMatchObject({ trait: "keyword" });
    expect(styles("    var total = 1")).toMatchObject({ var: "keyword" });
    expect(styles("comptime N = 4")).toMatchObject({ comptime: "keyword" });
    expect(styles("def f(x: Int) -> Int:")).toMatchObject({ def: "keyword", Int: "type" });
  });

  test("argument conventions are keywords only in front of a name", () => {
    expect(styles("def f(mut a: Int, out b: Int):")).toMatchObject({ mut: "keyword", out: "keyword" });
    expect(styles("out = 1").out).not.toBe("keyword");
    expect(styles("print(mut)").mut).not.toBe("keyword");
  });

  test("raises is a keyword only where a signature has it", () => {
    expect(styles("def f() raises -> Int:").raises).toBe("keyword");
    expect(styles("raises = 2").raises).not.toBe("keyword");
  });

  test("strings and comments stay what they are", () => {
    expect(styles('x = "struct var"')['"struct var"']).toBe("string");
    expect(styles("# struct var")["# struct var"]).toBe("comment");
  });

  test("a block opens after a colon and closes after return", () => {
    expect(mojoIndentStep("def main():")).toBe(1);
    expect(mojoIndentStep("    if x:  # note")).toBe(1);
    expect(mojoIndentStep('    x = "a:"')).toBe(0);
    expect(mojoIndentStep("    x = 1  # a:")).toBe(0);
    expect(mojoIndentStep("    return x")).toBe(-1);
    expect(mojoIndentStep("    pass")).toBe(-1);
    expect(mojoIndentStep("    returned = 1")).toBe(0);
  });

  test.each(['    """text:', "    '''text:", '    """Args:""" ', '    x = """a:'])("a docstring doesn't open a block: %s", (line) => {
    expect(mojoIndentStep(line)).toBe(0);
  });

  test("code after a closed docstring still counts", () => {
    expect(mojoIndentStep('    """doc"""; if x:')).toBe(1);
  });

  test("uses four spaces by default", () => {
    expect(indentFor(langFor("/p/a.mojo"))).toBeTruthy();
  });
});

describe("project detection", () => {
  test("a pixi manifest counts only if it depends on Mojo", () => {
    expect(pixiUsesMojo(PIXI_MOJO)).toBe(true);
    expect(pixiUsesMojo('[feature.dev.dependencies]\n"mojo" = "*"\n')).toBe(true);
    expect(pixiUsesMojo('[target.linux-64.dependencies]\nmodular = "*"\n')).toBe(true);
    expect(pixiUsesMojo('[dependencies]\npython = "3.12"\nnumpy = "*"\n')).toBe(false);
    expect(pixiUsesMojo('[pypi-dependencies]\nmojo = "*"\n')).toBe(false);
    expect(pixiUsesMojo('[dependencies]\n# mojo = "*"\n')).toBe(false);
    expect(pixiUsesMojo('[tasks]\nmojo = "mojo run x"\n')).toBe(false);
  });

  test("in a pyproject.toml only pixi's tables count", () => {
    expect(pixiUsesMojo('[tool.pixi.dependencies]\nmojo = "*"\n', true)).toBe(true);
    expect(pixiUsesMojo('[dependencies]\nmojo = "*"\n', true)).toBe(false);
  });

  test("a mojoproject.toml project runs the open file", async () => {
    disk.set("/p/mojoproject.toml", "");
    disk.set("/p/src/app.mojo", "");
    const project = await detectProject("/p/src/app.mojo", "/p");
    expect(project).toMatchObject({ kind: "mojo", root: "/p", needs: ["mojo", "cc"], test: null });
    expect(project!.run!.cmd).toBe("mojo run src/app.mojo");
    expect(project!.build!.cmd).toBe("mkdir -p build && mojo build src/app.mojo -o build/app");
  });

  test("with pixi installed, a pixi project uses the Mojo it pins", async () => {
    ipc.which.pixi = "/usr/bin/pixi";
    disk.set("/p/pixi.toml", PIXI_MOJO);
    disk.set("/p/main.mojo", "");
    const project = await detectProject("/p/main.mojo", "/p");
    expect(project).toMatchObject({ kind: "mojo", label: "pixi", needs: ["cc"] });
    expect(project!.run!.cmd).toBe(`sh ${LAUNCHER} run main.mojo`);
    expect(project!.build!.cmd).toBe(`mkdir -p build && sh ${LAUNCHER} build main.mojo -o build/main`);
    expect(project!.more.find((a) => a.id === "fmt")!.cmd).toBe(`sh ${LAUNCHER} format .`);
    expect(disk.get(LAUNCHER)).toContain("--as-is");
  });

  test("no action of a pixi project calls a bare pixi run", async () => {
    ipc.which.pixi = "/usr/bin/pixi";
    disk.set("/p/pixi.toml", PIXI_MOJO);
    disk.set("/p/main.mojo", "");
    const project = (await detectProject("/p/main.mojo", "/p"))!;
    for (const a of [project.run!, project.build!, ...project.more]) expect(a.cmd).not.toContain("pixi run");
  });

  test("names with spaces, apostrophes and a leading dash stay quoted", async () => {
    ipc.which.pixi = "/usr/bin/pixi";
    disk.set("/p/pixi.toml", PIXI_MOJO);
    disk.set("/p/-it's a.mojo", "");
    const project = (await detectProject("/p/-it's a.mojo", "/p"))!;
    expect(project.run!.cmd).toBe(`sh ${LAUNCHER} run './-it'\\''s a.mojo'`);
  });

  test("without a launcher a pixi project doesn't fall back to a bare pixi run", async () => {
    ipc.which.pixi = "/usr/bin/pixi";
    ipc.failWrite = true;
    disk.set("/p/pixi.toml", PIXI_MOJO);
    disk.set("/p/main.mojo", "");
    const project = (await detectProject("/p/main.mojo", "/p"))!;
    expect(project.run!.cmd).toBe("mojo run main.mojo");
    expect(project.needs).toEqual(["mojo", "cc"]);
  });

  test("with pixi on an unsupported system, Run leads to the hint instead of pixi", async () => {
    ipc.which.pixi = "/usr/bin/pixi";
    ipc.installable = ["uv", "cc"];
    disk.set("/p/pixi.toml", PIXI_MOJO);
    disk.set("/p/main.mojo", "");
    const project = await detectProject("/p/main.mojo", "/p");
    expect(project).toMatchObject({ kind: "mojo", label: "Mojo", needs: ["mojo", "cc"] });
    expect(project!.run!.cmd).toBe("mojo run main.mojo");
    expect(JSON.stringify([project!.build!.cmd, ...project!.more.map((a) => a.cmd)])).not.toContain("pixi");
  });

  test("Python in a pixi folder is left alone", async () => {
    disk.set("/p/pixi.toml", '[dependencies]\npython = "3.12"\n');
    disk.set("/p/a.py", "");
    expect((await detectProject("/p/a.py", "/p"))?.kind).toBe("file");
    disk.set("/p/pixi.toml", PIXI_MOJO);
    expect((await detectProject("/p/a.py", "/p"))?.kind).toBe("file");
  });

  test("a uv project stays a uv project, even with a Mojo file next to it", async () => {
    disk.set("/p/pyproject.toml", '[project]\nname = "x"\n');
    disk.set("/p/main.py", "");
    disk.set("/p/a.mojo", "");
    expect((await detectProject("/p/main.py", "/p"))?.kind).toBe("uv");
    expect((await detectProject("/p/a.mojo", "/p"))?.kind).toBe("uv");
    disk.set("/p/pyproject.toml", '[project]\nname = "x"\n\n[tool.pixi.dependencies]\nmojo = "*"\n');
    expect((await detectProject("/p/main.py", "/p"))?.kind).toBe("uv");
    expect((await detectProject("/p/a.mojo", "/p"))?.kind).toBe("mojo");
  });

  test("the entry falls back to the usual files", async () => {
    disk.set("/p/src/main.mojo", "");
    expect(await mojoEntry(null, "/p")).toBe("/p/src/main.mojo");
    expect(await mojoEntry("/elsewhere/x.mojo", "/p")).toBe("/p/src/main.mojo");
    expect(await mojoEntry("/p/x.🔥", "/p")).toBe("/p/src/main.mojo");
  });

  test("a lone file runs with mojo and needs a linker", async () => {
    const project = await detectProject("/x/a b.mojo", "/x");
    expect(project).toMatchObject({ kind: "file", needs: ["mojo", "cc"] });
    expect(project!.run!.cmd).toBe("mojo run '/x/a b.mojo'");
  });

  test("a lone .🔥 file offers no Run that can only fail", async () => {
    expect(await detectProject("/x/a.🔥", "/x")).toBeNull();
  });
});

describe("pixi launcher file", () => {
  const temps = () => [...disk.keys()].filter((k) => k.endsWith(".tmp"));

  test("is never visible half-written: the final path only appears by rename", async () => {
    ipc.partialWrite = true;
    expect(await pixiMojoLauncher()).toBe(LAUNCHER);
    expect(ipc.writes).toHaveLength(1);
    expect(ipc.writes[0]).not.toBe(LAUNCHER);
    expect(ipc.writes[0].startsWith(`${LAUNCHER}.`)).toBe(true);
    expect(temps()).toEqual([]);
  });

  test("concurrent calls use their own temp files and all get the complete launcher", async () => {
    const paths = await Promise.all(Array.from({ length: 8 }, () => pixiMojoLauncher()));
    expect(new Set(paths)).toEqual(new Set([LAUNCHER]));
    expect(new Set(ipc.writes).size).toBe(ipc.writes.length);
    expect(disk.get(LAUNCHER)).toContain("--as-is");
    expect(temps()).toEqual([]);
  });

  test("an existing correct copy is left alone", async () => {
    await pixiMojoLauncher();
    ipc.writes.length = 0;
    expect(await pixiMojoLauncher()).toBe(LAUNCHER);
    expect(ipc.writes).toEqual([]);
  });

  test("a wrong file at that path is not used", async () => {
    disk.set(LAUNCHER, "#!/bin/sh\nexit 0\n");
    expect(await pixiMojoLauncher()).toBeNull();
    expect(disk.get(LAUNCHER)).toBe("#!/bin/sh\nexit 0\n");
    expect(temps()).toEqual([]);
  });
});

describe("template", () => {
  const tpl = () => TEMPLATES.find((x) => x.id === "mojo")!;

  test("uses def, because Mojo 1.x removed fn", async () => {
    const plan = await tpl().create("demo");
    expect(plan.files!["main.mojo"]).toMatch(/^def main\(\):\n {4}print\(/);
    expect(plan.files!["main.mojo"]).not.toMatch(/\bfn\b/);
  });

  test("is a pixi project that excludes the old CalVer builds", async () => {
    const plan = await tpl().create('we"ird');
    expect(Object.keys(plan.files!)[0]).toBe(tpl().marker);
    expect(plan.files!["pixi.toml"]).toContain('name = "we\\"ird"');
    expect(plan.files!["pixi.toml"]).toContain('mojo = ">=1.2,<25"');
    expect(pixiUsesMojo(plan.files!["pixi.toml"])).toBe(true);
  });

  test("needs Mojo and a linker where Mojo can run, nothing where it can't", async () => {
    const needs = tpl().needs as () => Promise<string[]>;
    expect(await needs()).toEqual(["mojo", "cc"]);
    ipc.installable = ["uv"];
    expect(await needs()).toEqual([]);
  });
});

describe("debugging", () => {
  test("builds without optimisation and starts the launcher that loads the Mojo plugin", async () => {
    disk.set("/tools/mojo/bin/omega-mojo-dap", "");
    disk.set("/p/mojoproject.toml", "");
    const plan = await planFor(ctx("/p/a b.mojo"));
    const build = ipc.calls.find((c) => c.cmd === "run_capture")!.args;
    expect(build.cmd).toBe("/tools/mojo/bin/mojo");
    expect(build.args).toEqual(["build", "-O0", "-g", "/p/a b.mojo", "-o", "/tmp/omega-dbg-a_b"]);
    expect(build.cwd).toBe("/p");
    expect(plan.adapter).toEqual({ kind: "stdio", cmd: "/tools/mojo/bin/omega-mojo-dap", args: [] });
    expect(plan.launch).toMatchObject({ request: "launch", program: "/tmp/omega-dbg-a_b", cwd: "/p" });
  });

  test("a missing debugger is installed after asking", async () => {
    ipc.onInstall = () => disk.set("/tools/mojo/bin/omega-mojo-dap", "");
    const ask = vi.fn(async () => true);
    await planFor(ctx("/p/a.mojo", ask));
    expect(ask).toHaveBeenCalledWith("Mojo");
    expect(ipc.calls.find((c) => c.cmd === "install_debugger")!.args).toEqual({ kind: "mojo" });
  });

  test("declining the install builds nothing", async () => {
    await expect(planFor(ctx("/p/a.mojo", async () => false))).rejects.toThrow();
    expect(ipc.calls.some((c) => c.cmd === "run_capture" || c.cmd === "install_debugger")).toBe(false);
  });

  test("a .🔥 file says to rename it instead of installing or building", async () => {
    const ask = vi.fn(async () => true);
    await expect(planFor(ctx("/p/a.🔥", ask))).rejects.toThrow(t("code.ad.mojoFireExt"));
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.calls.some((c) => c.cmd === "run_capture")).toBe(false);
  });
});
