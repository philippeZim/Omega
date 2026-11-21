import { describe, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
const ipc = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  invoke: async (cmd: string) => {
    ipc.calls.push(cmd);
    if (cmd === "tools_dir") return "/tools";
    if (cmd === "tool_installable") return ["uv", "cc"]; // a Linux with an old glibc, or an Intel Mac
    return null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: async () => {} }) }));
vi.mock("../platform", async (orig) => ({ ...(await orig<typeof import("../platform")>()), OS: "linux", IS_WIN: false, tmpPath: async (n: string) => `/tmp/${n}` }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fsApi: { exists: async () => false, readFile: async () => "", listDir: async () => [] },
}));

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { langFor } from "./languages";
import { clientFor, lspState } from "./lsp.svelte";
import { canInstall, installs, manualHint } from "../installs.svelte";
import { planFor } from "../debug/adapters";
import { t } from "../i18n/index.svelte";

describe("Mojo on a system it doesn't support", () => {
  test("Settings explains it and has no Install button", () => {
    installs.installable = ["uv", "cc"];
    expect(canInstall("tool:mojo")).toBe(false);
    expect(manualHint("tool:mojo")).toBe(t("tools.mojoUnsupported"));
  });

  test("the language server doesn't prompt", async () => {
    const ask = vi.fn(async () => true);
    expect(await clientFor(langFor("/p/a.mojo")!, "/p/a.mojo", "/p", ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(Object.values(lspState.message)).toContain(t("tools.mojoUnsupported"));
  });

  test("Debug gets the hint instead of an install prompt", async () => {
    const ask = vi.fn(async () => true);
    await expect(planFor({ file: "/p/a.mojo", workspace: "/p", log: () => {}, askInstall: ask })).rejects.toThrow(t("tools.mojoUnsupported"));
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.calls).not.toContain("install_debugger");
  });
});
