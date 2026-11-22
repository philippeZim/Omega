/**
 * clangd ignores the LSP formatting options: it follows a `.clang-format`, else its fallback style.
 * Without a style file, its result is re-indented here so the file keeps its own indentation.
 */
import { ChangeSet, Text } from "@codemirror/state";
import { dirname, fsApi, isRoot, joinPath } from "../api";

/** Indent width of the fallback style clangd is started with (`--fallback-style=LLVM`). */
const FALLBACK_WIDTH = 2;
const STYLE_FILES = [".clang-format", "_clang-format"];

/** The style file clang-format would use for `file`: the nearest one up the tree. */
export async function findClangFormat(file: string): Promise<string | null> {
  let dir = dirname(file);
  for (;;) {
    for (const name of STYLE_FILES) {
      const candidate = joinPath(dir, name);
      if (await fsApi.exists(candidate).catch(() => false)) return candidate;
    }
    const up = dirname(dir);
    if (isRoot(dir) || up === dir) return null;
    dir = up;
  }
}

/** A private copy lives outside the project: gives it the style file its real file would use. */
export async function syncPrivateStyle(real: string, copyDir: string) {
  const style = await findClangFormat(real);
  const target = joinPath(copyDir, ".clang-format");
  if (style) await fsApi.writeFile(target, await fsApi.readFile(style));
  else if (await fsApi.exists(target)) await fsApi.remove(target);
}

/** What a line of C/C++ leaves open for the next one. */
interface Scan {
  comment: boolean;
  raw: string | null;
  depth: number;
  /** The last code on earlier lines, for telling a new statement from a continuation. */
  last: string;
  /** The current statement is `if (…)` or similar, whose body may follow on its own line. */
  control: boolean;
  /** The previous line ended in a backslash inside a preprocessor directive. */
  directive: boolean;
  /** Between `// clang-format off` and `on`. */
  off: boolean;
}

/** Reads one line, updating `s`. Returns the line's code without comments and string contents. */
function scanLine(line: string, s: Scan): string {
  let code = "";
  for (let i = 0; i < line.length; ) {
    if (s.raw !== null) {
      const end = line.indexOf(s.raw, i);
      if (end < 0) return code;
      i = end + s.raw.length;
      s.raw = null;
    } else if (s.comment) {
      const end = line.indexOf("*/", i);
      if (end < 0) return code;
      i = end + 2;
      s.comment = false;
    } else if (line.startsWith("//", i)) {
      const note = line.slice(i + 2).trim();
      if (note === "clang-format off") s.off = true;
      else if (note === "clang-format on") s.off = false;
      return code;
    } else if (line.startsWith("/*", i)) {
      s.comment = true;
      i += 2;
    } else if (line[i] === '"') {
      const raw = line[i - 1] === "R" ? /^"([^()\\\s]{0,16})\(/.exec(line.slice(i)) : null;
      if (raw) {
        s.raw = `)${raw[1]}"`;
        i += raw[0].length;
      } else {
        for (i++; i < line.length && line[i] !== '"'; i += line[i] === "\\" ? 2 : 1);
        i++;
      }
      code += '""';
    } else if (line[i] === "'" && !/\w/.test(line[i - 1] ?? "")) {
      for (i++; i < line.length && line[i] !== "'"; i += line[i] === "\\" ? 2 : 1);
      i++;
      code += "''";
    } else {
      if (line[i] === "(" || line[i] === "[") s.depth++;
      else if ((line[i] === ")" || line[i] === "]") && s.depth > 0) s.depth--;
      code += line[i++];
    }
  }
  return code;
}

/** Whether the line after `s.last` carries on the statement rather than starting a new one. */
function continues(s: Scan, code: string) {
  if (s.depth > 0) return true;
  if (!s.last || /[;{}:]$/.test(s.last) || code.startsWith("{") || code.startsWith("}")) return false;
  if (/\b(else|do)$/.test(s.last)) return false;
  return !(s.control && s.last.endsWith(")"));
}

/** Changes that turn the fallback style's leading spaces in `doc` into `unit`. */
function indentChanges(doc: Text, unit: string) {
  const changes: { from: number; to: number; insert: string }[] = [];
  const s: Scan = { comment: false, raw: null, depth: 0, last: "", control: false, directive: false, off: false };
  // Where the current statement and block comment start: old width and new indent.
  let stmt = { width: 0, indent: "" };
  let block = { width: 0, indent: "" };
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const width = /^ */.exec(line.text)![0].length;
    const rest = line.text.slice(width);
    const inRaw = s.raw !== null;
    const inComment = s.comment;
    const inDirective = s.directive;
    const frozen = s.off;
    const wasContinued = !inComment && !inRaw && !inDirective && continues(s, rest.trim());
    const code = scanLine(line.text, s).trim();
    s.directive = (inDirective || code.startsWith("#")) && line.text.trimEnd().endsWith("\\");
    if (inRaw) continue;
    const directive = inDirective || code.startsWith("#");

    let indent: string | null = null;
    if (!rest.trim() || frozen || s.off || directive) indent = null;
    else if (inComment) indent = block.indent + " ".repeat(Math.max(0, width - block.width));
    else if (wasContinued && width >= stmt.width) indent = stmt.indent + " ".repeat(width - stmt.width);
    else {
      indent = unit.repeat(Math.floor(width / FALLBACK_WIDTH)) + " ".repeat(width % FALLBACK_WIDTH);
      if (code) {
        stmt = { width, indent };
        s.control = /^(\}\s*)?(else\s+)?(if|for|while|switch|else|do)\b/.test(code);
      }
    }
    if (!inComment && s.comment) block = { width, indent: indent ?? line.text.slice(0, width) };
    if (indent !== null && indent !== line.text.slice(0, width)) changes.push({ from: line.from, to: line.from + width, insert: indent });
    if (code && !directive) s.last = code;
  }
  return changes;
}

const lspPos = (doc: Text, offset: number) => {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
};
const offsetOf = (doc: Text, p: { line: number; character: number }) => {
  if (p.line >= doc.lines) return doc.length;
  const line = doc.line(p.line + 1);
  return Math.min(line.to, line.from + p.character);
};

/** `edits` (from the fallback style) rewritten so the result is indented with `unit`. */
export function reindentEdits(text: string, edits: any[], unit: string): any[] {
  const doc = Text.of(text.split("\n"));
  const format = ChangeSet.of(
    edits.map((e) => ({ from: offsetOf(doc, e.range.start), to: offsetOf(doc, e.range.end), insert: Text.of(String(e.newText).split("\n")) })),
    doc.length,
  );
  const formatted = format.apply(doc);
  const all = format.compose(ChangeSet.of(indentChanges(formatted, unit), formatted.length));
  const out: any[] = [];
  all.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const newText = inserted.toString();
    if (doc.sliceString(fromA, toA) !== newText) out.push({ range: { start: lspPos(doc, fromA), end: lspPos(doc, toA) }, newText });
  });
  return out;
}

/** clangd's edits for `file`: as they are under a style file, else keeping the file's indentation. */
export async function keepFileIndent(file: string, text: string, edits: any[], options: { tabSize: number; insertSpaces: boolean }) {
  if (await findClangFormat(file)) return edits;
  const unit = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
  return unit === " ".repeat(FALLBACK_WIDTH) ? edits : reindentEdits(text, edits, unit);
}
