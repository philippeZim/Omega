import { afterEach, describe, expect, test, vi, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { getIndentation, indentUnit } from "@codemirror/language";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
const ipc = vi.hoisted(() => ({ calls: [] as string[], sent: [] as string[], metals: false, javac: false, onWhich: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, a?: { cmd?: string; msg?: string }) => {
    ipc.calls.push(cmd);
    if (cmd === "proc_send") ipc.sent.push(a!.msg!);
    if (cmd === "tools_dir") return "/tools";
    if (cmd !== "which_cmd") return null;
    if (a?.cmd === "javac" && ipc.javac) return "/usr/bin/javac";
    if (!ipc.metals || !a?.cmd?.endsWith("metals")) return null;
    const hook = ipc.onWhich;
    ipc.onWhich = null;
    hook?.();
    return "/tools/metals/metals";
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("../tools.svelte", async (orig) => ({ ...(await orig<typeof import("../tools.svelte")>()), ensureTools: async () => true }));
vi.mock("../platform", async (orig) => ({ ...(await orig<typeof import("../platform")>()), tmpPath: async (n: string) => `/tmp/${n}` }));

const files = new Set<string>();
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fsApi: { exists: async (p: string) => files.has(p), readFile: async () => "", listDir: async () => [] },
}));

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { modeForExtension } from "../modes";
import { langFor, scalaOpensBlock, indentFor } from "./languages";
import { detectProject, scalaCliRun, scalaScriptMain, TEMPLATES } from "./projects";
import { allClients, clientFor, lspState, metalsAnswer, neverInstall, restartServer, stopServers, type LspClient } from "./lsp.svelte";
import { isPaused, toolsBeforeSave, metalsChangeCount, metalsPausedBy, noteGuestChange, resumeCompiling, resumeMetals } from "../collab/guestChanges";
import { ui } from "../ui.svelte";
import { dropScalaSession, metalsDebugPort, planFor, startScalaSession } from "../debug/adapters";
import { t } from "../i18n/index.svelte";
import { q } from "../platform";

beforeEach(() => {
  files.clear();
  ipc.calls.length = 0;
  ipc.sent.length = 0;
  ipc.metals = ipc.javac = false;
  ipc.onWhich = null;
});

describe("Scala files", () => {
  test.each(["a.scala", "b.sc"])("%s opens in Code mode with Metals", (f) => {
    expect(modeForExtension(f.split(".")[1])).toBe("code");
    expect(langFor(f)).toMatchObject({ id: "scala", lspId: "scala", server: "scala" });
  });

  test.each(["def f =", "class A:", "case x =>", "if a then", "for x <- xs do", "x match", "val s = // sum", "  try"])("%s opens a block", (l) => {
    expect(scalaOpensBlock(l)).toBe(true);
  });

  test.each(["val a = 1", 'println("a =")', "x == y // then", "a >= b", "}"])("%s does not", (l) => {
    expect(scalaOpensBlock(l)).toBe(false);
  });

  const indentAfter = (text: string) => {
    const lang = langFor("a.scala")!;
    const state = EditorState.create({ doc: text + "\n", extensions: [lang.ext(), indentFor(lang)] });
    return { indent: getIndentation(state, state.doc.length), unit: state.facet(indentUnit) };
  };

  test("indents two spaces after a braceless block opener", () => {
    expect(indentAfter("@main def hello(): Unit =")).toEqual({ indent: 2, unit: "  " });
  });
});

describe("Scala project detection", () => {
  test("build.sbt keeps a project on sbt, also next to a project.scala", async () => {
    files.add("/w/build.sbt").add("/w/project.scala");
    const p = await detectProject("/w/src/main/scala/Main.scala", "/w");
    expect(p).toMatchObject({ kind: "sbt", root: "/w", needs: ["jdk", "sbt"] });
    expect([p!.run!.cmd, p!.build!.cmd, p!.test!.cmd]).toEqual(["sbt -batch run", "sbt -batch compile", "sbt -batch test"]);
  });

  test("build.sbt wins over package.json (Scala.js)", async () => {
    files.add("/w/build.sbt").add("/w/package.json");
    expect(await detectProject("/w/src/main/scala/Main.scala", "/w")).toMatchObject({ kind: "sbt" });
  });

  test("the other languages keep their order around it", async () => {
    files.add("/w/build.sbt").add("/w/Cargo.toml");
    expect((await detectProject("/w/a.rs", "/w"))!.kind).toBe("cargo");
    files.clear();
    files.add("/w/build.sbt").add("/w/pyproject.toml");
    expect((await detectProject("/w/a.py", "/w"))!.kind).toBe("uv");
    files.clear();
    files.add("/w/build.sbt").add("/w/build.gradle");
    expect((await detectProject("/w/A.java", "/w"))!.kind).toBe("gradle");
    files.clear();
    files.add("/w/package.json").add("/w/project.scala");
    expect((await detectProject("/w/a.ts", "/w"))!.kind).toBe("pnpm");
  });

  test("project.scala is a scala-cli project", async () => {
    files.add("/w/project.scala");
    const p = await detectProject("/w/Main.scala", "/w");
    expect(p).toMatchObject({ kind: "scala-cli", root: "/w", needs: ["scala"] });
    expect(p!.run!.cmd).toBe("scala-cli run .");
  });

  test("an open script runs as its own main class", async () => {
    files.add("/w/project.scala");
    expect((await detectProject("/w/sub/tool.sc", "/w"))!.run!.cmd).toBe("scala-cli run . --main-class sub.tool_sc");
  });

  test("a lone file runs through scala-cli", async () => {
    const p = await detectProject("/w/a.sc", "/w");
    expect(p).toMatchObject({ kind: "file", needs: ["scala"] });
    expect(p!.run!.cmd).toContain("scala-cli run");
  });

  test("script main class names", () => {
    expect(scalaScriptMain("a.sc")).toBe("a_sc");
    expect(scalaScriptMain("sub/b.sc")).toBe("sub.b_sc");
    expect(scalaScriptMain("my-tool.sc")).toBeNull();
    expect(scalaCliRun("my-tool.sc")).toContain("scala-cli run ");
    expect(scalaCliRun("my-tool.sc")).not.toContain("--main-class");
    expect(scalaCliRun("-x.sc")).toBe(`scala-cli run ${q("./-x.sc")}`);
  });

  test("the template is a scala-cli project", async () => {
    const tpl = TEMPLATES.find((x) => x.id === "scala")!;
    const plan = await tpl.create("demo");
    expect(tpl.marker).toBe("project.scala");
    expect(Object.keys(plan.files!)).toEqual(expect.arrayContaining(["project.scala", "Main.scala", ".gitignore"]));
    expect(plan.cmds.at(-1)).toBe("scala-cli setup-ide .");
  });
});

describe("Metals", () => {
  const titles = (...t: string[]) => ({ actions: t.map((title) => ({ title })) });

  test("imports the build and prefers sbt, ignores other prompts", () => {
    expect(metalsAnswer(titles("Import build", "Not now"))).toEqual({ title: "Import build" });
    expect(metalsAnswer(titles("Import changes", "Dismiss"))).toEqual({ title: "Import changes" });
    expect(metalsAnswer(titles("scala-cli", "sbt"))).toEqual({ title: "sbt" });
    expect(metalsAnswer(titles("Start", "Not now", "Don't show again"))).toBeNull();
    expect(metalsAnswer({})).toBeNull();
  });

  test("reads the port of a debug session", () => {
    expect(metalsDebugPort("tcp://127.0.0.1:41505")).toBe(41505);
    expect(() => metalsDebugPort("nonsense")).toThrow();
  });

  test("debugging with only a JRE (no javac) stops with a clear error", async () => {
    const ctx = { file: "/w/Main.scala", workspace: "/w", log() {}, askInstall: async () => false };
    await expect(planFor(ctx)).rejects.toThrow(t("code.ad.scalaNeedsJdk"));
  });

  const wait = { importMs: 60, mainMs: 25, pollMs: 5 };

  test("retries while the build is not ready", async () => {
    const log = vi.fn();
    let n = 0;
    const r = await startScalaSession(async () => {
      if (n++ < 2) throw new Error("No main could be found in build target: root");
      return "ok";
    }, { log }, wait);
    expect(r).toBe("ok");
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("gives up on a missing main class after its shorter wait", async () => {
    const start = Date.now();
    await expect(startScalaSession(async () => { throw new Error("No main could be found"); }, { log() {} }, wait)).rejects.toThrow("No main");
    expect(Date.now() - start).toBeLessThan(55);
  });

  test("other errors are not retried", async () => {
    const start = vi.fn(async () => { throw new Error("boom"); });
    await expect(startScalaSession(start, { log() {} }, wait)).rejects.toThrow("boom");
    expect(start).toHaveBeenCalledTimes(1);
  });
});

// Metals executes build.sbt and the argv in .bsp/*.json, so text from a guest without `run` must not reach it.
describe("Metals in Code Together", () => {
  const lang = langFor("/g/Main.scala")!;
  const spawned = () => ipc.calls.includes("proc_spawn");
  const running = () => allClients().filter((c) => c.kind === "scala" && !c.stopping);
  // A test's server never answers `initialize`, so every test gets its own project.
  let n = 0, root = "", file = "";

  beforeEach(() => {
    ipc.metals = true;
    root = `/g${++n}`;
    file = `${root}/Main.scala`;
    files.add(`${root}/project.scala`);
  });
  afterEach(() => {
    resumeMetals(root, metalsChangeCount());
    resumeCompiling("", root);
    stopServers("scala");
  });

  const started = async () => {
    void clientFor(lang, file, root, async () => true);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    return running()[0];
  };
  const answerTo = (c: LspClient) => {
    ipc.sent.length = 0;
    (c as any).handle({ id: 7, method: "window/showMessageRequest", params: { actions: [{ title: "Import build" }] } });
    return JSON.parse(ipc.sent.at(-1)!).result;
  };

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
  });

  test("a guest change during the install keeps it from starting", async () => {
    ipc.metals = false;
    const ask = async () => {
      noteGuestChange("peer", root);
      ipc.metals = true;
      return true;
    };
    expect(await clientFor(lang, file, root, ask)).toBeNull();
    expect(ipc.calls).toContain("install_server");
    expect(spawned()).toBe(false);
    expect(lspState.status[`scala|${root}`]).toBe("stopped");
    expect(lspState.message[`scala|${root}`]).toBe(t("code.lsp.metalsPaused"));
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

  test("the build is imported normally, but not while stopping or paused", async () => {
    const c = await started();
    expect(answerTo(c)).toEqual({ title: "Import build" });
    c.stopping = true;
    expect(answerTo(c)).toBeNull();
    c.stopping = false;
    noteGuestChange("peer", root);
    c.stopping = false; // the pause alone must be enough
    expect(answerTo(c)).toBeNull();
  });

  test.each([
    ["with a folder", () => root],
    ["without a folder", () => null],
  ])("a guest's unsaved tab saved as build.sbt (%s) stops it and gets no Import", async (_n, tabRoot) => {
    const c = await started();
    noteGuestChange("peer", tabRoot(), "tab:u9");
    toolsBeforeSave("u9", null, `${root}/build.sbt`);
    expect(running()).toHaveLength(0);
    expect(ipc.calls).toContain("proc_kill");
    c.stopping = false; // the pause alone must be enough
    expect(answerTo(c)).toBeNull();
    expect(metalsPausedBy(root)).not.toBeNull();
  });

  test("restart asks, then starts it and leaves LaTeX paused", async () => {
    noteGuestChange("peer", root);
    const confirm = vi.spyOn(ui, "confirm").mockResolvedValue(true);
    void restartServer(lang, file, root, async () => true);
    await vi.waitFor(() => expect(spawned()).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(metalsPausedBy(root)).toBeNull();
    expect(isPaused(root, null)).toBe(true);
  });

  test("restart keeps the pause when the host declines", async () => {
    noteGuestChange("peer", root);
    vi.spyOn(ui, "confirm").mockResolvedValue(false);
    expect(await restartServer(lang, file, root, async () => true)).toBeNull();
    expect(spawned()).toBe(false);
    expect(metalsPausedBy(root)).not.toBeNull();
  });

  test("a guest change during the restart dialog keeps the pause", async () => {
    noteGuestChange("peer", root);
    vi.spyOn(ui, "confirm").mockImplementation(async () => {
      noteGuestChange("peer", root);
      return true;
    });
    expect(await restartServer(lang, file, root, async () => true)).toBeNull();
    expect(spawned()).toBe(false);
    expect(metalsPausedBy(root)).not.toBeNull();
  });

  test("Debug says that Metals is paused", async () => {
    noteGuestChange("peer", root);
    ipc.javac = true;
    await expect(planFor({ file, workspace: root, log() {}, askInstall: async () => true })).rejects.toThrow(t("code.lsp.metalsPaused"));
  });
});

describe("Cancelling a Scala debug start", () => {
  const wait = { importMs: 10_000, mainMs: 10_000, pollMs: 2 };

  test("ends the retry loop", async () => {
    let tries = 0, stop = false;
    const start = async () => {
      if (++tries === 3) stop = true;
      throw new Error("No build target could be found");
    };
    await expect(startScalaSession(start, { log() {}, cancelled: () => stop }, wait)).rejects.toThrow();
    expect(tries).toBe(3);
  });

  test("a session that arrives afterwards is closed", async () => {
    await dropScalaSession(5005);
    expect(ipc.calls.slice(-3)).toEqual(["proc_connect", "proc_send", "proc_kill"]);
    expect(JSON.parse(ipc.sent.at(-1)!)).toMatchObject({ command: "disconnect", arguments: { terminateDebuggee: true } });
  });
});
