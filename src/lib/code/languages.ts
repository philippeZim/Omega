import { StateField, type Extension, type Text } from "@codemirror/state";
import { StreamLanguage, indentService, indentUnit } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { scala } from "@codemirror/legacy-modes/mode/clike";
import { oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { extname } from "../api";

export type LangId = "python" | "c" | "cpp" | "java" | "javascript" | "typescript" | "rust" | "json" | "toml" | "scala" | "ocaml";

export interface LangInfo {
  id: LangId;
  label: string;
  /** LSP languageId */
  lspId: string;
  /** Which language server handles it (null = none). */
  server: "python" | "clangd" | "java" | "typescript" | "rust" | "scala" | "ocaml" | null;
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
  const two = lang && ["javascript", "typescript", "json", "scala", "ocaml"].includes(lang.id);
  const fallback = two ? "  " : "    ";
  const unit = StateField.define<string>({ create: (state) => detectIndent(state.doc) ?? fallback, update: (v) => v });
  return [unit, indentUnit.from(unit)];
}

export function langFor(path: string | null): LangInfo | null {
  if (!path) return null;
  return BY_EXT[extname(path)] ?? null;
}
