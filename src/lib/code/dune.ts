/** Reads dune files as data (never through dune, which would evaluate OCaml-syntax ones). */
import { fsApi, basename, dirname, joinPath } from "../api";

export type Sexp = string | Sexp[];

/** Parses a dune file. Null if it isn't S-expressions, e.g. a dune file written in OCaml. */
export function parseSexps(text: string): Sexp[] | null {
  if (/^\s*\(\*/.test(text)) return null;
  const stack: Sexp[][] = [[]];
  // Stack depths at which the next complete datum is dropped (`#;` comments).
  const drops: number[] = [];
  const add = (v: Sexp) => {
    if (drops.at(-1) === stack.length) drops.pop();
    else stack.at(-1)!.push(v);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) i++;
    else if (c === ";") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("#|", i)) {
      const end = text.indexOf("|#", i + 2);
      if (end < 0) return null;
      i = end + 2;
    } else if (text.startsWith("#;", i)) {
      drops.push(stack.length);
      i += 2;
    } else if (c === "(") {
      stack.push([]);
      i++;
    } else if (c === ")") {
      if (stack.length < 2) return null;
      add(stack.pop()!);
      i++;
    } else if (c === '"') {
      let s = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        s += text[i++] ?? "";
      }
      if (i >= text.length) return null;
      i++;
      add(s);
    } else {
      const start = i;
      while (i < text.length && !/[\s()";]/.test(text[i])) i++;
      add(text.slice(start, i));
    }
  }
  return stack.length === 1 ? stack[0] : null;
}

export interface DuneExe {
  /** Folder relative to the project root ("" for the root itself). */
  dir: string;
  name: string;
  /** Has the bare `byte` mode, which is what produces `<name>.bc`. */
  byte: boolean;
}

const atoms = (list: Sexp[]) => list.filter((x): x is string => typeof x === "string");

/** The executables of one dune file. `(byte exe)` links differently and gives no `.bc`. */
export function duneExecutables(text: string, dir: string): DuneExe[] {
  const out: DuneExe[] = [];
  for (const stanza of parseSexps(text) ?? []) {
    if (!Array.isArray(stanza) || (stanza[0] !== "executable" && stanza[0] !== "executables")) continue;
    const field = (key: string) => stanza.find((f): f is Sexp[] => Array.isArray(f) && f[0] === key)?.slice(1);
    const names = atoms(field("names") ?? field("name") ?? []);
    const modes = field("modes") ?? [];
    // An ordered set: `a b \ c` is a and b without c.
    const cut = modes.indexOf("\\");
    const byte = (cut < 0 ? modes : modes.slice(0, cut)).includes("byte") && !(cut >= 0 && modes.slice(cut + 1).includes("byte"));
    for (const name of names) out.push({ dir, name, byte });
  }
  return out;
}

const SKIP = new Set(["_build", "_opam", "node_modules"]);

/** Executables in the project's dune files, breadth-first, a few levels deep. */
export async function findDuneExecutables(root: string): Promise<DuneExe[]> {
  const out: DuneExe[] = [];
  let level = [""];
  let seen = 0;
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      if (++seen > 300) return out;
      const abs = rel ? joinPath(root, rel) : root;
      const entries = (await fsApi.listDir(abs).catch(() => null)) ?? [];
      if (entries.some((e) => !e.is_dir && e.name === "dune")) {
        const text = await fsApi.readFile(joinPath(abs, "dune")).catch(() => "");
        out.push(...duneExecutables(text, rel));
      }
      for (const e of entries) if (e.is_dir && !e.name.startsWith(".") && !SKIP.has(e.name)) next.push(rel ? `${rel}/${e.name}` : e.name);
    }
    level = next;
  }
  return out;
}

/** The executable for this file: same folder and name, then same folder, then the project's first. */
export function pickExecutable(exes: DuneExe[], file: string | null, root: string): DuneExe | null {
  if (file?.startsWith(`${root}/`)) {
    const dir = dirname(file) === root ? "" : dirname(file).slice(root.length + 1);
    const stem = basename(file).replace(/\.mli?$/, "");
    const here = exes.filter((e) => e.dir === dir);
    const hit = here.find((e) => e.name === stem) ?? here[0];
    if (hit) return hit;
  }
  return exes[0] ?? null;
}

/** Target path of an executable, relative to the project root, for `dune build` / `dune exec`. */
export const duneTarget = (e: DuneExe, ext: "exe" | "bc") => `./${e.dir ? `${e.dir}/` : ""}${e.name}.${ext}`;

/**
 * What keeps a project from debugging: without dune 3.7's `(map_workspace_root false)` the
 * bytecode names sources under /workspace_root, and Earlybird runs past every breakpoint.
 */
export function duneProjectIssue(text: string): "lang" | "map" | null {
  const forms = parseSexps(text) ?? [];
  const lang = forms.find((f): f is Sexp[] => Array.isArray(f) && f[0] === "lang" && f[1] === "dune");
  const [major, minor] = String(lang?.[2] ?? "0.0").split(".").map(Number);
  if (major < 3 || (major === 3 && minor < 7)) return "lang";
  const off = forms.some((f) => Array.isArray(f) && f[0] === "map_workspace_root" && f[1] === "false");
  return off ? null : "map";
}

/** The source file behind dune's build copy, which is read-only and overwritten by every build. */
export const duneSourcePath = (root: string, path: string) => (path.startsWith(`${root}/_build/default/`) ? `${root}/${path.slice(root.length + 16)}` : path);

/** A debugger only understands bytecode from its own compiler: both must come from one switch. */
export const sameToolchain = (adapter: string, compiler: string | null) => !!compiler && dirname(adapter) === dirname(compiler);
