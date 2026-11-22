import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

vi.mock("../ui.svelte", () => ({ ui: { toast: vi.fn() } }));
vi.mock("../tools.svelte", () => ({ ensureTools: async () => true, withInstallProgress: async (_i: string, _n: string, f: () => any) => f(), serverProgressId: (k: string) => k }));

let L: typeof import("./lsp.svelte");
const JAVA = { server: "java", lspId: "java" } as any;
const LAUNCHER = { name: "org.eclipse.equinox.launcher_1.8.0.jar", path: "/tools/jdtls/plugins/org.eclipse.equinox.launcher_1.8.0.jar" };

interface Setup { files?: Record<string, string>; runtime?: unknown; launcher?: boolean }

async function setup({ files = {}, runtime = null, launcher = true }: Setup) {
  const spawned: any[] = [];
  mockIPC(
    (cmd, args: any) => {
      if (cmd === "tools_dir") return "/tools";
      if (cmd === "path_exists") return args.path in files;
      if (cmd === "read_file") return files[args.path];
      if (cmd === "list_dir") return launcher && args.path === "/tools/jdtls/plugins" ? [LAUNCHER] : [];
      if (cmd === "which_cmd") return args.cmd === "java" ? "/usr/bin/java" : null;
      if (cmd === "jdtls_runtime") return runtime;
      if (cmd === "platform_info") return { tmp: "/tmp", arch: "x86_64", os: "linux", home: "/home/u" };
      if (cmd === "proc_spawn") spawned.push(args);
      if (cmd === "proc_send") {
        const msg = JSON.parse(args.msg);
        if (msg.id !== undefined && msg.method) setTimeout(() => emit("proc-msg", { id: args.id, msg: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "initialize" ? { capabilities: {} } : null }) }), 0);
      }
      return null;
    },
    { shouldMockEvents: true },
  );
  vi.resetModules();
  L = await import("./lsp.svelte");
  await new Promise((r) => setTimeout(r, 0));
  return spawned;
}

const ok = { java: "/tools/jdk/bin/java", found: 25, required: 25, current: true };

describe("Java project root", () => {
  beforeEach(() => setup({}));

  test("a settings.gradle.kts above wins over the nearest build.gradle.kts", async () => {
    await setup({ files: { "/w/p/settings.gradle.kts": "", "/w/p/app/build.gradle.kts": "" } });
    expect(await L.javaRoot("/w/p/app/src/main/java/app/App.java", "/w")).toBe("/w/p");
  });

  test("a build without settings above stays where it is, and the search ends at .git", async () => {
    await setup({ files: { "/w/p/build.gradle": "" } });
    expect(await L.javaRoot("/w/p/src/A.java", "/w")).toBe("/w/p");
    await setup({ files: { "/w/settings.gradle": "", "/w/p/.git": "", "/w/p/build.gradle": "" } });
    expect(await L.javaRoot("/w/p/src/A.java", "/w")).toBe("/w/p");
  });

  test("a parent pom counts only if it lists the module", async () => {
    await setup({ files: { "/w/p/pom.xml": "<modules><module>core</module></modules>", "/w/p/core/pom.xml": "" } });
    expect(await L.javaRoot("/w/p/core/src/A.java", "/w")).toBe("/w/p");
    await setup({ files: { "/w/p/pom.xml": "<modules><module>other</module></modules>", "/w/p/core/pom.xml": "" } });
    expect(await L.javaRoot("/w/p/core/src/A.java", "/w")).toBe("/w/p/core");
  });

  test("other languages keep the nearest marker", async () => {
    await setup({ files: { "/w/p/settings.gradle.kts": "", "/w/p/app/pyproject.toml": "" } });
    expect(await L.findRoot("/w/p/app/a.py", ["pyproject.toml"], "/w")).toBe("/w/p/app");
  });
});

describe("jdtls runtime", () => {
  test("starts on the Java the backend chose, not the first on PATH", async () => {
    const spawned = await setup({ runtime: ok });
    await L.clientFor(JAVA, "/w/A.java", "/w", async () => false);
    expect(spawned[0].cmd).toBe("/tools/jdk/bin/java");
  });

  test("a too old Java is not started and the status says what is required", async () => {
    const spawned = await setup({ runtime: { java: null, found: 21, required: 25, current: true } });
    await L.clientFor(JAVA, "/w/A.java", "/w", async () => false);
    expect(spawned).toHaveLength(0);
    expect(L.lspState.status["java|/w"]).toBe("missing");
    expect(L.lspState.message["java|/w"]).toContain("Java 25");
    expect(L.lspState.message["java|/w"]).toContain("Java 21");
  });

  test("an install that isn't the pinned release is offered for replacement", async () => {
    const spawned = await setup({ runtime: { ...ok, current: false } });
    const ask = vi.fn(async () => false);
    await L.clientFor(JAVA, "/w/A.java", "/w", ask);
    expect(ask).toHaveBeenCalledOnce();
    expect(spawned).toHaveLength(0);
  });
});

describe("failed build import", () => {
  const failure = [
    { severity: 1, message: "The supplied phased action failed with an exception.\nBUG!" },
    { severity: 1, message: "Can't use Java 27 and Gradle 9.7.1 to import Gradle project app." },
  ];

  test("errors on a project folder or build file count, source errors don't", async () => {
    await setup({});
    expect(L.javaImportError("file:///w/p/app", failure)).toBe("Can't use Java 27 and Gradle 9.7.1 to import Gradle project app.");
    expect(L.javaImportError("file:///w/p/build.gradle.kts", [failure[0]])).toBe("The supplied phased action failed with an exception.");
    expect(L.javaImportError("file:///w/p/A.java", failure)).toBeNull();
    expect(L.javaImportError("file:///w/p/app", [{ severity: 2, message: "warn" }])).toBeNull();
  });

  test("the language status leaves ready while the import is broken and recovers", async () => {
    const spawned = await setup({ runtime: ok, files: { "/w/p/build.gradle": "" } });
    const c = (await L.clientFor(JAVA, "/w/p/src/A.java", "/w", async () => false))!;
    expect(L.lspState.status["java|/w/p"]).toBe("ready");
    const publish = (diagnostics: unknown[]) => emit("proc-msg", { id: spawned[0].id, msg: JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///w/p", diagnostics } }) });
    await publish(failure);
    await vi.waitFor(() => expect(L.lspState.status["java|/w/p"]).toBe("error"));
    expect(L.lspState.message["java|/w/p"]).toContain("Can't use Java 27");
    expect(c.importError).toContain("Gradle 9.7.1");
    await publish([]);
    await vi.waitFor(() => expect(L.lspState.status["java|/w/p"]).toBe("ready"));
    expect(L.lspState.message["java|/w/p"]).toBeUndefined();
  });
});
