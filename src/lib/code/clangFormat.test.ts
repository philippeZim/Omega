import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { findClangFormat, keepFileIndent, reindentEdits, syncPrivateStyle } from "./clangFormat";

const fs = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  fsApi: {
    exists: async (p: string) => fs.files.has(p),
    readFile: async (p: string) => fs.files.get(p)!,
    writeFile: async (p: string, c: string) => void fs.files.set(p, c),
    remove: async (p: string) => void fs.files.delete(p),
  },
}));
beforeEach(() => fs.files.clear());

/** One edit replacing all of `from` with the fallback style's `to`. */
const whole = (from: string, to: string) => {
  const lines = from.split("\n");
  return [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } }, newText: to }];
};
const apply = (text: string, edits: any[]) => {
  const doc = Text.of(text.split("\n"));
  const at = (p: any) => doc.line(p.line + 1).from + p.character;
  return ChangeSet.of(edits.map((e) => ({ from: at(e.range.start), to: at(e.range.end), insert: e.newText })), doc.length).apply(doc).toString();
};
const reformat = (formatted: string, unit: string, original = "x") => apply(original, reindentEdits(original, whole(original, formatted), unit));

describe("reindentEdits", () => {
  const llvm = "int main(void) {\n  int a = 1;\n  if (a) {\n    return a;\n  }\n  return 0;\n}\n";

  test("tabs", () => {
    expect(reformat(llvm, "\t")).toBe("int main(void) {\n\tint a = 1;\n\tif (a) {\n\t\treturn a;\n\t}\n\treturn 0;\n}\n");
  });

  test("four spaces", () => {
    expect(reformat(llvm, "    ")).toBe("int main(void) {\n    int a = 1;\n    if (a) {\n        return a;\n    }\n    return 0;\n}\n");
  });

  test("a body without braces is a block, not a continuation", () => {
    expect(reformat("void f() {\n  if (a)\n    b();\n  else\n    c();\n  while (d)\n    e();\n}\n", "\t")).toBe("void f() {\n\tif (a)\n\t\tb();\n\telse\n\t\tc();\n\twhile (d)\n\t\te();\n}\n");
  });

  test("continuation lines keep their alignment after the block's indent", () => {
    expect(reformat("void f() {\n  call(first,\n       second);\n  next();\n}\n", "\t")).toBe("void f() {\n\tcall(first,\n\t     second);\n\tnext();\n}\n");
  });

  test("a multi-line condition still has its body as a block", () => {
    expect(reformat("void f() {\n  if (a &&\n      b)\n    c();\n}\n", "\t")).toBe("void f() {\n\tif (a &&\n\t    b)\n\t\tc();\n}\n");
  });

  test("enums and closing braces return to the block's indent", () => {
    expect(reformat("enum E {\n  A,\n  B\n};\nint x;\n", "\t")).toBe("enum E {\n\tA,\n\tB\n};\nint x;\n");
  });

  test("comments follow the code, block comments keep their shape", () => {
    expect(reformat("void f() {\n  // note\n  /* a\n   * b\n   */\n  g();\n}\n", "\t")).toBe("void f() {\n\t// note\n\t/* a\n\t * b\n\t */\n\tg();\n}\n");
  });

  test("raw strings, directives and clang-format off regions stay untouched", () => {
    const raw = 'void f() {\n  auto s = R"(\n  kept\n)";\n}\n';
    expect(reformat(raw, "\t")).toBe('void f() {\n\tauto s = R"(\n  kept\n)";\n}\n');
    expect(reformat("#define A \\\n  1\nint x;\n", "\t")).toBe("#define A \\\n  1\nint x;\n");
    expect(reformat("// clang-format off\n  int  a;\n// clang-format on\nvoid f() {\n  g();\n}\n", "\t")).toBe("// clang-format off\n  int  a;\n// clang-format on\nvoid f() {\n\tg();\n}\n");
  });

  test("text that is already right produces no edits", () => {
    const tabs = "void f() {\n\tg();\n}\n";
    const edits = [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "  " }];
    expect(reindentEdits(tabs, edits, "\t")).toEqual([]);
  });

  test("only what changes is edited, so the cursor can stay", () => {
    const text = "void f() {\n\tint a=1;\n}\n";
    const edits = [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "  " },
      { range: { start: { line: 1, character: 6 }, end: { line: 1, character: 6 } }, newText: " " },
      { range: { start: { line: 1, character: 7 }, end: { line: 1, character: 7 } }, newText: " " },
    ];
    const out = reindentEdits(text, edits, "\t");
    expect(apply(text, out)).toBe("void f() {\n\tint a = 1;\n}\n");
    expect(out.every((e) => e.range.start.line === 1 && e.range.start.character >= 6)).toBe(true);
  });
});

describe("style files", () => {
  test("found up the tree, under either name", async () => {
    fs.files.set("/p/.clang-format", "");
    expect(await findClangFormat("/p/src/deep/a.c")).toBe("/p/.clang-format");
    fs.files.clear();
    fs.files.set("/p/src/_clang-format", "");
    expect(await findClangFormat("/p/src/a.c")).toBe("/p/src/_clang-format");
    fs.files.clear();
    expect(await findClangFormat("/p/src/a.c")).toBeNull();
  });

  test("a project's style file wins: its edits are left alone", async () => {
    fs.files.set("/p/.clang-format", "IndentWidth: 8");
    const edits = whole("x", "a\n        b");
    expect(await keepFileIndent("/p/a.c", "x", edits, { tabSize: 4, insertSpaces: false })).toBe(edits);
  });

  test("without one the file's indentation is kept", async () => {
    const out = await keepFileIndent("/p/a.c", "x", whole("x", "f() {\n  g();\n}"), { tabSize: 4, insertSpaces: false });
    expect(apply("x", out)).toBe("f() {\n\tg();\n}");
  });

  test("a private copy gets its real file's style file, and loses it again", async () => {
    fs.files.set("/p/_clang-format", "IndentWidth: 8");
    await syncPrivateStyle("/p/src/a.txt", "/priv/lsp");
    expect(fs.files.get("/priv/lsp/.clang-format")).toBe("IndentWidth: 8");
    expect(fs.files.get("/p/_clang-format")).toBe("IndentWidth: 8");
    fs.files.delete("/p/_clang-format");
    await syncPrivateStyle("/p/src/a.txt", "/priv/lsp");
    expect(fs.files.has("/priv/lsp/.clang-format")).toBe(false);
  });
});
