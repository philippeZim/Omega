import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
const ipc = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string) => {
    ipc.calls.push(cmd);
    if (cmd === "tools_dir") return "C:/tools";
    if (cmd === "tool_installable") return ["uv", "node", "git", "cc"]; // no "mojo" on Windows
    if (cmd === "which_cmd") return null;
    return null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: async () => {} }) }));
vi.mock("../platform", async (orig) => ({ ...(await orig<typeof import("../platform")>()), OS: "windows", IS_WIN: true, tmpPath: async (n: string) => `C:/tmp/${n}` }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fsApi: { exists: async () => false, readFile: async () => "", listDir: async () => [] },
}));

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { langFor } from "./languages";
import { clientFor, lspState, stopServers } from "./lsp.svelte";
import { TEMPLATES } from "./projects";
import { canInstall, catalog, installs, manualHint } from "../installs.svelte";
import { ensureTools } from "../tools.svelte";
import { planFor } from "../debug/adapters";
import { modeForExtension } from "../modes";
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

beforeEach(() => {
  ipc.calls.length = 0;
  installs.installable = ["uv", "node", "git", "cc"];
  stopServers("mojo");
  vi.restoreAllMocks();
});

describe("Mojo on Windows", () => {
  test("files still open in Code mode with highlighting", () => {
    expect(modeForExtension("mojo")).toBe("code");
    expect(modeForExtension("🔥")).toBe("code");
    expect(langFor("C:/p/a.mojo")?.id).toBe("mojo");
  });

  test("Settings lists Mojo with the WSL hint and no Install button", () => {
    expect(catalog().some((i) => i.id === "tool:mojo")).toBe(true);
    expect(canInstall("tool:mojo")).toBe(false);
    expect(manualHint("tool:mojo")).toBe(t("tools.mojoWindows"));
    expect(t("tools.mojoWindows")).toContain("WSL");
  });

  test("the language server doesn't prompt and says why", async () => {
    const ask = vi.fn(async () => true);
    expect(await clientFor(langFor("C:/p/a.mojo")!, "C:/p/a.mojo", "C:/p", ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.calls).not.toContain("install_server");
    expect(Object.values(lspState.message)).toContain(t("tools.mojoWindows"));
  });

  test("Debug says WSL instead of offering an install", async () => {
    const ask = vi.fn(async () => true);
    await expect(planFor({ file: "C:/p/a.mojo", workspace: "C:/p", log: () => {}, askInstall: ask })).rejects.toThrow(t("tools.mojoWindows"));
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.calls).not.toContain("install_debugger");
    expect(ipc.calls).not.toContain("run_capture");
  });

  test("Run shows the hint, with no Install button", async () => {
    const confirm = vi.spyOn(ui, "confirm").mockResolvedValue(true);
    expect(await ensureTools(["mojo", "cc"], "Run")).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toContain(t("tools.mojoWindows"));
    expect(ipc.calls).not.toContain("tool_install");
  });

  test("the template creates the project without asking for a tool that can't exist here", async () => {
    const tpl = TEMPLATES.find((x) => x.id === "mojo")!;
    expect(await (tpl.needs as () => Promise<string[]>)()).toEqual([]);
    expect(Object.keys((await tpl.create("demo")).files!)).toContain("main.mojo");
  });
});
