/** What Omega needs to know about Mojo files and projects. */
import { invoke } from "@tauri-apps/api/core";
import { basename, fsApi, joinPath } from "../api";
import pixiLauncher from "./pixi-mojo.sh?raw";

export const isMojoFile = (path: string) => /\.(?:mojo|🔥)$/iu.test(path);

/** Mojo 1.x refuses the `.🔥` extension: such a file can be edited, but not built or run. */
export const mojoCompiles = (path: string) => /\.mojo$/i.test(path);

export const mojoStem = (path: string) => basename(path).replace(/\.(?:mojo|🔥)$/iu, "");

const MOJO_PACKAGE = /^\s*["']?(?:mojo|mojo-compiler|modular)["']?\s*=/;

/**
 * Whether a pixi manifest depends on Mojo. A `pixi.toml` alone says nothing: pixi is just as common
 * for Python projects. In a pyproject.toml only `[tool.pixi.*]` tables count.
 */
export function pixiUsesMojo(toml: string, pyproject = false): boolean {
  let inDeps = false;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const section = /^\[([^[\]]+)\]$/.exec(line)?.[1];
    if (section !== undefined) {
      inDeps = (!pyproject || section.startsWith("tool.pixi.")) && /(?:^|\.)dependencies$/.test(section);
    } else if (inDeps && MOJO_PACKAGE.test(line)) return true;
  }
  return false;
}

/** The launcher's file: named after its content, so a version is never overwritten while it runs. */
export function pixiLauncherPath(tools: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pixiLauncher.length; i++) hash = Math.imul(hash ^ pixiLauncher.charCodeAt(i), 0x01000193);
  return `${tools}/pixi-mojo-${(hash >>> 0).toString(16)}.sh`;
}

let launcherWrites = 0;

/**
 * The launcher for `mojo` in a pixi project (see pixi-mojo.sh), in Omega's tools folder. It appears
 * complete or not at all: written to a temp file of its own, then renamed. When several calls race,
 * the first rename wins and the others find the same content. Null if there is no correct copy:
 * a project must not fall back to a plain `pixi run`.
 */
export async function pixiMojoLauncher(): Promise<string | null> {
  try {
    const path = pixiLauncherPath(await invoke<string>("tools_dir"));
    const current = () => fsApi.readFile(path).catch(() => null);
    if ((await current()) === pixiLauncher) return path;
    const tmp = `${path}.${Date.now().toString(36)}-${++launcherWrites}-${Math.random().toString(36).slice(2)}.tmp`;
    await fsApi.writeFile(tmp, pixiLauncher);
    await fsApi.rename(tmp, path).catch(() => fsApi.remove(tmp).catch(() => {}));
    return (await current()) === pixiLauncher ? path : null;
  } catch {
    return null;
  }
}

/** The file Run and Build use: the open Mojo file, else the project's usual entry point. */
export async function mojoEntry(file: string | null, root: string): Promise<string | null> {
  if (file && mojoCompiles(file) && file.startsWith(`${root}/`)) return file;
  for (const rel of ["main.mojo", "src/main.mojo", `${basename(root)}.mojo`]) {
    const path = joinPath(root, rel);
    if (await fsApi.exists(path)) return path;
  }
  return null;
}
