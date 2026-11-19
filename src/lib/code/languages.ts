import type { Extension } from "@codemirror/state";
import { StreamLanguage, indentUnit } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { extname } from "../api";

export type LangId = "python" | "c" | "cpp" | "java" | "javascript" | "typescript" | "rust" | "json" | "toml";

export interface LangInfo {
  id: LangId;
  label: string;
  /** LSP languageId */
  lspId: string;
  /** Which language server handles it (null = none). */
  server: "python" | "clangd" | "java" | "typescript" | "rust" | null;
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

/** Conventional indentation per language (PEP 8, rustfmt, Google Java, Prettier). */
export function indentFor(lang: LangInfo | null): Extension {
  const two = lang && ["javascript", "typescript", "json"].includes(lang.id);
  return indentUnit.of(two ? "  " : "    ");
}

export function langFor(path: string | null): LangInfo | null {
  if (!path) return null;
  return BY_EXT[extname(path)] ?? null;
}
