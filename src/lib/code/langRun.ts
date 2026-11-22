/**
 * Running and analysing a file on its own in a language the user chose by hand.
 *
 * Where the tool accepts any file name, it gets the real file, so relative includes and imports,
 * error messages and debug info all point at it: C and C++ (`-x`), Python (`uv run --script`),
 * Rust (`--crate-name`), OCaml. Java, JavaScript, TypeScript, Scala and Mojo go by the extension:
 * they get a private copy with links to the file's neighbours, so relative imports still resolve.
 * Nothing is written into the project.
 */
import { invoke } from "@tauri-apps/api/core";
import { dirname, fsApi } from "../api";
import { exe, OS, q, cd } from "../platform";
import type { ToolId } from "../tools.svelte";
import type { LangId, LangInfo } from "./languages";
import { goPrefix } from "./go";
import { ocamlShellPrefix } from "./ocamlTools";

export interface OverrideRun {
  cmd: string;
  needs: ToolId[];
  pre?: string;
  /** Run after saving, right before the command: refreshes the private copy. */
  prepare?: () => Promise<void>;
}

/** Scala scripts (`.sc`) may have top-level statements; a program with an entry point may not. */
const scalaHasMain = (text: string) => /@main\b|\bdef\s+main\s*\(|\bextends\s+App\b/.test(text);

/** Name of the run copy for languages that go by the extension; null if the real file works. */
export function runCopyName(lang: LangId, text: string): string | null {
  switch (lang) {
    case "java": return "OmegaMain.java"; // the source launcher doesn't tie class names to the file
    case "javascript": return "omega_main.js";
    case "typescript": return "omega_main.ts";
    case "mojo": return "omega_main.mojo";
    case "go": return "omega_main.go";
    case "scala": return scalaHasMain(text) ? "OmegaMain.scala" : "omega_main.sc";
    default: return null;
  }
}

/** Path of the language server's copy in its folder. javac wants a public class in a file of its name. */
export function lspCopyName(lang: LangInfo, text: string): string {
  const ext: Record<LangId, string> = { python: "py", c: "c", cpp: "cpp", java: "java", javascript: "js", typescript: "ts", rust: "rs", json: "json", toml: "toml", scala: "scala", ocaml: "ml", mojo: "mojo", sql: "sql", yaml: "yaml", shell: "sh", dockerfile: "dockerfile", xml: "xml", makefile: "mk", go: "go" };
  if (lang.id === "scala") return runCopyName("scala", text)!; // a script needs .sc, a program .scala
  if (lang.id === "java") {
    const cls = /^\s*public\s+(?:(?:final|abstract|sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/m.exec(text)?.[1] ?? "OmegaMain";
    // The compiler wants a package's file in the matching folder.
    const pkg = /^\s*package\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*;/m.exec(text)?.[1];
    return `${pkg ? `${pkg.replace(/\./g, "/")}/` : ""}${cls}.java`;
  }
  return `omega_main.${ext[lang.id]}`;
}

export const workDir = (file: string, part: "run" | "bin") => invoke<string>("lang_workdir", { file, part });

/** Refreshes the run copy from the saved file and returns its path. */
export const refreshRunCopy = (file: string, name: string) => invoke<string>("lang_copy", { file, part: "run", name, link: true });

/** A copy next to the build output, for compilers that write their files beside the source. */
export const refreshBinCopy = (file: string, name: string) => invoke<string>("lang_copy", { file, part: "bin", name, link: false });

/** The command that runs `file` alone as `lang`. Null for a language that doesn't run (JSON, TOML). */
export async function overrideRun(lang: LangId, file: string, tsx: string): Promise<OverrideRun | null> {
  const f = q(file);
  const compiled = async () => q(`${await workDir(file, "bin")}/${exe("omega_out")}`);
  switch (lang) {
    case "python": return { cmd: `uv run --no-project --script ${f}`, needs: ["uv"] };
    case "c": {
      const out = await compiled();
      return { cmd: out, needs: ["cc"], pre: `${OS === "linux" ? "gcc" : "clang"} -x c -g -Wall ${f} -o ${out}${OS === "linux" ? " -lm" : ""}` };
    }
    case "cpp": {
      const out = await compiled();
      return { cmd: out, needs: ["cc"], pre: `${OS === "linux" ? "g++" : "clang++"} -x c++ -g -Wall -std=c++20 ${f} -o ${out}` };
    }
    case "rust": {
      const out = await compiled();
      return { cmd: out, needs: ["rust"], pre: `rustc -g --crate-name omega_main ${f} -o ${out}` };
    }
    case "ocaml": return { cmd: `${await ocamlShellPrefix()}ocaml ${f}`, needs: ["ocaml"] };
    case "go": {
      // Built in the private folder, which never holds links: a go.mod next to the file doesn't apply.
      const bin = await workDir(file, "bin");
      const name = exe("omega_out");
      return { cmd: q(`${bin}/${name}`), needs: ["go"], pre: `(${cd(bin)} && ${await goPrefix()}go build -o ${name} omega_main.go)`, prepare: async () => void (await refreshBinCopy(file, "omega_main.go")) };
    }
    case "java":
    case "javascript":
    case "typescript":
    case "scala":
    case "mojo": {
      const name = runCopyName(lang, await fsApi.readFile(file).catch(() => ""))!;
      const copy = q(`${await workDir(file, "run")}/${name}`);
      const prepare = async () => void (await refreshRunCopy(file, name));
      if (lang === "java") return { cmd: `java ${copy}`, needs: ["jdk"], prepare };
      if (lang === "javascript") return { cmd: `node ${copy}`, needs: ["node"], prepare };
      if (lang === "typescript") return { cmd: `${tsx} ${copy}`, needs: ["node", "pnpm"], prepare };
      if (lang === "scala") return { cmd: `scala-cli run ${copy}`, needs: ["scala"], prepare };
      return { cmd: `mojo run ${copy}`, needs: ["mojo", "cc"], prepare };
    }
    default: return null;
  }
}

/** Compiler flags for clangd: the copy lives elsewhere, so the real folder is on the include path. */
export function clangdFlags(lang: LangId, file: string): string | null {
  const dir = dirname(file);
  // One flag per line: a line break in the folder's name would add a flag of its own.
  if (/[\r\n]/.test(dir)) return null;
  return `${lang === "cpp" ? "-std=c++20\n" : ""}-I${dir}\n`;
}

/**
 * clangd goes by the extension and ignores `languageId`. For a real file in a C/C++ project this
 * tells it the language without writing anything into the project.
 */
export const clangdCommand = (lang: LangId, file: string) => (lang === "cpp" ? ["clang++", "-x", "c++", "-std=c++20", file] : ["clang", "-x", "c", file]);

/** Writes the language server's copy of `file`. `root` is the folder the server is started in. */
export async function shadowForLsp(file: string, lang: LangInfo): Promise<{ copy: string; root: string }> {
  const text = await fsApi.readFile(file);
  const name = lspCopyName(lang, text);
  const copy = await invoke<string>("lang_copy", { file, part: "lsp", name, link: false });
  const root = copy.slice(0, copy.length - name.length - 1);
  if (lang.server === "clangd") {
    const flags = clangdFlags(lang.id, file);
    if (flags) await fsApi.writeFile(`${root}/compile_flags.txt`, flags);
  }
  return { copy, root };
}
