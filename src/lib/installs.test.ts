import { beforeEach, expect, test, vi } from "vitest";

const log = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    log.push(cmd);
    if (cmd === "tool_installable") return ["ocaml"];
    if (cmd === "installs_status") return [];
    return null;
  },
}));
vi.mock("./code/lsp.svelte", () => ({ stopServers: (kind: string) => log.push(`stop:${kind}`) }));
vi.mock("./ui.svelte", () => ({ ui: { confirm: async () => true, toast: () => {} } }));
vi.mock("./terminal.svelte", () => ({ pathChanged: () => {}, runCommand: () => {} }));
vi.mock("./settings.svelte", () => ({ settings: {} }));
vi.mock("./tools.svelte", () => ({
  TOOLS: new Proxy({}, { get: () => ({ label: "tool" }) }),
  installTool: async () => (log.push("tool_install"), true),
  ensureTools: async () => true,
  hasTool: async () => true,
  withInstallProgress: async (_id: string, _label: string, run: () => Promise<unknown>) => run(),
  serverProgressId: (k: string) => `lsp-${k}`,
}));

import { install, remove } from "./installs.svelte";

beforeEach(() => void (log.length = 0));

const around = (cmd: string) => {
  const at = log.indexOf(cmd);
  return { at, before: log.slice(0, at).includes("stop:ocaml"), after: log.slice(at + 1).includes("stop:ocaml") };
};

test.each(["lsp:ocaml", "tool:ocaml"])("removing %s also stops an ocamllsp an editor restarted meanwhile", async (id) => {
  await remove(id);
  expect(around("installs_remove")).toMatchObject({ before: true, after: true });
});

test("installing or updating ocamllsp stops it on both sides of opam's work", async () => {
  await install("lsp:ocaml");
  expect(around("install_server")).toMatchObject({ before: true, after: true });
});

test("updating the OCaml toolchain stops ocamllsp on both sides too", async () => {
  await install("tool:ocaml");
  expect(around("tool_install")).toMatchObject({ before: true, after: true });
});

test("other language servers keep their single stop", async () => {
  await remove("lsp:python");
  expect(log.filter((l) => l.startsWith("stop:"))).toEqual(["stop:python"]);
});
