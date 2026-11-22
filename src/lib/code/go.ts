/** Go projects: what to run in a module or workspace, and the highlighting of go.mod, go.work and go.sum. */
import { invoke } from "@tauri-apps/api/core";
import type { StreamParser } from "@codemirror/language";
import { dirname, fsApi, joinPath } from "../api";
import { IS_WIN, q } from "../platform";

/**
 * Before a `go` command in a shell: a project's go.mod must not fetch and run another toolchain.
 * A value the login shell exports is the user's choice and stays; cmd.exe has no profile, so on
 * Windows `go_info` already knows it.
 */
export const goLocal = (windows = IS_WIN) => (windows ? 'set "GOTOOLCHAIN=local"&& ' : 'GOTOOLCHAIN="${GOTOOLCHAIN:-local}" ');

export interface GoInfo {
  managed: boolean;
  user_toolchain: boolean;
  program_env: Record<string, string | null>;
}

export const goInfo = () => invoke<GoInfo | null>("go_info").catch(() => null);

/** `goLocal` unless it isn't needed: Omega's Go is local by itself, and `go env -w` is the user's choice. */
export async function goPrefix() {
  const info = await goInfo();
  return info?.managed || info?.user_toolchain ? "" : goLocal();
}

export const isGoTest = (file: string) => file.endsWith("_test.go");

/** Debug info that matches the source: no inlining or optimisation in any package. */
export const GO_DEBUG_FLAGS = "-gcflags=all=-N -l";

/** The package clause of a Go file, comments ignored. */
export function goPackageName(text: string): string | null {
  const code = text.replace(/\/\*[^]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)/mu.exec(code)?.[1] ?? null;
}

/** The folders a go.work names, relative and inside it (`go build` can't take the others as a pattern). */
export function goWorkUses(text: string): string[] {
  const code = text.replace(/\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*use\s*(?:\(([^)]*)\)|(\S+))/gm)) {
    for (const raw of (m[1] ?? m[2]).split(/\s+/)) {
      const dir = raw.replace(/^["`]|["`]$/g, "").replace(/^\.\//, "").replace(/\/$/, "");
      if (dir && !dir.startsWith("/") && !/^[A-Za-z]:/.test(dir) && !dir.split("/").includes("..")) out.push(dir);
    }
  }
  return out;
}

const hasMain = async (dir: string) => {
  const entries = (await fsApi.listDir(dir).catch(() => null)) ?? [];
  const files = entries.filter((e) => !e.is_dir && e.name.endsWith(".go") && !isGoTest(e.name)).slice(0, 40);
  for (const e of files) {
    const text = await fsApi.readFile(e.path).catch(() => "");
    if (!/^\/\/go:build\s+ignore\b/m.test(text) && goPackageName(text) === "main") return true;
  }
  return false;
};

const relDir = (root: string, dir: string) => (dir === root ? "." : `./${dir.slice(root.length + 1)}`);

/** The main package to run: the open file's, the root's, else the first one in `cmd/` or a workspace module. */
export async function goRunTarget(root: string, file: string | null): Promise<string | null> {
  const own = file?.endsWith(".go") ? dirname(file) : null;
  if (own && (own === root || own.startsWith(`${root}/`)) && (await hasMain(own))) return relDir(root, own);
  if (await hasMain(root)) return ".";
  const under = async (base: string) => {
    const dirs = ((await fsApi.listDir(base).catch(() => null)) ?? []).filter((e) => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) if (await hasMain(d.path)) return relDir(root, d.path);
    return null;
  };
  const cmd = await under(joinPath(root, "cmd"));
  if (cmd) return cmd;
  for (const use of await workspaceUses(root)) {
    const dir = joinPath(root, use);
    if (await hasMain(dir)) return relDir(root, dir);
    const inner = await under(joinPath(dir, "cmd"));
    if (inner) return inner;
  }
  return null;
}

async function workspaceUses(root: string) {
  return goWorkUses(await fsApi.readFile(joinPath(root, "go.work")).catch(() => ""));
}

/** `./...` for a module; a workspace root without a module of its own names its modules. */
export async function goPatterns(root: string): Promise<string> {
  if (await fsApi.exists(joinPath(root, "go.mod"))) return "./...";
  const uses = await workspaceUses(root);
  return uses.length ? uses.map((u) => q(u === "." ? "./..." : `./${u}/...`)).join(" ") : "./...";
}

/** A valid module path from a project name. */
export const goModuleName = (name: string) => name.toLowerCase().replace(/[^a-z0-9._~-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "app";

const GO_MOD_KEYWORDS = /^(?:module|go|toolchain|godebug|require|replace|exclude|retract|tool|ignore|use)(?![\w./-])/;

/** go.mod, go.work and go.sum: directives, versions, strings and comments. */
export const goModParser: StreamParser<{ start: boolean }> = {
  name: "gomod",
  startState: () => ({ start: true }),
  token(stream, state) {
    if (stream.sol()) state.start = true;
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    const first = state.start;
    state.start = false;
    if (first && stream.match(GO_MOD_KEYWORDS)) return "keyword";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?|^`[^`]*`?/)) return "string";
    if (stream.match(/^v?\d+(?:\.\d+)*(?:[-+][\w.+-]*)?(?=[\s/]|$)/)) return "number";
    if (stream.match("=>")) return "operator";
    if (stream.match(/^[()]/)) return "bracket";
    stream.match(/^[^\s"`()]+/) || stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "//" } },
};
