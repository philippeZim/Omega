/** Project detection and the recommended tool per language: cargo, uv, pnpm, CMake, Gradle, scala-cli, sbt, dune, Mojo. */
import { invoke } from "@tauri-apps/api/core";
import { fsApi, basename, dirname, joinPath, isRoot } from "../api";
import { q, cd, exe, IS_WIN, OS, runRel, rmrf, tmpPath } from "../platform";
import type { ToolId } from "../tools.svelte";
import { langFor, type LangId } from "./languages";
import { suggestPythonAdd, suggestPythonRemove, pythonRemoveArg, suggestNodeAdd, suggestNodeRemove, type Suggest } from "./packages";
import { validScriptName } from "./packageInput";
import { duneTarget, findDuneExecutables, pickExecutable } from "./dune";
import { ocamlShellPrefix } from "./ocamlTools";
import { isMojoFile, mojoCompiles, mojoEntry, mojoStem, pixiMojoLauncher, pixiUsesMojo } from "./mojo";
import { t, i18n, type Key } from "../i18n/index.svelte";

export type ProjectKind = "cargo" | "uv" | "pnpm" | "cmake" | "gradle" | "sbt" | "scala-cli" | "dune" | "mojo" | "file";

export interface Action {
  id: string;
  label: string;
  /** Shell command run in the "Run" terminal (cwd = project root). */
  cmd?: string;
  /** Build step run first in the "Build" terminal; `cmd` only starts when it succeeded. */
  pre?: string;
  /** Run first (before `pre`, or `cmd` without one) while `unless` (relative to the root) is missing, e.g. CMake configure. */
  setup?: { unless: string; cmd: string };
  /** Needs a user-provided argument (e.g. package name); `{}` is replaced. */
  ask?: string;
  /** Suggestions/autocomplete for the argument prompt. */
  suggest?: Suggest;
  /** Turns the entered text into the command argument (e.g. adds `--dev`). */
  arg?: (input: string) => Promise<string>;
  shortcut?: string;
  /** Tools the command needs (offered for installation when missing). */
  needs?: ToolId[];
  /** What it runs follows the file open in the editor. */
  usesFile?: boolean;
}

export interface Project {
  kind: ProjectKind;
  root: string;
  label: string;
  run: Action | null;
  /** The detected run action when the user replaced it with a custom command (see runner). */
  defaultRun?: Action | null;
  build: Action | null;
  test: Action | null;
  more: Action[];
  /** Tools every action of this project needs. */
  needs: ToolId[];
}

const which = (c: string) => invoke<string | null>("which_cmd", { cmd: c }).catch(() => null);

const MARKERS: [string, ProjectKind][] = [
  ["Cargo.toml", "cargo"],
  ["pyproject.toml", "uv"],
  ["CMakeLists.txt", "cmake"],
  ["settings.gradle.kts", "gradle"],
  ["settings.gradle", "gradle"],
  ["build.gradle.kts", "gradle"],
  ["build.gradle", "gradle"],
  // Before package.json (Scala.js builds have both) and project.scala: such a project stays on sbt.
  ["build.sbt", "sbt"],
  // Also before package.json (Melange projects have both).
  ["dune-workspace", "dune"],
  ["dune-project", "dune"],
  ["package.json", "pnpm"],
  ["project.scala", "scala-cli"],
];

const mojoInstallable = async () => (await invoke<string[]>("tool_installable").catch((): string[] => [])).includes("mojo");

/** A Mojo project: `mojoproject.toml`, or a pixi manifest that depends on Mojo. */
async function isMojoProject(dir: string, mojoFile: boolean): Promise<boolean> {
  if (await fsApi.exists(joinPath(dir, "mojoproject.toml"))) return true;
  const pixi = joinPath(dir, "pixi.toml");
  if ((await fsApi.exists(pixi)) && pixiUsesMojo(await fsApi.readFile(pixi).catch(() => ""))) return true;
  // A pyproject.toml stays a Python project unless a Mojo file is what's being run.
  const pyproject = joinPath(dir, "pyproject.toml");
  return mojoFile && (await fsApi.exists(pyproject)) && pixiUsesMojo(await fsApi.readFile(pyproject).catch(() => ""), true);
}

async function findProject(file: string | null, workspace: string | null): Promise<{ kind: ProjectKind; root: string } | null> {
  let dir = file ? dirname(file) : workspace;
  const stop = workspace ? dirname(workspace) : "/";
  let found: { kind: ProjectKind; root: string } | null = null;
  const mojoFile = !!file && isMojoFile(file);
  // A Python, C or other source file in a pixi folder keeps the behaviour it has without Mojo.
  const lang = file ? langFor(file)?.id : undefined;
  const mayBeMojo = !lang || lang === "mojo" || lang === "toml";
  while (dir && dir !== stop && !isRoot(dir)) {
    if (mojoFile && (await isMojoProject(dir, true))) return found ?? { kind: "mojo", root: dir };
    let marked = false;
    for (const [m, kind] of MARKERS) {
      if (await fsApi.exists(joinPath(dir, m))) {
        // Cargo and dune workspaces: keep walking, their build root is the outermost one.
        if (kind === "cargo" || kind === "dune") found = { kind, root: dir };
        else return found ?? { kind, root: dir };
        marked = true;
        break;
      }
    }
    if (!marked && !mojoFile && mayBeMojo && (await isMojoProject(dir, false))) return found ?? { kind: "mojo", root: dir };
    dir = dirname(dir);
  }
  return found;
}

/** First `[project.scripts]` entry of a pyproject.toml: name = "module:function". */
export async function pyprojectScripts(root: string): Promise<{ name: string; target: string }[]> {
  try {
    const toml = await fsApi.readFile(joinPath(root, "pyproject.toml"));
    const sec = /^\[project\.scripts\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(toml)?.[1] ?? "";
    // No `%`: cmd.exe expands it even inside quotes, and a real entry point never has one.
    return [...sec.matchAll(/^\s*["']?([\w.-]+)["']?\s*=\s*["']([^"'%]+)["']/gm)].map((m) => ({ name: m[1], target: m[2] }));
  } catch {
    return [];
  }
}

const MAIN_GUARD = /if\s+__name__\s*==\s*["']__main__["']/;
const PY_SKIP = new Set(["__pycache__", "node_modules", "venv", "build", "dist", "tests", "test"]);

/**
 * Entry file of a Python project when no file says what to run: main.py in the root, else the
 * first .py file with a __main__ guard (breadth-first, at most 3 levels deep; main.py and
 * __main__.py first in each folder; hidden folders, venvs and tests are skipped).
 */
export async function findPythonMain(root: string): Promise<string | null> {
  if (await fsApi.exists(joinPath(root, "main.py"))) return joinPath(root, "main.py");
  const rank = (n: string) => (n === "main.py" ? 0 : n === "__main__.py" ? 1 : 2);
  let level = [root];
  let reads = 0;
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = (await fsApi.listDir(dir).catch(() => null)) ?? [];
      const py = entries.filter((e) => !e.is_dir && e.name.endsWith(".py") && !/^test_|_test\.py$|^conftest\.py$/.test(e.name));
      for (const e of py.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))) {
        if (++reads > 50) return null;
        if (MAIN_GUARD.test(await fsApi.readFile(e.path).catch(() => ""))) return e.path;
      }
      next.push(...entries.filter((e) => e.is_dir && !e.name.startsWith(".") && !PY_SKIP.has(e.name)).map((e) => e.path));
    }
    level = next;
  }
  return null;
}

/**
 * What "run this" means for Python: a file with a __main__ guard runs as a script; otherwise a
 * package project's [project.scripts] entry point (uv 0.13 package layout); otherwise the file;
 * without a Python file, the project's entry file (see findPythonMain).
 */
export async function pythonEntry(file: string | null, root: string): Promise<{ kind: "file"; file: string } | { kind: "script"; name: string; target: string } | { kind: "none" }> {
  const isPy = file && langFor(file)?.id === "python";
  if (isPy) {
    const text = await fsApi.readFile(file).catch(() => "");
    if (MAIN_GUARD.test(text)) return { kind: "file", file };
  }
  const scripts = await pyprojectScripts(root);
  if (scripts.length) return { kind: "script", ...scripts[0] };
  if (isPy) return { kind: "file", file };
  const main = await findPythonMain(root);
  return main ? { kind: "file", file: main } : { kind: "none" };
}

/**
 * What follows `uv run`: names from the project must not read as options, and on Windows a file
 * with `%` can't be run at all, because cmd.exe would expand it even inside quotes.
 */
export function uvRunTarget(entry: Awaited<ReturnType<typeof pythonEntry>>, relFile: string, windows = IS_WIN): string | null {
  if (entry.kind === "script") return `${entry.name.startsWith("-") ? "-- " : ""}${q(entry.name)}`;
  if (entry.kind !== "file" || (windows && relFile.includes("%"))) return null;
  return q(relFile.startsWith("-") ? `./${relFile}` : relFile);
}

/** Removes `#` line comments and `#[[ … ]]` bracket comments, leaving quoted strings alone. */
function stripCmakeComments(txt: string): string {
  let out = "";
  for (let i = 0; i < txt.length; ) {
    const c = txt[i];
    if (c === '"') {
      let j = i + 1;
      while (j < txt.length && txt[j] !== '"') j += txt[j] === "\\" ? 2 : 1;
      out += txt.slice(i, j + 1);
      i = j + 1;
    } else if (c === "#") {
      const br = /^#\[(=*)\[/.exec(txt.slice(i, i + 64));
      const end = br ? txt.indexOf(`]${br[1]}]`, i + br[0].length) : -1;
      if (br) i = end < 0 ? txt.length : end + br[1].length + 2;
      else {
        const nl = txt.indexOf("\n", i);
        i = nl < 0 ? txt.length : nl;
      }
    } else out += txt[i++];
  }
  return out;
}

/**
 * Name of the first executable a CMakeLists.txt defines: comments are ignored, and `${VAR}` is
 * resolved from `project()` (PROJECT_NAME) and plain `set(VAR value)`. Null if none can be resolved.
 */
export function cmakeExecutable(txt: string): string | null {
  const vars: Record<string, string> = {};
  const expand = (s: string) => s.replace(/\$\{(\w+)\}/g, (m, v: string) => vars[v] ?? m);
  for (const m of stripCmakeComments(txt).matchAll(/\b(\w+)\s*\(([^)]*)\)/g)) {
    const args = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((a) => expand(a[1] ?? a[2]));
    const cmd = m[1].toLowerCase();
    if (cmd === "project" && args[0]) vars.PROJECT_NAME = vars.CMAKE_PROJECT_NAME = args[0];
    else if (cmd === "set" && args.length === 2) vars[args[0]] = args[1];
    else if (cmd === "add_executable" && args[0] && !args.includes("IMPORTED") && !args.includes("ALIAS") && !args[0].includes("${")) return args[0];
  }
  return vars.PROJECT_NAME ?? null;
}

async function cmakeTarget(root: string): Promise<string> {
  const txt = await fsApi.readFile(joinPath(root, "CMakeLists.txt")).catch(() => "");
  return cmakeExecutable(txt) ?? basename(root);
}

async function packageScripts(root: string): Promise<string[]> {
  try {
    return Object.keys(JSON.parse(await fsApi.readFile(joinPath(root, "package.json"))).scripts ?? {});
  } catch {
    return [];
  }
}

/** A TypeScript project: tsconfig.json, or typescript among the (dev) dependencies. */
async function usesTypescript(root: string): Promise<boolean> {
  if (await fsApi.exists(joinPath(root, "tsconfig.json"))) return true;
  try {
    const pkg = JSON.parse(await fsApi.readFile(joinPath(root, "package.json")));
    return !!(pkg.dependencies?.typescript ?? pkg.devDependencies?.typescript);
  } catch {
    return false;
  }
}

const RUN = "Shift+F10", BUILD = "Ctrl+F9";

/** tsx without a local install. pnpm 10+ blocks esbuild's build script and asks interactively
 *  which builds to allow, which hangs the Run tab; `--allow-build` answers that up front. */
const TSX_DLX = "pnpm dlx --allow-build=esbuild tsx";

/** Action whose label and argument prompt follow the UI language (getters re-read the locale). */
function act(id: string, label: Key, cmd: string, opts: { shortcut?: string; ask?: () => string; suggest?: Suggest; arg?: Action["arg"]; pre?: string; setup?: Action["setup"]; usesFile?: boolean } = {}): Action {
  return { id, cmd, pre: opts.pre, setup: opts.setup, usesFile: opts.usesFile, shortcut: opts.shortcut, suggest: opts.suggest, arg: opts.arg, get label() { return t(label); }, get ask() { return opts.ask?.(); } };
}
const askPkg = (example: string) => () => t("code.act.askPackage", { example });
const askPkgPlain = () => t("code.act.askPackagePlain");

export async function detectProject(file: string | null, workspace: string | null): Promise<Project | null> {
  const p = await findProject(file, workspace);
  const rel = (f: string, root: string) => (f.startsWith(root + "/") ? f.slice(root.length + 1) : f);

  if (p?.kind === "cargo")
    return {
      ...p,
      label: "cargo",
      needs: ["rust"],
      run: act("run", "common.run", "cargo run -q", { shortcut: RUN, pre: "cargo build" }),
      build: act("build", "code.act.build", "cargo build", { shortcut: BUILD }),
      test: act("test", "code.act.test", "cargo test", { pre: "cargo test --no-run" }),
      more: [
        { id: "check", label: "cargo check", cmd: "cargo check" },
        act("clippy", "code.act.clippy", "cargo clippy"),
        act("fmt", "code.act.cargoFmt", "cargo fmt"),
        act("release", "code.act.buildRelease", "cargo build --release"),
        act("add", "code.act.addDep", "cargo add {}", { ask: () => t("code.act.askCrate") }),
        { id: "update", label: "cargo update", cmd: "cargo update" },
        { id: "clean", label: "cargo clean", cmd: "cargo clean" },
      ],
    };

  if (p?.kind === "uv") {
    const entry = await pythonEntry(file, p.root);
    const target = uvRunTarget(entry, entry.kind === "file" ? rel(entry.file, p.root) : "");
    return {
      ...p,
      label: "uv",
      needs: ["uv"],
      run: target ? act("run", "common.run", `uv run ${target}`, { shortcut: RUN, usesFile: true }) : null,
      build: act("build", "code.act.buildPackage", "uv build", { shortcut: BUILD }),
      test: act("test", "code.act.test", "uv run pytest"),
      more: [
        act("sync", "code.act.uvSync", "uv sync"),
        act("add", "code.act.addDep", "uv add {}", { ask: askPkg("requests"), suggest: suggestPythonAdd(p.root, false) }),
        act("adddev", "code.act.addDevDep", "uv add --dev {}", { ask: askPkg("pytest"), suggest: suggestPythonAdd(p.root, true) }),
        act("remove", "code.act.removeDep", "uv remove {}", { ask: askPkgPlain, suggest: suggestPythonRemove(p.root), arg: (v) => pythonRemoveArg(p.root, v) }),
        act("fmt", "code.act.ruffFmt", "uvx ruff format"),
        act("lint", "code.act.ruffLint", "uvx ruff check"),
        { id: "lock", label: "uv lock", cmd: "uv lock" },
      ],
    };
  }

  if (p?.kind === "pnpm") {
    const scripts = await packageScripts(p.root);
    const lang = file ? langFor(file)?.id : null;
    const tsx = (await fsApi.exists(joinPath(p.root, "node_modules/.bin/tsx"))) ? "pnpm exec tsx" : TSX_DLX;
    const fileRun = file && (lang === "typescript" ? `${tsx} ${q(file)}` : lang === "javascript" ? `pnpm exec node ${q(file)}` : null); // pnpm exec honours devEngines.runtime (chosen Node version)
    const runScript = ["dev", "start"].find((s) => scripts.includes(s));
    return {
      ...p,
      label: "pnpm",
      needs: ["node", "pnpm"],
      run: fileRun
        ? act("run", "common.run", fileRun, { shortcut: RUN, usesFile: true })
        : runScript
          ? { id: "run", label: `pnpm ${runScript}`, cmd: `pnpm run ${runScript}`, shortcut: RUN }
          : null,
      build: scripts.includes("build")
        ? act("build", "code.act.build", "pnpm run build", { shortcut: BUILD })
        : (await usesTypescript(p.root))
          ? act("build", "code.act.typecheck", "pnpm exec tsc --noEmit", { shortcut: BUILD })
          : null, // plain JavaScript: nothing to build or typecheck
      test: scripts.includes("test") ? act("test", "code.act.test", "pnpm test") : null,
      more: [
        ...scripts.filter(validScriptName).map((s) => ({ id: `script:${s}`, label: `pnpm run ${s}`, cmd: `pnpm run ${q(s)}` })),
        { id: "install", label: "pnpm install", cmd: "pnpm install" },
        act("add", "code.act.addDep", "pnpm add {}", { ask: askPkg("zod"), suggest: suggestNodeAdd(p.root, false) }),
        act("adddev", "code.act.addDevDep", "pnpm add -D {}", { ask: askPkg("vitest"), suggest: suggestNodeAdd(p.root, true) }),
        act("remove", "code.act.removeDep", "pnpm remove {}", { ask: askPkgPlain, suggest: suggestNodeRemove(p.root) }),
      ],
    };
  }

  if (p?.kind === "cmake") {
    const target = await cmakeTarget(p.root);
    const cfg = await cmakeConfigure("build", "Debug");
    const setup = { unless: "build/CMakeCache.txt", cmd: cfg.cmd };
    const run = runRel(`build/${exe(target)}`);
    return {
      ...p,
      label: "CMake",
      needs: cfg.needs,
      run: act("run", "common.run", run, { shortcut: RUN, pre: "cmake --build build", setup }),
      build: act("build", "code.act.build", "cmake --build build", { shortcut: BUILD, setup }),
      test: act("test", "code.act.test", "ctest --test-dir build --output-on-failure", { pre: "cmake --build build", setup }),
      more: [
        act("configure", "code.act.configure", cfg.cmd),
        act("release", "code.act.buildRelease", `${(await cmakeConfigure("build-release", "Release")).cmd} && cmake --build build-release`),
        act("clean", "code.act.clean", "cmake --build build --target clean"),
        act("reset", "code.act.resetBuild", rmrf("build")),
      ],
    };
  }

  if (p?.kind === "gradle") {
    const wrapper = await fsApi.exists(joinPath(p.root, IS_WIN ? "gradlew.bat" : "gradlew"));
    const g = wrapper ? (IS_WIN ? "gradlew.bat" : "./gradlew") : "gradle";
    return {
      ...p,
      label: "Gradle",
      needs: wrapper ? ["jdk"] : ["jdk", "gradle"],
      run: act("run", "common.run", `${g} run -q --console=plain`, { shortcut: RUN, pre: `${g} classes --console=plain` }),
      build: act("build", "code.act.build", `${g} build`, { shortcut: BUILD }),
      test: act("test", "code.act.test", `${g} test`),
      more: [
        { id: "clean", label: "gradle clean", cmd: `${g} clean` },
        act("deps", "code.act.showDeps", `${g} dependencies --configuration runtimeClasspath`),
        act("wrapper", "code.act.gradleWrapper", "gradle wrapper"),
        act("jar", "code.act.jar", `${g} jar`),
      ],
    };
  }

  if (p?.kind === "sbt")
    return {
      ...p,
      label: "sbt",
      needs: ["jdk", "sbt"],
      run: act("run", "common.run", "sbt -batch run", { shortcut: RUN }),
      build: act("build", "code.act.build", "sbt -batch compile", { shortcut: BUILD }),
      test: act("test", "code.act.test", "sbt -batch test"),
      more: [
        { id: "clean", label: "sbt clean", cmd: "sbt -batch clean" },
        act("jar", "code.act.jar", "sbt -batch package"),
      ],
    };

  if (p?.kind === "scala-cli") {
    const script = file?.endsWith(".sc") && file.startsWith(p.root + "/") ? rel(file, p.root) : null;
    return {
      ...p,
      label: "scala-cli",
      needs: ["scala"],
      run: act("run", "common.run", scalaCliRun(script), { shortcut: RUN }),
      build: act("build", "code.act.build", "scala-cli compile .", { shortcut: BUILD }),
      test: act("test", "code.act.test", "scala-cli test ."),
      more: [
        { id: "fmt", label: "scala-cli fmt", cmd: "scala-cli fmt ." },
        { id: "setup-ide", label: "scala-cli setup-ide", cmd: "scala-cli setup-ide ." },
        { id: "clean", label: "scala-cli clean", cmd: "scala-cli clean ." },
      ],
    };
  }

  if (p?.kind === "dune") {
    const target = pickExecutable(await findDuneExecutables(p.root), file, p.root);
    const dune = `${await ocamlShellPrefix()}dune`;
    return {
      ...p,
      label: "dune",
      needs: ["ocaml"],
      run: target ? act("run", "common.run", `${dune} exec ${q(duneTarget(target, "exe"))}`, { shortcut: RUN, usesFile: true }) : null,
      build: act("build", "code.act.build", `${dune} build`, { shortcut: BUILD }),
      test: act("test", "code.act.test", `${dune} test`),
      more: [{ id: "clean", label: "dune clean", cmd: `${dune} clean` }],
    };
  }

  if (p?.kind === "mojo") {
    // A project with a pixi manifest pins its own Mojo; without pixi, Omega's or the system's runs it.
    const manifest = (await fsApi.exists(joinPath(p.root, "pixi.toml"))) || (await fsApi.exists(joinPath(p.root, "mojoproject.toml")));
    // Where Mojo can't run, pixi can't fetch it either: `needs` then leads to the hint instead.
    const launcher = manifest && (await mojoInstallable()) && (await which("pixi")) ? await pixiMojoLauncher() : null;
    const pixi = !!launcher;
    const mojo = launcher ? `sh ${q(launcher)}` : "mojo";
    const entry = await mojoEntry(file, p.root);
    const relEntry = entry && rel(entry, p.root);
    const target = relEntry && q(relEntry.startsWith("-") ? `./${relEntry}` : relEntry);
    return {
      ...p,
      label: pixi ? "pixi" : "Mojo",
      needs: pixi ? ["cc"] : ["mojo", "cc"], // mojo links with the system's C compiler
      run: target ? act("run", "common.run", `${mojo} run ${target}`, { shortcut: RUN, usesFile: true }) : null,
      build: target ? act("build", "code.act.build", `mkdir -p build && ${mojo} build ${target} -o ${q(`build/${mojoStem(entry!)}`)}`, { shortcut: BUILD, usesFile: true }) : null,
      test: null, // Mojo 1.x has no test command
      more: [
        { id: "fmt", label: "mojo format", cmd: `${mojo} format .` },
        act("clean", "code.act.clean", rmrf("build")),
      ],
    };
  }

  // No project: run the single file with the language's default tool.
  if (!file) return null;
  const lang = langFor(file)?.id;
  const single = await singleFileRun(lang, file);
  if (!single) return null;
  const [cmd, needs, pre] = single;
  return {
    kind: "file",
    root: dirname(file),
    needs,
    get label() { return t("code.project.file"); },
    run: act("run", "common.run", cmd, { shortcut: RUN, pre, usesFile: true }),
    build: pre ? act("build", "code.act.build", pre, { shortcut: BUILD, usesFile: true }) : null,
    test: null,
    more: [],
  };
}

/** Main class scala-cli gives a script: `sub/my.sc` → `sub.my_sc`. Null if the name needs encoding. */
export function scalaScriptMain(relPath: string): string | null {
  const parts = relPath.replace(/\.sc$/, "_sc").split("/");
  return parts.every((s) => /^[A-Za-z_]\w*$/.test(s)) ? parts.join(".") : null;
}

/** Run in a scala-cli project: the open script (with the project's other sources), else the project. */
export function scalaCliRun(script: string | null): string {
  if (!script) return "scala-cli run .";
  const main = scalaScriptMain(script);
  return main ? `scala-cli run . --main-class ${main}` : `scala-cli run ${q(script.startsWith("-") ? `./${script}` : script)}`;
}

/** Compiler commands per OS: GCC on Linux, Apple clang on macOS, LLVM-MinGW clang on Windows. */
const C_COMPILER = OS === "linux" ? "gcc" : "clang";
const CXX_COMPILER = OS === "linux" ? "g++" : "clang++";

/** [run command, tools, compile step (run first in the Build terminal)] for a lone file. */
async function singleFileRun(lang: LangId | undefined, file: string): Promise<[string, ToolId[], string?] | null> {
  const f = q(file);
  const out = q(await tmpPath(exe(`omega-${basename(file).replace(/\.\w+$/, "")}`)));
  switch (lang) {
    case "python": return [`uv run ${f}`, ["uv"]];
    case "c": return [out, ["cc"], `${C_COMPILER} -g -Wall ${f} -o ${out}${OS === "linux" ? " -lm" : ""}`];
    case "cpp": return [out, ["cc"], `${CXX_COMPILER} -g -Wall -std=c++20 ${f} -o ${out}`];
    case "java": return [`java ${f}`, ["jdk"]];
    case "javascript": return [`node ${f}`, ["node"]];
    case "typescript": return [`${TSX_DLX} ${f}`, ["node", "pnpm"]];
    case "rust": return [out, ["rust"], `rustc -g ${f} -o ${out}`];
    case "scala": return [`scala-cli run ${f}`, ["scala"]];
    case "mojo": return mojoCompiles(file) ? [`mojo run ${f}`, ["mojo", "cc"]] : null; // Mojo 1.x refuses .🔥
    case "ocaml": return file.endsWith(".ml") ? [`${await ocamlShellPrefix()}ocaml ${f}`, ["ocaml"]] : null; // an interface doesn't run
    default: return null;
  }
}

/**
 * CMake configure command. Ninja is used when available and always on Windows (there, without
 * Visual Studio's cl.exe, the LLVM-MinGW clang is selected). clangd finds build/compile_commands.json
 * by itself, so no symlink is needed.
 */
export async function cmakeConfigure(dir: string, type: "Debug" | "Release"): Promise<{ cmd: string; needs: ToolId[] }> {
  const ninja = IS_WIN || !!(await which("ninja"));
  let cmd = `cmake -S . -B ${dir} -DCMAKE_BUILD_TYPE=${type} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`;
  if (ninja) cmd += " -G Ninja";
  if (IS_WIN && !(await which("cl"))) cmd += " -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++";
  return { cmd, needs: ninja ? ["cmake", "ninja", "cc"] : ["cmake", "cc"] };
}

// ---------------------------------------------------------------- new projects

export interface Template {
  id: string;
  label: string;
  tool: string;
  /** Tools needed to create (and later run) the project. */
  needs: ToolId[] | (() => Promise<ToolId[]>);
  /**
   * What to do for project `name`: files to write first (relative to the project folder), then
   * commands run in the Run terminal — in the project folder, or in `parent` when the tool creates
   * the folder itself (`inParent`).
   */
  create: (name: string) => Promise<{ files?: Record<string, string>; cmds: string[]; inParent?: boolean }>;
  /** File whose appearance means the project exists (relative to the project dir). */
  marker: string;
  /** Files to open afterwards, first existing wins (relative; {name} = project name). */
  open: string[];
  /** Editor mode to switch to after creating (default "code"). */
  mode?: "code" | "latex";
}

/**
 * Starter document for Tectonic (XeLaTeX engine): fontspec instead of inputenc/fontenc, babel in
 * the UI language. The build output goes to Omega's cache, so the folder stays clean.
 */
function latexMain(name: string): string {
  const [babel, intro, hello] = ({ en: ["english", "Introduction", "Hello, world!"], de: ["ngerman", "Einleitung", "Hallo, Welt!"], fr: ["french", "Introduction", "Bonjour, le monde\\,!"] } as const)[i18n.locale];
  return `\\documentclass[11pt, a4paper]{article}

\\usepackage{fontspec}
\\usepackage[${babel}]{babel}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{hyperref}

\\title{${name.replace(/_/g, "\\_")}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{${intro}}

${hello} \\(E = mc^2\\)

\\end{document}
`;
}

const gitInit = async () => ((await which("git")) ? ["git init -q"] : []);

const cmakeProject = (name: string, cxx: boolean) => async () => {
  const ext = cxx ? "cpp" : "c";
  const lists = `cmake_minimum_required(VERSION 3.20)\nproject(${name} ${cxx ? "CXX" : "C"})\n\nset(CMAKE_${cxx ? "CXX" : "C"}_STANDARD ${cxx ? 20 : 17})\nset(CMAKE_EXPORT_COMPILE_COMMANDS ON)\n\nadd_executable(${name} src/main.${ext})\n`;
  const main = cxx
    ? `#include <iostream>\n\nint main() {\n    std::cout << "${t("code.tpl.hello")}" << std::endl;\n    return 0;\n}\n`
    : `#include <stdio.h>\n\nint main(void) {\n    printf("${t("code.tpl.hello")}\\n");\n    return 0;\n}\n`;
  return {
    files: { "CMakeLists.txt": lists, [`src/main.${ext}`]: main, ".gitignore": "build/\nbuild-release/\n" },
    cmds: [...(await gitInit()), (await cmakeConfigure("build", "Debug")).cmd],
  };
};

const packageJson = (name: string, extra: Record<string, unknown>) => JSON.stringify({ name, version: "0.1.0", private: true, ...extra }, null, 2) + "\n";

export const TEMPLATES: Template[] = [
  // Plain folder, no tooling: created directly via the fs API (see createProject).
  { id: "empty", get label() { return t("code.tpl.empty"); }, get tool() { return t("code.tpl.folderOnly"); }, needs: [], marker: "", open: [], create: async () => ({ cmds: [] }) },
  { id: "rust", label: "Rust", tool: "cargo new", needs: ["rust"], marker: "Cargo.toml", open: ["src/main.rs"], create: async (n) => ({ inParent: true, cmds: [`cargo new ${q(n)}`] }) },
  { id: "python", label: "Python", tool: "uv init", needs: ["uv"], marker: "pyproject.toml", open: ["main.py", "src/{name}/__init__.py", "hello.py"], create: async (n) => ({ inParent: true, cmds: [`uv init --app --no-package ${q(n)}`, cd(n), "uv sync"] }) },
  {
    id: "typescript",
    label: "TypeScript",
    tool: "pnpm + tsx",
    needs: ["node", "pnpm"],
    marker: "package.json",
    open: ["src/index.ts"],
    create: async (n) => ({
      files: {
        "package.json": packageJson(n, { type: "module", scripts: { dev: "tsx watch src/index.ts", start: "tsx src/index.ts", build: "tsc" } }),
        "src/index.ts": `console.log("${t("code.tpl.hello")}");\n`,
        ".gitignore": "node_modules/\ndist/\n",
        // tsx needs esbuild's postinstall. pnpm 10+ blocks unapproved build scripts and fails the
        // install (so `tsc --init` never ran); allowBuilds is pnpm 11+, onlyBuiltDependencies pnpm 10.
        "pnpm-workspace.yaml": "allowBuilds:\n  esbuild: true\nonlyBuiltDependencies:\n  - esbuild\n",
      },
      cmds: [...(await gitInit()), "pnpm add -D typescript tsx @types/node", "pnpm exec tsc --init --target es2022 --module nodenext --rootDir src --outDir dist"],
    }),
  },
  {
    id: "javascript",
    label: "JavaScript",
    tool: "pnpm",
    needs: ["node", "pnpm"],
    marker: "package.json",
    open: ["index.js"],
    create: async (n) => ({
      files: { "package.json": packageJson(n, { type: "module", scripts: { start: "node index.js" } }), "index.js": `console.log("${t("code.tpl.hello")}");\n`, ".gitignore": "node_modules/\n" },
      cmds: [...(await gitInit())],
    }),
  },
  { id: "cpp", label: "C++", tool: "CMake", needs: async () => (await cmakeConfigure("build", "Debug")).needs, marker: "CMakeLists.txt", open: ["src/main.cpp"], create: (n) => cmakeProject(n, true)() },
  { id: "c", label: "C", tool: "CMake", needs: async () => (await cmakeConfigure("build", "Debug")).needs, marker: "CMakeLists.txt", open: ["src/main.c"], create: (n) => cmakeProject(n, false)() },
  {
    id: "java",
    label: "Java",
    tool: "Gradle",
    needs: ["jdk", "gradle"],
    marker: "settings.gradle.kts",
    open: ["app/src/main/java/app/App.java"],
    create: async (n) => ({
      cmds: [`gradle init --type java-application --dsl kotlin --test-framework junit-jupiter --package app --project-name ${q(n)} --no-split-project --java-version 21 --use-defaults --no-incubating`],
    }),
  },
  {
    id: "scala",
    label: "Scala",
    tool: "scala-cli",
    needs: ["scala"],
    marker: "project.scala",
    open: ["Main.scala"],
    create: async () => ({
      files: {
        // The marker comes first: the dialog opens the project as soon as it exists.
        "project.scala": "//> using scala lts\n",
        "Main.scala": `@main def hello(): Unit =\n  println("${t("code.tpl.hello")}")\n`,
        ".gitignore": ".bsp/\n.bloop/\n.metals/\n.scala-build/\n",
      },
      cmds: [...(await gitInit()), "scala-cli setup-ide ."],
    }),
  },
  {
    id: "ocaml",
    label: "OCaml",
    tool: "dune",
    needs: ["ocaml"],
    marker: "dune-project",
    open: ["bin/main.ml"],
    create: async () => ({
      files: {
        // The marker comes first: the dialog opens the project as soon as it exists.
        // Bytecode and unmapped source paths are what Earlybird needs to debug; Run stays native.
        "dune-project": "(lang dune 3.7)\n(map_workspace_root false)\n",
        "bin/dune": "(executable\n (name main)\n (modes byte exe))\n",
        "bin/main.ml": `let () = print_endline "${t("code.tpl.hello")}"\n`,
        ".gitignore": "_build/\n",
      },
      // The first build writes the config ocamllsp reads.
      cmds: [...(await gitInit()), `${await ocamlShellPrefix()}dune build`],
    }),
  },
  {
    id: "mojo",
    label: "Mojo",
    tool: "mojo",
    // Where Mojo can't run, the project is still created: it opens with highlighting and the hint.
    needs: async () => ((await mojoInstallable()) ? ["mojo", "cc"] : []),
    marker: "pixi.toml",
    open: ["main.mojo"],
    create: async (n) => ({
      files: {
        // The marker comes first: the dialog opens the project as soon as it exists.
        "pixi.toml": `[workspace]\nname = ${JSON.stringify(n)}\nchannels = ["https://conda.modular.com/max", "conda-forge"]\nplatforms = ["linux-64", "linux-aarch64", "osx-arm64"]\n\n[dependencies]\nmojo = ">=1.2,<25"\n`,
        "main.mojo": `def main():\n    print("${t("code.tpl.hello")}")\n`,
        ".gitignore": ".pixi/\nbuild/\n",
      },
      cmds: [...(await gitInit())],
    }),
  },
  {
    id: "latex",
    label: "LaTeX",
    tool: "Tectonic",
    needs: ["tectonic"],
    marker: "main.tex",
    open: ["main.tex"],
    mode: "latex",
    create: async (n) => ({ files: { "main.tex": latexMain(n) }, cmds: [...(await gitInit())] }),
  },
];
