import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
const ipc = vi.hoisted(() => ({ calls: [] as string[], which: {} as Record<string, string> }));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string, a?: { cmd?: string }) => {
    ipc.calls.push(cmd);
    if (cmd === "tools_dir") return "C:/tools";
    if (cmd === "tool_installable") return ["uv", "node", "git", "cc"]; // no "ocaml" on Windows
    if (cmd === "which_cmd") return ipc.which[a!.cmd!] ?? null;
    if (cmd === "run_killable") return { code: 0, stdout: "", stderr: "" };
    return null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: async () => {} }) }));
vi.mock("../platform", async (orig) => ({ ...(await orig<typeof import("../platform")>()), OS: "windows", IS_WIN: true, tmpPath: async (n: string) => `C:/tmp/${n}` }));

const disk = new Map<string, string>();
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fsApi: {
    exists: async (p: string) => disk.has(p) || [...disk.keys()].some((k) => k.startsWith(`${p}/`)),
    readFile: async (p: string) => disk.get(p) ?? "",
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
}));

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { langFor } from "./languages";
import { allClients, clientFor, INSTALLABLE, lspState, stopServers } from "./lsp.svelte";
import { canInstall, installs, manualHint } from "../installs.svelte";
import { ensureTools } from "../tools.svelte";
import { planFor } from "../debug/adapters";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

const status = (source: "omega" | "system" | "missing") => ({ id: "tool:ocaml", source, path: null, version: null, owner: null });

beforeEach(() => {
  disk.clear();
  ipc.calls.length = 0;
  ipc.which = {};
  installs.status = {};
  installs.installable = ["uv", "node", "git", "cc"];
  vi.restoreAllMocks();
});

describe("OCaml on Windows", () => {
  test("Settings shows a clear hint for the toolchain and no Install button", () => {
    expect(manualHint("tool:ocaml")).toBe(t("tools.ocamlWindows"));
    expect(canInstall("tool:ocaml")).toBe(false);
  });

  test.each(["lsp:ocaml", "debug:earlybird"])("%s has no Install button without a managed OCaml", (id) => {
    expect(canInstall(id)).toBe(false);
    installs.status = { "tool:ocaml": status("system") };
    expect(canInstall(id)).toBe(false);
    installs.status = { "tool:ocaml": status("omega") };
    expect(canInstall(id)).toBe(true);
  });

  test("other servers and debuggers keep their Install button", () => {
    expect(canInstall("lsp:python")).toBe(true);
    expect(canInstall("debug:codelldb")).toBe(true);
  });

  test("the missing-tools dialog carries the hint and installs nothing", async () => {
    const confirm = vi.spyOn(ui, "confirm").mockResolvedValue(true);
    expect(await ensureTools(["ocaml"], "Run")).toBe(false);
    expect(confirm.mock.calls[0][1]).toContain(t("tools.ocamlWindows"));
    expect(ipc.calls).not.toContain("tool_install");
  });

  test("a missing ocamllsp isn't offered, and the status says why", async () => {
    expect(INSTALLABLE.ocaml).toBeUndefined();
    disk.set("C:/p/dune-project", "(lang dune 3.7)\n");
    const ask = vi.fn(async () => true);
    expect(await clientFor(langFor("C:/p/a.ml")!, "C:/p/a.ml", "C:/p", ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.calls).not.toContain("install_server");
    expect(lspState.status["ocaml|C:/p"]).toBe("missing");
    expect(lspState.message["ocaml|C:/p"]).toBe(t("tools.ocamlWindows"));
  });

  test("a system ocamllsp stays usable", async () => {
    ipc.which = { ocamllsp: "C:/opam/bin/ocamllsp.exe" };
    disk.set("C:/q/dune-project", "(lang dune 3.7)\n");
    void clientFor(langFor("C:/q/a.ml")!, "C:/q/a.ml", "C:/q", async () => true);
    await vi.waitFor(() => expect(allClients().some((c) => c.kind === "ocaml")).toBe(true));
    expect(ipc.calls).toContain("proc_spawn");
    stopServers("ocaml");
  });

  const project = () => {
    disk.set("C:/d/dune-project", "(lang dune 3.7)\n(map_workspace_root false)\n");
    disk.set("C:/d/bin/dune", "(executable (name main) (modes byte exe))\n");
    disk.set("C:/d/bin/main.ml", "");
  };
  const ctx = (ask = vi.fn(async () => true)) => ({ file: "C:/d/bin/main.ml", workspace: "C:/d", log() {}, askInstall: ask });

  test("a missing Earlybird gets the hint instead of an install that can only fail", async () => {
    project();
    ipc.which = { dune: "C:/opam/bin/dune.exe", ocamlc: "C:/opam/bin/ocamlc.exe" };
    const ask = vi.fn(async () => true);
    await expect(planFor(ctx(ask))).rejects.toThrow(t("tools.ocamlWindows"));
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.calls).not.toContain("install_debugger");
    expect(ipc.calls).not.toContain("run_killable");
  });

  test("a system Earlybird stays usable", async () => {
    project();
    ipc.which = { dune: "C:/opam/bin/dune.exe", ocamlc: "C:/opam/bin/ocamlc.exe", ocamlearlybird: "C:/opam/bin/ocamlearlybird.exe" };
    expect((await planFor(ctx())).adapter).toMatchObject({ cmd: "C:/opam/bin/ocamlearlybird.exe" });
  });
});
