/** Highlighting and indentation rules for config and script files that have no language server. */
import type { StreamParser } from "@codemirror/language";

interface MakeState {
  /** The line is a recipe (shell commands). */
  recipe: boolean;
  /** The previous line ended in a backslash. */
  continued: boolean;
  /** Nothing has been read on this logical line yet. */
  head: boolean;
}

const DIRECTIVE = /^(?:-?include|sinclude|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|unexport|override|private|vpath)(?![\w.-])/;

/** Reads `$(...)` or `${...}` including nested references; the `$` is already consumed. */
function readReference(stream: Parameters<StreamParser<MakeState>["token"]>[0]) {
  const open = stream.next();
  const close = open === "(" ? ")" : "}";
  let depth = 1;
  while (depth > 0) {
    const c = stream.next();
    if (c == null) return;
    if (c === open) depth++;
    else if (c === close) depth--;
  }
}

export const makefileParser: StreamParser<MakeState> = {
  name: "makefile",
  startState: () => ({ recipe: false, continued: false, head: true }),
  token(stream, state) {
    if (stream.sol()) {
      if (!state.continued) state.recipe = stream.peek() === "\t";
      state.head = !state.continued && !state.recipe;
      state.continued = /\\$/.test(stream.string);
    }
    if (stream.eatSpace()) return null;
    const c = stream.peek();
    if (c === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (c === "\\") {
      stream.next();
      stream.next();
      return null;
    }
    if (c === "$") {
      stream.next();
      const after = stream.peek();
      if (after === "(" || after === "{") readReference(stream);
      else stream.next();
      return "variable-2";
    }
    if (state.recipe) {
      if (c === '"' || c === "'") {
        stream.next();
        let prev = "";
        for (let n = stream.next(); n != null; n = stream.next()) {
          if (n === c && prev !== "\\") break;
          prev = prev === "\\" ? "" : n;
        }
        return "string";
      }
      stream.next();
      stream.eatWhile(/[^\s$#"'\\]/);
      return null;
    }
    if (state.head) {
      state.head = false;
      if (stream.match(DIRECTIVE)) return "keyword";
      if (stream.match(/^[^\s:#=$]+(?=\s*(?::{1,3}=|[?+!]?=))/)) return "def";
      if (stream.match(/^[^\s:#=]+(?:[ \t]+[^\s:#=]+)*(?=\s*:{1,2}(?![:=]))/)) return "def";
    }
    if (stream.match(/^(?::{1,3}=|[?+!]?=|::?)/)) return "operator";
    stream.next();
    stream.eatWhile(/[^\s$#:=\\]/);
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

/** Whether the next line belongs to this rule's recipe. Assignments and `.PHONY`-style lines have none. */
export function makefileOpensRecipe(line: string): boolean {
  if (/\\$/.test(line) || /^\.[A-Z_]+\s*:/.test(line)) return false;
  const rule = /^[^\s#=:][^#=:]*:{1,2}(?![:=])(.*)$/.exec(line);
  // `target: VAR = value` sets a variable for the target and has no recipe.
  return !!rule && !/^\s*[^\s:#=]+\s*(?::{1,3}=|[?+!]?=)/.test(rule[1]);
}

/** The line without quoted strings and its trailing `#` comment. */
const hashCode = (line: string) =>
  line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|(^|\s)#.*$/g, (m, lead) => (lead !== undefined && m.trimStart()[0] === "#" ? "" : '""')).trimEnd();

/** Whether a shell line opens a block (`then`, `do`, `else`, `{`, `(`, `case … in`). */
export function shellOpensBlock(line: string): boolean {
  const text = hashCode(line);
  return /(?:^|[\s;])(?:then|do|else)$|[{(]$/.test(text) || /^\s*case\b.*\bin$/.test(text);
}

/** Whether the text of a shell line starts by closing a block. */
export const shellClosesBlock = (text: string) => /^\s*(?:(?:fi|done|esac|else|elif)(?![\w-])|[})])/.test(text);

/** Extra columns for the line after this YAML line: past `- ` markers, one step more after `key:` or `key: |`. */
export function yamlIndentAfter(line: string, unit: number): number {
  const text = hashCode(line);
  const dashes = /^\s*((?:-\s+)+)/.exec(text)?.[1].length ?? 0;
  return dashes + (/:$|:\s+[|>][-+0-9]*$/.test(text) || /^\s*-$/.test(text) ? unit : 0);
}

/** Whether a Dockerfile line continues on the next one. */
export const dockerContinues = (line: string) => /\\\s*$/.test(line);
