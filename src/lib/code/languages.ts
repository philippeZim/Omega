import { StateField, type Extension, type Text } from "@codemirror/state";
import { StreamLanguage, indentService, indentUnit, type IndentContext } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { scala } from "@codemirror/legacy-modes/mode/clike";
import { oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { basename, extname } from "../api";
import { mojoIndentStep, mojoParser } from "./mojoMode";
import { dockerContinues, makefileOpensRecipe, makefileParser, shellClosesBlock, shellOpensBlock, yamlIndentAfter } from "./configModes";

export type LangId = "python" | "c" | "cpp" | "java" | "javascript" | "typescript" | "rust" | "json" | "toml" | "scala" | "ocaml" | "mojo" | "sql" | "yaml" | "shell" | "dockerfile" | "xml" | "makefile";

export interface LangInfo {
  id: LangId;
  label: string;
  /** LSP languageId */
  lspId: string;
  /** Which language server handles it (null = none). */
  server: "python" | "clangd" | "java" | "typescript" | "rust" | "scala" | "ocaml" | "mojo" | null;
  ext: () => Extension;
}

const L = (id: LangId, label: string, lspId: string, server: LangInfo["server"], ext: () => Extension): LangInfo => ({ id, label, lspId, server, ext });

const BY_EXT: Record<string, LangInfo> = {};
const reg = (exts: string[], info: LangInfo) => exts.forEach((e) => (BY_EXT[e] = info));

reg(["py", "pyi"], L("python", "Python", "python", "python", () => python()));
reg(["c", "h"], L("c", "C", "c", "clangd", () => cpp()));
reg(["cpp", "cc", "cxx", "hpp", "hh", "hxx"], L("cpp", "C++", "cpp", "clangd", () => cpp()));
reg(["java"], L("java", "Java", "java", "java", () => java()));
reg(["js", "mjs", "cjs"], L("javascript", "JavaScript", "javascript", "typescript", () => javascript()));
reg(["jsx"], L("javascript", "JavaScript", "javascriptreact", "typescript", () => javascript({ jsx: true })));
reg(["ts", "mts", "cts"], L("typescript", "TypeScript", "typescript", "typescript", () => javascript({ typescript: true })));
reg(["tsx"], L("typescript", "TypeScript", "typescriptreact", "typescript", () => javascript({ typescript: true, jsx: true })));
reg(["rs"], L("rust", "Rust", "rust", "rust", () => rust()));
reg(["json"], L("json", "JSON", "json", null, () => json()));
reg(["toml"], L("toml", "TOML", "toml", null, () => StreamLanguage.define(toml)));
reg(["scala", "sc"], L("scala", "Scala", "scala", "scala", () => [StreamLanguage.define(scala), scalaIndent]));
// ocamllsp parses by languageId: an interface sent as "ocaml" would be full of false errors.
reg(["ml"], L("ocaml", "OCaml", "ocaml", "ocaml", () => [StreamLanguage.define(oCaml), ocamlIndent]));
reg(["mli"], L("ocaml", "OCaml", "ocaml.interface", "ocaml", () => [StreamLanguage.define(oCaml), ocamlIndent]));
reg(["mojo", "🔥"], L("mojo", "Mojo", "mojo", "mojo", () => [StreamLanguage.define(mojoParser), mojoIndent]));
reg(["sql"], L("sql", "SQL", "sql", null, () => StreamLanguage.define(standardSQL)));
reg(["yaml", "yml"], L("yaml", "YAML", "yaml", null, () => [StreamLanguage.define(yaml), yamlIndent]));
reg(["sh", "bash", "zsh", "ksh"], L("shell", "Shell", "shellscript", null, () => [StreamLanguage.define(shellWithIndent), shellIndent]));
reg(["dockerfile", "containerfile"], L("dockerfile", "Dockerfile", "dockerfile", null, () => [StreamLanguage.define(dockerFile), dockerIndent]));
reg(["xml", "xsd", "xsl", "xslt", "svg"], L("xml", "XML", "xml", null, () => StreamLanguage.define(xml)));
reg(["mk", "mak"], L("makefile", "Makefile", "makefile", null, () => [StreamLanguage.define(makefileParser), makefileIndent]));

const SHELL_DOTFILES = new Set([".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".kshrc"]);

/** The language a file's name stands for when its extension doesn't say (`Dockerfile.dev`, `Makefile`, `.bashrc`). */
function langForName(path: string): LangInfo | null {
  const name = basename(path);
  // `Dockerfile.dev` is a Dockerfile; `Dockerfile.md` and `Dockerfile.dockerignore` are not.
  if (/^(?:docker|container)file(?:\.[^.]+)*$/i.test(name) && !/\.(?:md|markdown|txt|tex|bib|sty|cls|dockerignore)$/i.test(name)) return BY_EXT.dockerfile;
  if (/^(?:gnu)?makefile(?:\.(?:am|in))?$/i.test(name)) return BY_EXT.mk;
  return SHELL_DOTFILES.has(name) ? BY_EXT.sh : null;
}

/** Whether the file's name alone (no known extension) makes it a code file. */
export const isNamedCodeFile = (path: string) => !BY_EXT[extname(path)] && !!langForName(path);

/** Whether a Scala line opens an indented block without braces (Scala 3 syntax, `def f =`, `case x =>`). */
export function scalaOpensBlock(line: string): boolean {
  const code = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, "").trimEnd();
  return /(?:[^=!<>]=|=>|<-|:|\b(?:then|else|do|try|catch|finally|yield|match|with))$/.test(code);
}

/** Indents after a line that opens a block; everything else is left to the clike mode (braces). */
const scalaIndent = indentService.of((cx, pos) => {
  let line = cx.lineAt(pos, -1);
  if (line.from === pos && pos > 0) line = cx.lineAt(pos - 1, -1);
  return scalaOpensBlock(line.text) ? cx.lineIndent(line.from, -1) + cx.unit : undefined;
});

/** Whether an OCaml line opens an indented block (`let f x =`, `| A ->`, `match x with`, `begin`). */
export function ocamlOpensBlock(line: string): boolean {
  const code = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)'/g, "' '").replace(/\(\*.*?\*\)/g, "").trimEnd();
  return /(?:(?:^|[^=!<>])=|->|\b(?:then|else|do|begin|struct|sig|object|with|try|function))$/.test(code);
}

/** The mllike mode has no indentation of its own: keep the line's indent, one step more after an opener. */
const ocamlIndent = indentService.of((cx, pos) => {
  let line = cx.lineAt(pos, -1);
  if (line.from === pos && pos > 0) line = cx.lineAt(pos - 1, -1);
  return cx.lineIndent(line.from, -1) + (ocamlOpensBlock(line.text) ? cx.unit : 0);
});

/** Python-style blocks: one step in after a `:`, one step out after `return`, `pass` and the like. */
const mojoIndent = indentService.of((cx, pos) => {
  let line = cx.lineAt(pos, -1);
  if (line.from === pos && pos > 0) line = cx.lineAt(pos - 1, -1);
  return Math.max(0, cx.lineIndent(line.from, -1) + mojoIndentStep(line.text) * cx.unit);
});

/** The nearest line above `pos` that isn't blank, or the first line of the document. */
function lineAbove(cx: IndentContext, pos: number) {
  let line = cx.lineAt(pos, -1);
  if (line.from === pos && pos > 0) line = cx.lineAt(pos - 1, -1);
  while (!line.text.trim() && line.from > 0) line = cx.lineAt(line.from - 1, -1);
  return line;
}

const yamlIndent = indentService.of((cx, pos) => {
  const line = lineAbove(cx, pos);
  return cx.lineIndent(line.from, -1) + yamlIndentAfter(line.text, cx.unit);
});

/** The mode has no indentation of its own; closers like `fi` re-indent as they are typed. */
const shellWithIndent = { ...shell, languageData: { ...shell.languageData, indentOnInput: /^\s*(?:fi|done|esac|else|elif|\}|\))$/ } };

const shellIndent = indentService.of((cx, pos) => {
  const line = lineAbove(cx, pos);
  const step = (shellOpensBlock(line.text) ? 1 : 0) - (shellClosesBlock(cx.textAfterPos(pos)) ? 1 : 0);
  return Math.max(0, cx.lineIndent(line.from, -1) + step * cx.unit);
});

/** A `RUN a \\` continuation is one step in; the line after the last continuation is back at the start. */
const dockerIndent = indentService.of((cx, pos) => {
  let line = cx.lineAt(pos, -1);
  if (line.from === pos && pos > 0) line = cx.lineAt(pos - 1, -1);
  const above = line.from > 0 ? cx.lineAt(line.from - 1, -1) : null;
  const inChain = !!above && dockerContinues(above.text);
  if (dockerContinues(line.text)) return cx.lineIndent(line.from, -1) + (inChain ? 0 : cx.unit);
  if (!inChain) return cx.lineIndent(line.from, -1);
  let start = above!;
  while (start.from > 0) {
    const prev = cx.lineAt(start.from - 1, -1);
    if (!dockerContinues(prev.text)) break;
    start = prev;
  }
  return cx.lineIndent(start.from, -1);
});

/** After a rule's line comes its recipe; a recipe line keeps its tab, everything else starts at column 0. */
const makefileIndent = indentService.of((cx, pos) => {
  let line = cx.lineAt(pos, -1);
  if (line.from === pos && pos > 0) line = cx.lineAt(pos - 1, -1);
  return makefileOpensRecipe(line.text) ? cx.unit : cx.lineIndent(line.from, -1);
});

/**
 * The indentation a file already uses: "\t", or the most common step between the indents of
 * neighbouring lines (2, 4 or 8 spaces). null if the file has (almost) no indented lines.
 * Only the first 2000 lines are looked at.
 */
export function detectIndent(doc: Text | string): string | null {
  const lines = (typeof doc === "string" ? doc.split("\n") : doc.toJSON()).slice(0, 2000);
  let tabs = 0, spaced = 0, prev = 0;
  const steps = new Map<number, number>();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line[0] === "\t") {
      tabs++;
      continue;
    }
    const n = /^ */.exec(line)![0].length;
    if (n) spaced++;
    const step = Math.abs(n - prev);
    if (step === 2 || step === 4 || step === 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    prev = n;
  }
  if (tabs + spaced < 2) return null;
  if (tabs > spaced) return "\t";
  let best = 0, count = 0;
  for (const [step, c] of steps) if (c > count || (c === count && step < best)) [best, count] = [step, c];
  return best ? " ".repeat(best) : null;
}

/** The file's own indentation (detected when it is loaded), else the language's convention (PEP 8, rustfmt, Google Java, Prettier, scalafmt, ocamlformat). */
export function indentFor(lang: LangInfo | null): Extension {
  const two = lang && ["javascript", "typescript", "json", "scala", "ocaml", "yaml", "shell", "xml"].includes(lang.id);
  const fallback = two ? "  " : "    ";
  const unit = StateField.define<string>({
    create: (state) => {
      if (lang?.id === "makefile") return "\t"; // make only accepts tabs before a recipe
      const found = detectIndent(state.doc);
      return lang?.id === "yaml" && found === "\t" ? fallback : found ?? fallback; // YAML forbids tabs
    },
    update: (v) => v,
  });
  return [unit, indentUnit.from(unit)];
}

/** The language the file's extension stands for. Use `effectiveLang` where a user's choice counts. */
export function langFor(path: string | null): LangInfo | null {
  if (!path) return null;
  return BY_EXT[extname(path)] ?? langForName(path);
}

/** Every language once, in the order of the picker; the plain variant (no JSX, no interface file). */
export const LANGUAGES: LangInfo[] = ["py", "c", "cpp", "java", "js", "ts", "rs", "json", "toml", "scala", "ml", "mojo", "sql", "yaml", "sh", "dockerfile", "xml", "mk"].map((e) => BY_EXT[e]);

export const langById = (id: string): LangInfo | null => LANGUAGES.find((l) => l.id === id) ?? null;
