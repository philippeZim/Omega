/** Per-language debug setup: adapter installation, build step and DAP launch configuration. */
import { invoke } from "@tauri-apps/api/core";
import { fsApi, basename, dirname, joinPath } from "../api";
import { langFor } from "../code/languages";
import { detectProject, pythonEntry, cmakeConfigure, cmakeExecutable } from "../code/projects";
import { duneProjectIssue, duneSourcePath, nearestDuneProject, duneTarget, findDuneExecutables, pickExecutable, sameToolchain } from "../code/dune";
import { OCAML_PROGRAM_ENV, managedOcaml } from "../code/ocamlTools";
import { toolsDir, clientFor, fileUri, javaDebugBundles, metalsPausedFor, ocamlPauseRoot } from "../code/lsp.svelte";
import { onGuestChange, toolPausedBy } from "../collab/guestChanges";
import { t } from "../i18n/index.svelte";
import { exe, tmpPath, venvPython, IS_WIN, OS } from "../platform";
import { ensureTools, withInstallProgress, type ToolId } from "../tools.svelte";

type Json = any;

export interface Plan {
  label: string;
  cwd: string;
  adapter:
    | { kind: "stdio"; cmd: string; args: string[]; env?: Record<string, string> }
    | { kind: "tcp"; cmd: string; args: string[]; env?: Record<string, string> }
    | { kind: "port"; port: number };
  launch: Json;
  /** The file to show for a path the adapter reports (a build copy → its source). */
  sourcePath?: (path: string) => Promise<string>;
}

export interface Ctx {
  file: string;
  workspace: string | null;
  log: (text: string, kind?: "info" | "error" | "build") => void;
  askInstall: (name: string) => Promise<boolean>;
  /** The start was stopped or replaced: long waits end, nothing may be left behind. */
  cancelled?: () => boolean;
}

const exists = (p: string) => fsApi.exists(p);
const which = (c: string) => invoke<string | null>("which_cmd", { cmd: c });

async function capture(cmd: string, args: string[], cwd: string, ctx: Ctx) {
  ctx.log(`$ ${cmd} ${args.join(" ")}`, "build");
  const r = await invoke<{ code: number; stdout: string; stderr: string }>("run_capture", { cmd, args, cwd });
  if (r.code !== 0) {
    ctx.log((r.stderr || r.stdout).trim(), "error");
    throw new Error(t("code.ad.buildFailed"));
  }
  return r;
}

async function ensure(kind: "codelldb" | "debugpy" | "jsdebug" | "javadebug", path: string, name: string, ctx: Ctx) {
  if (await exists(path)) return;
  if (!(await ctx.askInstall(name))) throw new Error(t("code.ad.required", { name }));
  ctx.log(t("code.ad.installing", { name }));
  await withInstallProgress(kind, name, () => invoke("install_debugger", { kind }));
  ctx.log(t("code.ad.installed", { name }));
}

async function codelldb(ctx: Ctx) {
  const adapter = `${await toolsDir()}/codelldb/extension/adapter/${exe("codelldb")}`;
  await ensure("codelldb", adapter, t("code.ad.codelldb"), ctx);
  return { kind: "tcp" as const, cmd: adapter, args: ["--port", "{port}"] };
}

async function need(ids: ToolId[]) {
  if (!(await ensureTools(ids, t("tools.purpose.debug")))) throw new Error(t("code.ad.required", { name: ids.join(", ") }));
}

/** A Python interpreter: the project's venv, one on the PATH, or one installed by uv. */
async function findPython(root: string, ctx: Ctx): Promise<string> {
  const venvPy = venvPython(joinPath(root, ".venv"));
  if (await exists(venvPy)) return venvPy;
  for (const c of IS_WIN ? ["python", "py"] : ["python3", "python"]) {
    const p = await which(c);
    // Windows' "python.exe" in WindowsApps is only a Store installer stub.
    if (p && !/WindowsApps/i.test(p)) return p;
  }
  await need(["uv"]);
  let r = await invoke<{ code: number; stdout: string }>("run_capture", { cmd: "uv", args: ["python", "find"], cwd: root });
  if (r.code !== 0) {
    await capture("uv", ["python", "install"], root, ctx);
    r = await invoke<{ code: number; stdout: string }>("run_capture", { cmd: "uv", args: ["python", "find"], cwd: root });
  }
  return r.stdout.trim().replace(/\\/g, "/");
}

/** Path of the CMake build output, resolved the same way as Run (variables, comments). */
export function cmakeProgram(root: string, lists: string): string {
  return joinPath(root, `build/${exe(cmakeExecutable(lists) ?? basename(root))}`);
}

/** Port of the session Metals' `debug-adapter-start` returned ("tcp://127.0.0.1:5005"). */
export function metalsDebugPort(uri: string): number {
  const port = Number(/:(\d+)\/?$/.exec(uri)?.[1]);
  if (!port) throw new Error(t("code.ad.scalaNoSession"));
  return port;
}

/** How long a Scala debug start waits: for the first build import, and for a main class after compiling. */
export const scalaDebugWait = { importMs: 5 * 60_000, mainMs: 30_000, pollMs: 2000 };

/**
 * Asks Metals for a debug session. Right after opening a project it may still import or compile
 * (it reports "no build target" or "no main"), so those answers are retried for a while.
 */
export async function startScalaSession<T>(start: () => Promise<T>, ctx: Pick<Ctx, "log" | "cancelled">, wait = scalaDebugWait): Promise<T> {
  const begin = Date.now();
  let told = false;
  for (;;) {
    if (ctx.cancelled?.()) throw new Error(t("code.ad.scalaNoSession"));
    try {
      return await start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const limit = /no main/i.test(msg) ? wait.mainMs : /build target|timeout/i.test(msg) ? wait.importMs : 0;
      if (Date.now() - begin >= limit) throw e;
      if (!told) ctx.log(t("code.ad.scalaWaitBuild"));
      told = true;
      await new Promise((r) => setTimeout(r, wait.pollMs));
    }
  }
}

/** Ends a Metals debug session nobody will use: it waits for a client, so connect and disconnect. */
export async function dropScalaSession(port: number) {
  const id = `scala-drop-${port}`;
  try {
    await invoke("proc_connect", { id, port });
    await invoke("proc_send", { id, msg: JSON.stringify({ seq: 1, type: "request", command: "disconnect", arguments: { terminateDebuggee: true } }) });
  } catch {
    // Already gone.
  }
  await invoke("proc_kill", { id }).catch(() => {});
}

let buildRuns = 0;

/**
 * A build that a guest change stops at once. The kill is repeated until the build has ended,
 * because a change can arrive before the backend has registered the process.
 */
export async function buildUnlessPaused(cmd: string, args: string[], cwd: string, ctx: Pick<Ctx, "log">, paused: () => boolean) {
  const stopped = () => new Error(t("code.lsp.ocamlPaused"));
  if (paused()) throw stopped();
  const id = `ocaml-build-${++buildRuns}`;
  const kill = () => void invoke("proc_kill", { id }).catch(() => {});
  let again: ReturnType<typeof setInterval> | undefined;
  const off = onGuestChange(() => {
    if (again !== undefined || !paused()) return;
    kill();
    again = setInterval(kill, 100);
  });
  ctx.log(`$ ${cmd} ${args.join(" ")}`, "build");
  try {
    const r = await invoke<{ code: number; stdout: string; stderr: string }>("run_killable", { id, cmd, args, cwd });
    if (paused()) throw stopped();
    if (r.code !== 0) {
      ctx.log((r.stderr || r.stdout).trim(), "error");
      throw new Error(t("code.ad.buildFailed"));
    }
    return r;
  } finally {
    off();
    clearInterval(again);
  }
}

/** Earlybird from the same switch as the compiler that builds the bytecode, installed if missing. */
async function earlybird(ctx: Ctx): Promise<string> {
  // With Omega's compiler only Omega's Earlybird fits, whatever else is on the PATH.
  const managed = await managedOcaml("ocamlc");
  const find = () => (managed ? managedOcaml("ocamlearlybird") : which("ocamlearlybird"));
  let cmd = await find();
  if (!cmd) {
    const name = "Earlybird";
    if (!(await ctx.askInstall(name))) throw new Error(t("code.ad.required", { name }));
    ctx.log(t("code.ad.installing", { name }));
    await withInstallProgress("earlybird", name, () => invoke("install_debugger", { kind: "earlybird" }));
    ctx.log(t("code.ad.installed", { name }));
    cmd = await find();
    if (!cmd) throw new Error(t("code.ad.required", { name }));
  }
  const compiler = managed ?? (await which("ocamlc"));
  if (!sameToolchain(cmd, compiler)) throw new Error(t("code.ad.ocamlMismatch", { adapter: dirname(cmd), compiler: compiler ? dirname(compiler) : "ocamlc" }));
  return cmd;
}

/** The bytecode target to debug. Never changes the project's dune files: it says what to add. */
async function ocamlDebugTarget(root: string, file: string) {
  const target = pickExecutable(await findDuneExecutables(root), file, root);
  if (!target) throw new Error(t("code.ad.ocamlNoExe"));
  const projectFile = (await nearestDuneProject(root, target.dir, exists)) ?? "dune-project";
  const issue = duneProjectIssue(await fsApi.readFile(joinPath(root, projectFile)).catch(() => ""));
  if (issue) throw new Error(t(issue === "lang" ? "code.ad.ocamlNeedsLang" : "code.ad.ocamlNeedsMap", { file: projectFile }));
  if (!target.byte) throw new Error(t("code.ad.ocamlNoByte", { name: target.name, file: joinPath(target.dir || ".", "dune") }));
  return target;
}

export async function planFor(ctx: Ctx): Promise<Plan> {
  const lang = langFor(ctx.file)?.id;
  const project = await detectProject(ctx.file, ctx.workspace);
  const root = project?.root ?? dirname(ctx.file);
  const tools = await toolsDir();

  switch (lang) {
    case "python": {
      const dir = `${tools}/debugpy`;
      const venvPy = venvPython(joinPath(root, ".venv"));
      if (project?.kind === "uv" && !(await exists(venvPy))) {
        await need(["uv"]);
        await capture("uv", ["sync"], root, ctx);
      }
      const python = await findPython(root, ctx);
      if (!(await exists(`${dir}/debugpy`))) await need(["uv"]);
      await ensure("debugpy", `${dir}/debugpy`, t("code.ad.debugpy"), ctx);
      // Package projects without a __main__ guard: debug the [project.scripts] entry point.
      let program = ctx.file;
      const entry = await pythonEntry(ctx.file, root);
      if (entry.kind === "script") {
        const [mod, fn = "main"] = entry.target.split(":");
        program = await tmpPath(`omega-entry-${entry.name}.py`);
        await fsApi.writeFile(program, `# Generated by Omega to debug the "${entry.name}" entry point\nfrom ${mod} import ${fn}\n\nraise SystemExit(${fn}())\n`);
        ctx.log(t("code.ad.entryPoint", { name: entry.name, target: entry.target }));
      }
      return {
        label: `Python · ${entry.kind === "script" ? entry.name : basename(ctx.file)}`,
        cwd: root,
        adapter: { kind: "stdio", cmd: python, args: ["-m", "debugpy.adapter"], env: { PYTHONPATH: dir } },
        launch: { type: "python", request: "launch", name: "Python", program, cwd: root, python, console: "integratedTerminal", justMyCode: true, redirectOutput: false },
      };
    }

    case "rust": {
      let program: string;
      await need(["rust"]);
      if (project?.kind === "cargo") {
        const r = await capture("cargo", ["build", "--message-format=json-render-diagnostics"], root, ctx);
        const exes = r.stdout
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .map((l) => JSON.parse(l))
          .filter((m) => m.reason === "compiler-artifact" && m.executable && m.target?.kind?.includes("bin"));
        if (!exes.length) throw new Error(t("code.ad.noBin"));
        // Prefer the binary whose sources contain the open file.
        const best = exes.find((m) => ctx.file.startsWith(dirname(m.target.src_path))) ?? exes[exes.length - 1];
        program = best.executable;
      } else {
        program = await tmpPath(exe(`omega-dbg-${basename(ctx.file).replace(/\.rs$/, "")}`));
        await capture("rustc", ["-g", ctx.file, "-o", program], root, ctx);
      }
      return {
        label: `Rust · ${basename(program)}`,
        cwd: root,
        adapter: await codelldb(ctx),
        launch: { type: "lldb", request: "launch", name: "Rust", program, args: [], cwd: root, terminal: "integrated", sourceLanguages: ["rust"] },
      };
    }

    case "c":
    case "cpp": {
      let program: string;
      if (project?.kind === "cmake") {
        const cfg = await cmakeConfigure("build", "Debug");
        await need(cfg.needs);
        if (!(await exists(joinPath(root, "build/CMakeCache.txt")))) {
          const [cmd, ...args] = cfg.cmd.split(" ");
          await capture(cmd, args, root, ctx);
        }
        await capture("cmake", ["--build", "build"], root, ctx);
        const lists = await fsApi.readFile(joinPath(root, "CMakeLists.txt")).catch(() => "");
        program = cmakeProgram(root, lists);
      } else {
        await need(["cc"]);
        program = await tmpPath(exe(`omega-dbg-${basename(ctx.file).replace(/\.\w+$/, "")}`));
        const linux = OS === "linux";
        const cc = lang === "c" ? (linux ? "gcc" : "clang") : linux ? "g++" : "clang++";
        await capture(cc, ["-g", "-O0", ...(lang === "cpp" ? ["-std=c++20"] : []), ctx.file, "-o", program, ...(lang === "c" && linux ? ["-lm"] : [])], root, ctx);
      }
      return {
        label: `${lang === "c" ? "C" : "C++"} · ${basename(program)}`,
        cwd: root,
        adapter: await codelldb(ctx),
        launch: { type: "lldb", request: "launch", name: "Native", program, args: [], cwd: root, terminal: "integrated" },
      };
    }

    case "javascript":
    case "typescript": {
      const server = `${tools}/js-debug/src/dapDebugServer.js`;
      await need(lang === "typescript" ? ["node", "pnpm"] : ["node"]);
      await ensure("jsdebug", server, t("code.ad.jsdebug"), ctx);
      const node = (await which("node")) ?? "node";
      const launch: Json = { type: "pwa-node", request: "launch", name: "Node", program: ctx.file, cwd: root, console: "integratedTerminal", sourceMaps: true, skipFiles: ["<node_internals>/**"] };
      if (lang === "typescript") {
        const tsx = joinPath(root, IS_WIN ? "node_modules/.bin/tsx.cmd" : "node_modules/.bin/tsx");
        if (await exists(tsx)) launch.runtimeExecutable = tsx;
        else {
          launch.runtimeExecutable = (await which("pnpm")) ?? "npx";
          launch.runtimeArgs = /pnpm(\.exe|\.cmd)?$/i.test(launch.runtimeExecutable) ? ["dlx", "tsx"] : ["-y", "tsx"];
        }
      }
      return { label: `Node · ${basename(ctx.file)}`, cwd: root, adapter: { kind: "tcp", cmd: node, args: [server, "{port}", "127.0.0.1"] }, launch };
    }

    case "java": {
      const dir = `${tools}/java-debug`;
      await need(["jdk"]);
      const hasJar = (await javaDebugBundles()).length > 0;
      if (!hasJar) await ensure("javadebug", `${dir}/__missing__`, t("code.ad.javadebug"), ctx);
      const lsp = await clientFor(langFor(ctx.file)!, ctx.file, ctx.workspace, async () => ctx.askInstall("Eclipse JDT Language Server"), true);
      if (!lsp) throw new Error(t("code.ad.noJavaLsp"));
      ctx.log(t("code.ad.resolvingMain"));
      const mains: Json[] = (await lsp.request("workspace/executeCommand", { command: "vscode.java.resolveMainClass", arguments: [] }, 60000)) ?? [];
      const main = mains.find((m) => m.filePath === ctx.file) ?? mains[0];
      if (!main) throw new Error(t("code.ad.noMain"));
      const [modulePaths, classPaths] = await lsp.request("workspace/executeCommand", { command: "vscode.java.resolveClasspath", arguments: [main.mainClass, main.projectName] }, 60000);
      const port: number = await lsp.request("workspace/executeCommand", { command: "vscode.java.startDebugSession", arguments: [] }, 30000);
      return {
        label: `Java · ${main.mainClass}`,
        cwd: root,
        adapter: { kind: "port", port },
        launch: { type: "java", request: "launch", name: "Java", mainClass: main.mainClass, projectName: main.projectName, modulePaths, classPaths, cwd: root, console: "integratedTerminal" },
      };
    }

    case "scala": {
      await need(["jdk"]);
      // Metals' debugger attaches through the JDK's debug interface (JDI), which a JRE lacks.
      if (!(await which("javac"))) throw new Error(t("code.ad.scalaNeedsJdk"));
      const lsp = await clientFor(langFor(ctx.file)!, ctx.file, ctx.workspace, async () => ctx.askInstall("Metals"));
      const paused = () => metalsPausedFor(ctx.file, ctx.workspace);
      if (!lsp) throw new Error(t((await paused()) ? "code.lsp.metalsPaused" : "code.ad.noScalaLsp"));
      const session = await startScalaSession(
        () => lsp.request<{ name: string; uri: string }>("workspace/executeCommand", { command: "debug-adapter-start", arguments: [{ path: fileUri(ctx.file), runType: "run" }] }, 60000),
        ctx,
      ).catch(async (e) => {
        throw (await paused()) ? new Error(t("code.lsp.metalsPaused")) : e;
      });
      const port = metalsDebugPort(session.uri);
      if (ctx.cancelled?.()) {
        await dropScalaSession(port);
        throw new Error(t("code.ad.scalaNoSession"));
      }
      return {
        label: `Scala · ${session.name}`,
        cwd: lsp.root,
        adapter: { kind: "port", port },
        launch: { type: "scala", request: "launch", name: "Scala", noDebug: false },
      };
    }

    case "ocaml": {
      // Debugging builds and runs the project: it waits for the host's decision like ocamllsp.
      const pauseRoot = await ocamlPauseRoot(ctx.file, ctx.workspace);
      const paused = () => toolPausedBy("ocaml", pauseRoot) !== null || toolPausedBy("ocaml", root) !== null;
      const held = () => {
        if (paused()) throw new Error(t("code.lsp.ocamlPaused"));
      };
      held();
      await need(["ocaml"]);
      if (project?.kind !== "dune") throw new Error(t("code.ad.ocamlNeedsDune"));
      const target = await ocamlDebugTarget(root, ctx.file);
      const adapter = await earlybird(ctx);
      const bc = duneTarget(target, "bc");
      const managedDune = await managedOcaml("dune");
      await buildUnlessPaused(managedDune ?? "dune", ["build", bc], root, ctx, paused);
      held();
      return {
        label: `OCaml · ${target.name}.bc`,
        cwd: root,
        adapter: { kind: "stdio", cmd: adapter, args: ["debug"] },
        launch: { type: "ocaml.earlybird", request: "launch", name: "OCaml", program: joinPath(root, `_build/default/${bc.slice(2)}`), cwd: root, stopOnEntry: false, console: "integratedTerminal", ...(managedDune ? { env: OCAML_PROGRAM_ENV } : {}) },
        // Earlybird reports dune's copies. Generated files have no source, so they stay as they are.
        sourcePath: async (p) => {
          const source = duneSourcePath(root, p);
          return source !== p && (await exists(source)) ? source : p;
        },
      };
    }
  }
  throw new Error(t("code.ad.noDebugger"));
}
