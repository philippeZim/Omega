/** Mojo highlighting and indentation: Python's mode with the keywords Mojo adds (checked against Mojo 1.2). */
import type { StreamParser } from "@codemirror/language";
import { python } from "@codemirror/legacy-modes/mode/python";

/** Reserved in Mojo. `fn` was removed in 1.x but still appears in older code. */
const KEYWORDS = new Set(["fn", "struct", "trait", "var", "comptime", "ref"]);
/** Argument conventions: ordinary names unless a parameter name follows (`mut x`, but `out = 1`). */
const CONVENTIONS = new Set(["mut", "out", "imm", "deinit"]);
const TYPES = new Set(["Self", "Int", "UInt", "Bool", "String", "StringLiteral", "StaticString", "Float16", "Float32", "Float64", "Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64", "SIMD", "List", "Dict", "Set", "Optional", "Tuple", "Span", "Pointer", "Error", "AnyType", "Copyable", "Movable"]);

export const mojoParser: StreamParser<unknown> = {
  ...python,
  name: "mojo",
  token(stream, state) {
    const style = python.token(stream, state as never);
    if (style !== "variable" && style !== "builtin") return style;
    const word = stream.current();
    if (KEYWORDS.has(word)) return "keyword";
    if (TYPES.has(word)) return "type";
    if (CONVENTIONS.has(word) && stream.match(/^\s+[A-Za-z_]/, false)) return "keyword";
    if (word === "raises" && stream.match(/^\s*(?:->|:|[A-Z])/, false)) return "keyword";
    return style;
  },
};

/** The line without strings and comments. */
const code = (line: string) => line.replace(/"""[^]*?(?:"""|$)|'''[^]*?(?:'''|$)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#.*$/g, (m) => (m[0] === "#" ? "" : '""')).trimEnd();

/** Indent steps for the line after this one: in after a `:`, out after a statement that ends a block. */
export function mojoIndentStep(line: string): -1 | 0 | 1 {
  const text = code(line);
  if (text.endsWith(":")) return 1;
  return /^\s*(?:return|raise|pass|break|continue)\b/.test(text) ? -1 : 0;
}
