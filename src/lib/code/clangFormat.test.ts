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

describe("text that must not change", () => {
  test("a string continued with a backslash", () => {
    const c = 'void f() {\n  const char *s = "abc\\\n    def";\n  g();\n}\n';
    expect(reformat(c, "\t")).toBe('void f() {\n\tconst char *s = "abc\\\n    def";\n\tg();\n}\n');
  });

  test("a continued string followed by an unindented line", () => {
    const c = 'const char *s = "abc\\\ndef";\nvoid f() {\n  g();\n}\n';
    expect(reformat(c, "\t")).toBe('const char *s = "abc\\\ndef";\nvoid f() {\n\tg();\n}\n');
  });

  test("a string over several continued lines, and an escaped backslash that ends it", () => {
    const c = 'char *a = "x\\\n  y\\\n    z";\nchar *b = "w\\\\";\nvoid f() {\n  g();\n}\n';
    expect(reformat(c, "\t")).toBe('char *a = "x\\\n  y\\\n    z";\nchar *b = "w\\\\";\nvoid f() {\n\tg();\n}\n');
  });

  test("a // comment continued with a backslash", () => {
    const c = "void f() {\n  // note \\\n    still the comment\n  g();\n}\n";
    expect(reformat(c, "\t")).toBe("void f() {\n\t// note \\\n    still the comment\n\tg();\n}\n");
  });

  test("/* clang-format off */ works like the // form", () => {
    const c = "/* clang-format off */\n  int  a;\n    int b;\n/* clang-format on */\nvoid f() {\n  g();\n}\n";
    expect(reformat(c, "\t")).toBe("/* clang-format off */\n  int  a;\n    int b;\n/* clang-format on */\nvoid f() {\n\tg();\n}\n");
  });

  test("indented markers stay as they are", () => {
    const c = "void f() {\n  /* clang-format off */\n      int  a;\n  /* clang-format on */\n  g();\n}\n";
    expect(reformat(c, "\t")).toBe("void f() {\n  /* clang-format off */\n      int  a;\n  /* clang-format on */\n\tg();\n}\n");
  });
});

describe("braced initializer lists", () => {
  test("elements get one unit", () => {
    expect(reformat("std::vector<int> v = {\n    1,\n    2,\n};\nint x;\n", "\t")).toBe("std::vector<int> v = {\n\t1,\n\t2,\n};\nint x;\n");
  });

  test("inside a function", () => {
    expect(reformat("void f() {\n  std::vector<int> w = {\n      1,\n      2,\n  };\n  g();\n}\n", "\t")).toBe("void f() {\n\tstd::vector<int> w = {\n\t\t1,\n\t\t2,\n\t};\n\tg();\n}\n");
  });

  test("nested lists and four spaces", () => {
    expect(reformat("int m[2][2] = {\n    {1, 2},\n    {3, 4},\n};\n", "    ")).toBe("int m[2][2] = {\n    {1, 2},\n    {3, 4},\n};\n");
  });

  test("a list inside a call keeps its alignment", () => {
    expect(reformat("void f() {\n  call(1, {\n              2,\n          });\n  g();\n}\n", "\t")).toBe("void f() {\n\tcall(1, {\n\t            2,\n\t        });\n\tg();\n}\n");
  });
});

describe("re-indenting never changes the program", () => {
  /** Code tokens, with string literals byte for byte; whitespace and comments are left out. */
  function tokens(src: string) {
    const out: string[] = [];
    for (let i = 0; i < src.length; ) {
      const rest = src.slice(i);
      const raw = /^(?:u8|[uUL])?R"([^()\\\s]*)\(/.exec(rest);
      if (raw) {
        const close = `)${raw[1]}"`;
        const end = src.indexOf(close, i + raw[0].length) + close.length;
        out.push(src.slice(i, end));
        i = end;
      } else if (rest.startsWith("//")) {
        for (i += 2; i < src.length && !(src[i] === "\n" && src[i - 1] !== "\\"); i++);
      } else if (rest.startsWith("/*")) {
        i = src.indexOf("*/", i + 2) + 2;
      } else if (src[i] === '"' || (src[i] === "'" && !/\w/.test(src[i - 1] ?? ""))) {
        let j = i + 1;
        while (src[j] !== src[i]) j += src[j] === "\\" ? 2 : 1;
        out.push(src.slice(i, j + 1));
        i = j + 1;
      } else if (/\s/.test(src[i])) {
        i++;
      } else {
        const word = /^[\w']+/.exec(rest)?.[0] ?? src[i];
        out.push(word);
        i += word.length;
      }
    }
    return out;
  }

  const CORPUS = [
    'const char *s = "abc\\\n    def";\nint a;\n',
    'const char *s = "abc\\\ndef";\n',
    'char c = \'"\';\nchar d = \'\\\'\';\nvoid f() {\n  g("}{", \'{\');\n}\n',
    'auto r = R"x(\n  )" not the end\n    {\n)x";\nvoid f() {\n  g();\n}\n',
    'auto u = u8R"(\n  a\n)" "b\\\n  c";\n',
    'void f() {\n  // it\'s a "comment \\\n    continued { here\n  g();\n}\n',
    "/* a { ( \" '\n   * b\n   */\nvoid f() {\n  /* c */ g(); /* d\n     e */\n  h();\n}\n",
    '#define S "a\\\n  b"\n#define OPEN (\nvoid f() {\n  g();\n}\n',
    "// clang-format off\n  int  a = {  1,\n     2 };\n// clang-format on\nint b;\n",
    "/* clang-format off */\n  char *t = \"x\\\n y\";\n/* clang-format on */\nint b;\n",
    "std::vector<int> v = {\n    1,\n    2,\n};\nint m[2][2] = {\n    {1, 2},\n    {3, 4},\n};\n",
    "void f() {\n  call(first,\n       \"second\\\n  third\",\n       4);\n  if (a &&\n      b)\n    c();\n  else\n    d();\n}\n",
    "class A {\npublic:\n  int x = 1'000'000;\n  A() : x(2) {}\n};\nswitch (a) {\ncase 1:\n  break;\n}\n",
    "template <class T>\nstruct B {\n  T t{\n      1,\n  };\n};\nauto l = [](int a) {\n  return a;\n};\n",
  ];

  /** The literals alone, so a change in one is reported as exactly that. */
  const literals = (src: string) => tokens(src).filter((t) => /^(?:u8|[uUL])?R?["']/.test(t));

  test.each(["\t", "    ", "   ", "        "])("unit %j", (unit) => {
    for (const src of CORPUS) {
      const out = reformat(src, unit);
      expect(tokens(out)).toEqual(tokens(src));
      expect(literals(out)).toEqual(literals(src));
    }
  });

  test("the corpus does contain literals across lines", () => {
    expect(CORPUS.flatMap(literals).some((l) => l.includes("\n"))).toBe(true);
  });
});

describe("edits that make no sense", () => {
  const bad: any[][] = [
    [{ range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }],
    [{ range: { start: { line: 0, character: -1 }, end: { line: 0, character: 0 } }, newText: "x" }],
    [{ range: null, newText: "x" }],
    [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }],
    [null],
  ];

  test.each(bad)("apply nothing: %j", async (edit: any) => {
    await expect(keepFileIndent("/p/a.c", "x\ny\n", [edit], { tabSize: 4, insertSpaces: false })).resolves.toEqual([]);
  });

  test("also under a style file", async () => {
    fs.files.set("/p/.clang-format", "");
    await expect(keepFileIndent("/p/a.c", "x\n", bad[0], { tabSize: 4, insertSpaces: false })).resolves.toEqual([]);
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
