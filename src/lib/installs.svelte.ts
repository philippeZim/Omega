/**
 * The "Installations" settings tab: everything Omega installs on demand (tools, language servers,
 * debug adapters). Status, versions and uninstalling come from src-tauri/src/installs.rs;
 * installing/updating reuses the regular install paths. System installations are only shown.
 */
import { backendErrorText } from "./backendError";
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n/index.svelte";
import { ui } from "./ui.svelte";
import { OS } from "./platform";
import { TOOLS, installTool, ensureTools, hasTool, withInstallProgress, serverProgressId, type ToolId } from "./tools.svelte";
import { pathChanged, runCommand } from "./terminal.svelte";
import { settings } from "./settings.svelte";
import { stopServers, type ServerKind } from "./code/lsp.svelte";

export type Group = "tool" | "lsp" | "debug";
export interface Item { id: string; group: Group; label: string }
export interface Owner { manager: string; package: string }
export interface Status { id: string; source: "omega" | "system" | "missing"; path: string | null; version: string | null; owner: Owner | null }
export interface SysUpdate { available: string | null; command: string | null; full_system: boolean }

const TOOL_IDS: ToolId[] = ["uv", "tectonic", "node", "pnpm", "cmake", "ninja", "jdk", "gradle", "rust", "git", "cc", "scala", "sbt", "ocaml"];

export function catalog(): Item[] {
  return [
    ...TOOL_IDS.map((id) => ({ id: `tool:${id}`, group: "tool" as const, label: TOOLS[id].label })),
    { id: "lsp:python", group: "lsp", label: "basedpyright (Python)" },
    { id: "lsp:typescript", group: "lsp", label: "typescript-language-server (JS/TS)" },
    { id: "lsp:java", group: "lsp", label: "Eclipse JDT LS (Java)" },
    { id: "lsp:rust", group: "lsp", label: "rust-analyzer (Rust)" },
    { id: "lsp:clangd", group: "lsp", label: "clangd (C/C++)" },
    { id: "lsp:scala", group: "lsp", label: "Metals (Scala)" },
    { id: "lsp:ocaml", group: "lsp", label: "ocaml-lsp-server (OCaml)" },
    { id: "debug:codelldb", group: "debug", label: "CodeLLDB (C/C++/Rust)" },
    { id: "debug:debugpy", group: "debug", label: "debugpy (Python)" },
    { id: "debug:jsdebug", group: "debug", label: "js-debug (JS/TS)" },
    { id: "debug:javadebug", group: "debug", label: "java-debug (Java)" },
    { id: "debug:earlybird", group: "debug", label: "Earlybird (OCaml)" },
  ];
}

export const installs = $state({
  status: {} as Record<string, Status>,
  latest: {} as Record<string, string | null>,
  /** System installations: what their package manager offers. */
  sys: {} as Record<string, SysUpdate>,
  /** id → running action */
  busy: {} as Record<string, "install" | "update" | "remove">,
  loading: false,
  checking: false,
  checkedAt: 0,
  installable: [] as string[],
});

export async function refreshInstalls() {
  installs.loading = true;
  try {
    if (!installs.installable.length) installs.installable = await invoke<string[]>("tool_installable");
    const list = await invoke<Status[]>("installs_status");
    installs.status = Object.fromEntries(list.map((s) => [s.id, s]));
  } finally {
    installs.loading = false;
  }
}

/**
 * Looks up updates: Omega's own copies against upstream releases, system installations against
 * what their package manager offers.
 */
export async function checkUpdates() {
  const all = Object.values(installs.status);
  const ids = all.filter((s) => s.source === "omega" && hasLatest(s.id)).map((s) => s.id);
  const items = Object.fromEntries(all.filter((s) => s.source === "system" && s.owner).map((s) => [s.id, s.owner]));
  installs.checking = true;
  try {
    const [latest, sys] = await Promise.all([
      invoke<Record<string, string | null>>("installs_latest", { ids }),
      invoke<Record<string, SysUpdate>>("installs_system_updates", { items }),
    ]);
    installs.latest = latest;
    installs.sys = sys;
    installs.checkedAt = Date.now();
  } finally {
    installs.checking = false;
  }
}

/** True when the last check got an answer for this item (to show "up to date"). */
export function wasChecked(id: string): boolean {
  const s = installs.status[id];
  return !!installs.checkedAt && (s?.source === "system" ? id in installs.sys : !!installs.latest[id]);
}

/** rust-analyzer is updated with the Rust toolchain. */
const hasLatest = (id: string) => id !== "lsp:rust";

function parts(v: string) {
  return v.split(".").map((p) => parseInt(p, 10) || 0);
}
export function isNewer(latest: string, installed: string) {
  const a = parts(latest), b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export function updateAvailable(id: string): string | null {
  const s = installs.status[id], l = installs.latest[id];
  if (s?.source === "system") return installs.sys[id]?.command ? installs.sys[id].available : null;
  if (!s || s.source !== "omega" || !l) return null;
  return !s.version || isNewer(l, s.version) ? l : null;
}

export function canInstall(id: string): boolean {
  const [group, name] = id.split(":");
  if (group === "tool") return installs.installable.includes(name);
  // Both go into Omega's opam switch, which doesn't exist on Windows.
  if (OS === "windows" && (id === "lsp:ocaml" || id === "debug:earlybird")) return installs.status["tool:ocaml"]?.source === "omega";
  return true;
}

/** Package-manager hint for things Omega can't install on this OS (Linux compilers, Git). */
export function manualHint(id: string): string {
  if (OS === "windows" && id === "tool:ocaml") return t("tools.ocamlWindows");
  if (OS !== "linux") return "";
  if (id === "tool:cc") return "sudo pacman -S base-devel · sudo apt install build-essential";
  if (id === "tool:git") return "sudo pacman -S git · sudo apt install git";
  return "";
}

const LSP_PREREQ: Partial<Record<string, ToolId[]>> = { python: ["node"], typescript: ["node"], java: ["jdk"], rust: ["rust"], scala: ["jdk", "scala"], ocaml: ["ocaml"] };

/** opam works for a while: an open editor can start ocamllsp again from the files it is replacing. */
const usesOcamllsp = (id: string) => id === "lsp:ocaml" || id === "tool:ocaml";

async function doInstall(id: string) {
  const [group, name] = id.split(":");
  if (group === "tool" || id === "lsp:clangd") {
    if (id === "lsp:clangd") stopServers("clangd");
    if (usesOcamllsp(id)) stopServers("ocaml");
    const ok = await installTool(name as ToolId);
    if (usesOcamllsp(id)) stopServers("ocaml");
    if (!ok) return false;
    pathChanged();
    return true;
  }
  if (group === "lsp") {
    const pre = LSP_PREREQ[name];
    if (pre && !(await ensureTools(pre, t("tools.purpose.lsp")))) return false;
    stopServers(name as ServerKind);
    try {
      await withInstallProgress(serverProgressId(name), labelOf(id), () => invoke("install_server", { kind: name }));
    } finally {
      if (usesOcamllsp(id)) stopServers("ocaml");
    }
    return true;
  }
  if (name === "debugpy" && !(await hasTool("uv")) && !(await invoke<string | null>("which_cmd", { cmd: "python3" })) && !(await invoke<string | null>("which_cmd", { cmd: "python" })))
    if (!(await ensureTools(["uv"], t("tools.purpose.debug")))) return false;
  if (name === "earlybird" && !(await ensureTools(["ocaml"], t("tools.purpose.debug")))) return false;
  await withInstallProgress(name, labelOf(id), () => invoke("install_debugger", { kind: name }));
  return true;
}

const labelOf = (id: string) => catalog().find((i) => i.id === id)?.label ?? id;

async function run(id: string, action: "install" | "update" | "remove", fn: () => Promise<boolean>) {
  if (installs.busy[id]) return;
  installs.busy[id] = action;
  const label = catalog().find((i) => i.id === id)?.label ?? id;
  try {
    if (await fn()) ui.toast(t(`installs.done.${action}`, { name: label }));
  } catch (e) {
    ui.toast(t("installs.failed", { name: label, err: backendErrorText(e) }), "error");
  } finally {
    delete installs.busy[id];
    delete installs.latest[id];
    await refreshInstalls();
  }
}

export const install = (id: string) => run(id, "install", () => doInstall(id));

/** Updates a system installation through its package manager, visibly in the terminal (sudo prompts there). */
async function updateSystem(id: string) {
  const u = installs.sys[id], s = installs.status[id];
  if (!u?.command || !s?.owner) return;
  const label = catalog().find((i) => i.id === id)?.label ?? id;
  const msg = t("installs.sysUpdateMsg", { manager: s.owner.manager, cmd: u.command }) + (u.full_system ? "\n\n" + t("installs.fullSystem") : "");
  if (!(await ui.confirm(t("installs.sysUpdateTitle", { name: label }), msg, t("installs.runInTerminal")))) return;
  // The result shows up when the tab is opened again (it refreshes on open).
  delete installs.sys[id];
  settings.open = false;
  runCommand(u.command, null, t("installs.terminalTitle", { name: label }));
}

export const update = (id: string) =>
  installs.status[id]?.source === "system" ? updateSystem(id) :
  run(id, "update", async () => {
    if (id === "tool:rust") {
      await withInstallProgress("rust", labelOf(id), () => invoke("installs_update_rust"));
      return true;
    }
    return doInstall(id);
  });

export async function remove(id: string) {
  const label = catalog().find((i) => i.id === id)?.label ?? id;
  const msg = id === "tool:rust" ? t("installs.removeRustMsg") : t("installs.removeMsg", { name: label });
  if (!(await ui.confirm(t("installs.removeTitle", { name: label }), msg, t("installs.remove"), true))) return;
  await run(id, "remove", async () => {
    const [group, name] = id.split(":");
    if (group === "lsp") stopServers(name as ServerKind);
    if (id === "tool:ocaml") stopServers("ocaml"); // ocamllsp lives in the same switch
    try {
      await invoke("installs_remove", { id });
    } finally {
      if (usesOcamllsp(id)) stopServers("ocaml");
    }
    pathChanged();
    return true;
  });
}
