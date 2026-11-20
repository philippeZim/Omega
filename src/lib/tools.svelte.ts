/**
 * External tools a feature needs (compilers, runtimes, LaTeX …). `ensureTools` checks the PATH and
 * offers to install what's missing into Omega's app folder (see src-tauri/src/tools.rs), so the
 * same features work on Windows, macOS and Linux without manual setup.
 */
import { invoke } from "@tauri-apps/api/core";
import { pathChanged } from "./terminal.svelte";
import { listen } from "@tauri-apps/api/event";
import { ui } from "./ui.svelte";
import { t } from "./i18n/index.svelte";
import { OS } from "./platform";

export type ToolId = "uv" | "tectonic" | "node" | "pnpm" | "cmake" | "ninja" | "clangd" | "jdk" | "gradle" | "rust" | "git" | "cc";

interface ToolInfo {
  label: string;
  /** Any of these on the PATH means the tool is present. */
  cmds: string[];
  /** Approximate download size in MB (shown in the confirmation). */
  mb: number;
}

const CC_CMDS = OS === "windows" ? ["clang", "gcc", "cl"] : OS === "macos" ? ["clang", "cc"] : ["gcc", "cc", "clang"];

export const TOOLS: Record<ToolId, ToolInfo> = {
  uv: { label: "uv (Python)", cmds: ["uv"], mb: 20 },
  tectonic: { label: "Tectonic (LaTeX)", cmds: ["tectonic"], mb: 25 },
  node: { label: "Node.js", cmds: ["node"], mb: 35 },
  pnpm: { label: "pnpm", cmds: ["pnpm"], mb: 25 },
  cmake: { label: "CMake", cmds: ["cmake"], mb: 50 },
  ninja: { label: "Ninja", cmds: ["ninja"], mb: 1 },
  clangd: { label: "clangd (C/C++)", cmds: ["clangd"], mb: 40 },
  jdk: { label: "Java JDK 21", cmds: ["java"], mb: 190 },
  gradle: { label: "Gradle", cmds: ["gradle"], mb: 140 },
  rust: { label: "Rust (rustup)", cmds: ["cargo"], mb: 300 },
  git: { label: "Git", cmds: ["git"], mb: 60 },
  cc: { label: OS === "windows" ? "C/C++ compiler (LLVM-MinGW)" : OS === "macos" ? "Xcode Command Line Tools" : "C/C++ compiler", cmds: CC_CMDS, mb: OS === "windows" ? 170 : 0 },
};

export const toolState = $state({
  /** Running installs: tool id → progress. */
  installing: {} as Record<string, { label: string; done: number; total: number; stage: string }>,
});

listen<{ id: string; done: number; total: number; stage: string }>("tool-progress", (e) => {
  const cur = toolState.installing[e.payload.id];
  if (cur) Object.assign(cur, e.payload);
});

const which = (c: string) => invoke<string | null>("which_cmd", { cmd: c }).catch(() => null);

export async function hasTool(id: ToolId): Promise<boolean> {
  for (const c of TOOLS[id].cmds) if (await which(c)) return true;
  return false;
}

let installable: Promise<string[]> | null = null;
const canInstall = async (id: ToolId) => (await (installable ??= invoke<string[]>("tool_installable"))).includes(id);

/** How to get a tool by hand when Omega can't install it (Linux system compilers). */
function manualHint(id: ToolId): string {
  if (id === "cc" || id === "git")
    return "sudo apt install build-essential git   # Debian/Ubuntu\nsudo dnf install gcc gcc-c++ git          # Fedora\nsudo pacman -S base-devel git             # Arch";
  return "";
}

/**
 * Shows the progress card while `run` installs something (language server, debugger, update …).
 * `id` is the id the backend uses for its `tool-progress` events, so downloads show real progress;
 * installs without events (npm, uv, rustup) show the animated bar.
 */
export async function withInstallProgress<T>(id: string, label: string, run: () => Promise<T>): Promise<T> {
  if (toolState.installing[id]) return run();
  toolState.installing[id] = { label, done: 0, total: 0, stage: "install" };
  try {
    return await run();
  } finally {
    delete toolState.installing[id];
  }
}

/** Backend progress id of a language-server install (see install_server in proc.rs). */
export const serverProgressId = (kind: string) => (kind === "java" ? "jdtls" : kind === "clangd" ? "clangd" : `lsp-${kind}`);

/** Runs a single install with progress UI. Returns true on success. */
export async function installTool(id: ToolId): Promise<boolean> {
  const info = TOOLS[id];
  toolState.installing[id] = { label: info.label, done: 0, total: 0, stage: "download" };
  try {
    await invoke("tool_install", { id });
    return true;
  } catch (e) {
    const err = String(e);
    if (err.includes("XCODE_CLT")) await ui.confirm(t("tools.xcodeTitle"), t("tools.xcodeMsg"), t("common.ok"));
    else ui.toast(t("tools.failed", { name: info.label, err }), "error");
    return false;
  } finally {
    delete toolState.installing[id];
  }
}

/**
 * Makes sure all `ids` are available, offering to install missing ones. `purpose` is shown in the
 * dialog ("to run this project"). Returns true when everything is present afterwards.
 */
export async function ensureTools(ids: ToolId[], purpose: string): Promise<boolean> {
  let missing: ToolId[] = [];
  for (const id of ids) if (!(await hasTool(id))) missing.push(id);
  if (!missing.length) return true;
  // Maybe installed meanwhile from outside (Windows: winget in another window) – re-read PATH.
  await invoke("refresh_path").catch(() => {});
  const still: ToolId[] = [];
  for (const id of missing) if (!(await hasTool(id))) still.push(id);
  if (still.length < missing.length) pathChanged();
  missing = still;
  if (!missing.length) return true;

  const manual: ToolId[] = [];
  const auto: ToolId[] = [];
  for (const id of missing) ((await canInstall(id)) ? auto : manual).push(id);
  if (manual.length) {
    const names = manual.map((id) => TOOLS[id].label).join(", ");
    const hint = manual.map(manualHint).filter(Boolean)[0] ?? "";
    await ui.confirm(t("tools.manualTitle"), t("tools.manualMsg", { names, purpose }) + (hint ? `\n\n${hint}` : ""), t("common.ok"));
    return false;
  }
  const mb = auto.reduce((n, id) => n + TOOLS[id].mb, 0);
  const names = auto.map((id) => TOOLS[id].label).join(", ");
  const ok = await ui.confirm(t("tools.installTitle"), t("tools.installMsg", { names, purpose, mb }), t("code.install"));
  if (!ok) return false;
  for (const id of auto) {
    const ok = await installTool(id);
    if (ok) pathChanged();
    else return false;
  }
  ui.toast(t("tools.installed", { names }));
  return true;
}
