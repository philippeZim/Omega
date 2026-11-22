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
  /** Inside a `"` or `'` literal continued with a backslash. */
  quote: string | null;
  /** Inside a `//` comment continued with a backslash. */
  lineComment: boolean;
  depth: number;
  braces: number;
  /** The last code on earlier lines, for telling a new statement from a continuation. */
  last: string;
  /** The current statement is `if (…)` or similar, whose body may follow on its own line. */
  control: boolean;
  /** The previous line ended in a backslash inside a preprocessor directive. */
  directive: boolean;
  /** Between `clang-format off` and `on`. */
  off: boolean;
}

/** An odd number of backslashes at the end: the line continues on the next one. */
const endsContinued = (line: string) => /\\+$/.exec(line.replace(/\r$/, ""))?.[0].length! % 2 === 1;

function readMarker(note: string, s: Scan) {
  const m = /^clang-format (off|on)(?::.*)?$/.exec(note.trim());
  if (m) s.off = m[1] === "off";
}

/** Reads a literal from `i` (just after its opening quote); returns where it ends. */
function readQuoted(line: string, i: number, quote: string, s: Scan) {
  while (i < line.length && line[i] !== quote) i += line[i] === "\\" ? 2 : 1;
  if (i < line.length) {
    s.quote = null;
    return i + 1;
  }
  s.quote = endsContinued(line) ? quote : null;
  return line.length;
}

/** Reads one line, updating `s`. Returns the line's code without comments and string contents. */
function scanLine(text: string, s: Scan): string {
  const line = text.replace(/\r$/, "");
  if (s.lineComment) {
    s.lineComment = endsContinued(line);
    return "";
  }
  let code = "";
  for (let i = 0; i < line.length; ) {
    if (s.raw !== null) {
      const end = line.indexOf(s.raw, i);
      if (end < 0) return code;
      i = end + s.raw.length;
      s.raw = null;
    } else if (s.quote !== null) {
      i = readQuoted(line, i, s.quote, s);
    } else if (s.comment) {
      const end = line.indexOf("*/", i);
      if (end < 0) return code;
      i = end + 2;
      s.comment = false;
    } else if (line.startsWith("//", i)) {
      readMarker(line.slice(i + 2), s);
      s.lineComment = endsContinued(line);
      return code;
    } else if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        s.comment = true;
        return code;
      }
      readMarker(line.slice(i + 2, end), s);
      i = end + 2;
    } else if (line[i] === '"') {
      const raw = /(^|\W)(u8|[uUL])?R$/.test(line.slice(0, i)) ? /^"([^()\\\s]{0,16})\(/.exec(line.slice(i)) : null;
      if (raw) {
        s.raw = `)${raw[1]}"`;
        i += raw[0].length;
      } else {
        i = readQuoted(line, i + 1, '"', s);
      }
      code += '""';
    } else if (line[i] === "'" && !/\w/.test(line[i - 1] ?? "")) {
      i = readQuoted(line, i + 1, "'", s);
      code += "''";
    } else {
      if (line[i] === "(" || line[i] === "[") s.depth++;
      else if ((line[i] === ")" || line[i] === "]") && s.depth > 0) s.depth--;
      else if (line[i] === "{") s.braces++;
      else if (line[i] === "}" && s.braces > 0) s.braces--;
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
  const s: Scan = { comment: false, raw: null, quote: null, lineComment: false, depth: 0, braces: 0, last: "", control: false, directive: false, off: false };
  // Where the current statement and block comment start: old width and new indent.
  let stmt = { width: 0, indent: "" };
  let block = { width: 0, indent: "" };
  // A braced initializer list: the style indents its elements by a continuation, here one unit.
  let opening: { depth: number; base: string } | null = null;
  let list: { depth: number; width: number; indent: string } | null = null;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const width = /^ */.exec(line.text)![0].length;
    const head = line.text.slice(width).trim();
    // The next line's leading spaces belong to a literal or a comment's text.
    const literal = s.raw !== null || s.quote !== null || s.lineComment;
    const inComment = s.comment;
    const inDirective = s.directive;
    const frozen = s.off;
    const { depth, braces } = s;
    const wasContinued = !literal && !inComment && !inDirective && continues(s, head);
    const code = scanLine(line.text, s).trim();
    const directive = !literal && (inDirective || code.startsWith("#"));
    s.directive = directive && endsContinued(line.text);
    if (directive) Object.assign(s, { depth, braces });
    if (literal) {
      if (code) s.last = code;
      continue;
    }

    if (opening && head && !inComment && !directive && !frozen) {
      if (braces >= opening.depth) list = { depth: opening.depth, width, indent: opening.base + unit };
      opening = null;
    }
    const closing = /^\}+/.exec(head)?.[0].length ?? 0;
    if (list && braces - closing < list.depth) list = null;

    let indent: string | null = null;
    if (!head || frozen || s.off || directive) indent = null;
    else if (inComment) indent = block.indent + " ".repeat(Math.max(0, width - block.width));
    else if (list && width >= list.width) indent = list.indent + " ".repeat(width - list.width);
    else if (wasContinued && width >= stmt.width) indent = stmt.indent + " ".repeat(width - stmt.width);
    else {
      indent = width === stmt.width ? stmt.indent : unit.repeat(Math.floor(width / FALLBACK_WIDTH)) + " ".repeat(width % FALLBACK_WIDTH);
      if (code) {
        stmt = { width, indent };
        s.control = /^(\}\s*)?(else\s+)?(if|for|while|switch|else|do)\b/.test(code);
      }
    }
    if (!inComment && s.comment) block = { width, indent: indent ?? line.text.slice(0, width) };
    if (indent !== null && !list && s.depth === 0 && /(?:=\s*|\breturn\s*|\w)\{$/.test(code)) opening = { depth: s.braces, base: indent };
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

const isPos = (p: any) => Number.isInteger(p?.line) && p.line >= 0 && Number.isInteger(p?.character) && p.character >= 0;
const isEdit = (e: any) =>
  typeof e?.newText === "string" && isPos(e.range?.start) && isPos(e.range?.end) &&
  (e.range.start.line < e.range.end.line || (e.range.start.line === e.range.end.line && e.range.start.character <= e.range.end.character));

/**
 * clangd's edits for `file`: as they are under a style file, else keeping the file's indentation.
 * Edits that make no sense are not applied at all: a wrong rewrite would damage the code.
 */
export async function keepFileIndent(file: string, text: string, edits: any[], options: { tabSize: number; insertSpaces: boolean }): Promise<any[]> {
  if (!edits.every(isEdit)) return [];
  try {
    if (await findClangFormat(file)) return edits;
    const unit = options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
    return unit === " ".repeat(FALLBACK_WIDTH) ? edits : reindentEdits(text, edits, unit);
  } catch {
    return [];
  }
}
