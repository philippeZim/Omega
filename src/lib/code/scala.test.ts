import { describe, expect, test, vi, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { getIndentation, indentUnit } from "@codemirror/language";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/core", async (orig) => ({ ...(await orig<typeof import("@tauri-apps/api/core")>()), invoke: async () => null }));
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
import { metalsAnswer } from "./lsp.svelte";
import { metalsDebugPort, planFor, startScalaSession } from "../debug/adapters";
import { t } from "../i18n/index.svelte";

beforeEach(() => files.clear());

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
