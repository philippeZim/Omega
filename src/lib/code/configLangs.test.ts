import { describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { getIndentation, indentString, indentUnit, HighlightStyle, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { highlightTree, tags } from "@lezer/highlight";
import { insertNewlineAndIndent, toggleComment } from "@codemirror/commands";

vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/core", async (orig) => ({ ...(await orig<typeof import("@tauri-apps/api/core")>()), invoke: async () => null }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, listen: async () => () => {}, onFocusChanged: async () => () => {} }) }));

import "../state.svelte"; // first: the app's modules import each other in a cycle
import { LANGUAGES, indentFor, langFor } from "./languages";
import { makefileOpensRecipe, shellClosesBlock, shellOpensBlock, yamlIndentAfter } from "./configModes";
import { modeForPath } from "../modes";

const stateFor = (path: string, doc: string, cursor = doc.length) => {
  const lang = langFor(path)!;
  return EditorState.create({ doc, selection: { anchor: cursor }, extensions: [lang.ext(), indentFor(lang)] });
};

/** The document after pressing Enter at its end. */
function enter(path: string, doc: string) {
  let state = stateFor(path, doc);
  insertNewlineAndIndent({ state, dispatch: (tr) => (state = tr.state) });
  return state.doc.toString();
}

function comment(path: string, doc: string) {
  let state = stateFor(path, doc, 0);
  toggleComment({ state, dispatch: (tr) => (state = tr.state) });
  return state.doc.toString();
}

/** Text of the tokens the mode gives a highlight tag. */
function highlighted(path: string, doc: string) {
  const state = stateFor(path, doc);
  const tree = ensureSyntaxTree(state, doc.length, 5000) ?? syntaxTree(state);
  const style = HighlightStyle.define([{ tag: Object.values(tags).filter((t): t is typeof tags.keyword => typeof t !== "function"), class: "x" }]);
  const out: string[] = [];
  highlightTree(tree, style, (from, to) => out.push(doc.slice(from, to)));
  return out;
}

describe("file detection", () => {
  test.each([
    ["q.sql", "sql"], ["a.yaml", "yaml"], ["a.yml", "yaml"], [".gitlab-ci.yml", "yaml"],
    ["a.sh", "shell"], ["a.bash", "shell"], ["a.zsh", "shell"], [".bashrc", "shell"], [".zshrc", "shell"], [".profile", "shell"],
    ["Dockerfile", "dockerfile"], ["dockerfile", "dockerfile"], ["Containerfile", "dockerfile"], ["Dockerfile.dev", "dockerfile"], ["api.dockerfile", "dockerfile"],
    ["a.xml", "xml"], ["a.xsd", "xml"], ["a.svg", "xml"],
    ["Makefile", "makefile"], ["makefile", "makefile"], ["GNUmakefile", "makefile"], ["rules.mk", "makefile"], ["Makefile.am", "makefile"],
  ])("%s is %s and opens in Code mode", (name, id) => {
    expect(langFor(`/w/${name}`)?.id).toBe(id);
    expect(modeForPath(`/w/${name}`)).toBe("code");
  });

  test("a real extension wins over a name that looks like a build file", () => {
    expect(langFor("/w/Dockerfile.py")?.id).toBe("python");
    expect(langFor("/w/Makefile.txt")).toBeNull();
    expect(modeForPath("/w/Makefile.txt")).toBe("text");
    expect(modeForPath("/w/Dockerfile.md")).toBe("markdown");
    expect(langFor("/w/Dockerfile.md")).toBeNull();
    expect(langFor("/w/Dockerfile.dockerignore")).toBeNull();
  });

  test("other extensionless files stay unknown", () => {
    expect(langFor("/w/README")).toBeNull();
    expect(modeForPath("/w/LICENSE")).toBeNull();
  });

  test("all six are in the picker, without language server or debugger", () => {
    for (const id of ["sql", "yaml", "shell", "dockerfile", "xml", "makefile"]) {
      const l = LANGUAGES.find((x) => x.id === id);
      expect(l, id).toBeTruthy();
      expect(l!.server).toBeNull();
    }
  });
});

describe("highlighting", () => {
  test.each([
    ["q.sql", "SELECT 1 FROM t; -- note", ["SELECT", "-- note"]],
    ["a.yaml", "key: value # note", ["key", "# note"]],
    ["a.sh", 'if true; then echo "hi"; fi # note', ["if", '"hi"', "# note"]],
    ["Dockerfile", "FROM alpine\n# note", ["FROM", "# note"]],
    ["a.xml", "<a b=\"c\"><!-- note --></a>", ["a", '"c"']],
    ["Makefile", "CC := gcc\nall: a.o\n\t$(CC) -o \"x\" # note\n", ["CC", "all", "$(CC)", '"x"', "# note"]],
  ])("%s", (path, doc, tokens) => {
    const seen = highlighted(path, doc);
    for (const t of tokens) expect(seen.join("\n"), t).toContain(t);
  });
});

describe("comment toggling", () => {
  test.each([
    ["q.sql", "SELECT 1", "-- SELECT 1"],
    ["a.yaml", "a: 1", "# a: 1"],
    ["a.sh", "echo", "# echo"],
    ["Dockerfile", "FROM x", "# FROM x"],
    ["Makefile", "all: x", "# all: x"],
    ["a.xml", "<a/>", "<!-- <a/> -->"],
  ])("%s", (path, doc, want) => {
    expect(comment(path, doc)).toBe(want);
    expect(comment(path, want)).toBe(doc);
  });
});

describe("indentation", () => {
  test("Makefile recipes use a tab, even in a file indented with spaces", () => {
    expect(stateFor("Makefile", "a:\n    b\n    c\n").facet(indentUnit)).toBe("\t");
    expect(enter("Makefile", "all: dep")).toBe("all: dep\n\t");
    expect(enter("Makefile", "all:\n\tcc a")).toBe("all:\n\tcc a\n\t");
  });

  test("Makefile assignments and special targets have no recipe", () => {
    expect(enter("Makefile", "CC := gcc")).toBe("CC := gcc\n");
    expect(enter("Makefile", ".PHONY: all")).toBe(".PHONY: all\n");
    for (const l of ["X = 1", "X ?= 1", "X := 1", "X ::= 1", "X :::= 1", "# all: x", "\tcc", "a: B = 1", "a: \\"]) expect(makefileOpensRecipe(l), l).toBe(false);
    for (const l of ["all:", "all: dep", "a b: c", "%.o: %.c", "a:: b"]) expect(makefileOpensRecipe(l), l).toBe(true);
  });

  test("YAML goes in after a key and lines up under a list item", () => {
    expect(enter("a.yaml", "jobs:")).toBe("jobs:\n  ");
    expect(enter("a.yaml", "a: 1")).toBe("a: 1\n");
    expect(enter("a.yaml", "- name: x")).toBe("- name: x\n  ");
    expect(enter("a.yaml", "run: |")).toBe("run: |\n  ");
    expect(yamlIndentAfter('a: "b:"', 2)).toBe(0);
    expect(yamlIndentAfter("a: 1 # note:", 2)).toBe(0);
  });

  test("YAML never indents with tabs", () => {
    expect(stateFor("a.yaml", "a:\n\tb: 1\n\tc: 2").facet(indentUnit)).toBe("  ");
  });

  test("Shell goes in after an opener and back out at its closer", () => {
    expect(enter("a.sh", "if x; then")).toBe("if x; then\n  ");
    expect(enter("a.sh", "for i in a; do")).toBe("for i in a; do\n  ");
    expect(enter("a.sh", "f() {")).toBe("f() {\n  ");
    expect(enter("a.sh", "case $x in")).toBe("case $x in\n  ");
    expect(enter("a.sh", "echo done")).toBe("echo done\n");
    expect(shellOpensBlock('echo "then"')).toBe(false);
    expect(shellOpensBlock("echo x # then")).toBe(false);
    for (const t of ["fi", "done", "esac", "else", "elif x", "}", ")"]) expect(shellClosesBlock(t), t).toBe(true);
    expect(shellClosesBlock("finish")).toBe(false);
    const state = stateFor("a.sh", "if x; then\n  a\nfi");
    expect(getIndentation(state, state.doc.line(3).from)).toBe(0);
  });

  test("Dockerfile continuations go in once and return after the last one", () => {
    expect(enter("Dockerfile", "RUN a \\")).toBe("RUN a \\\n    ");
    expect(enter("Dockerfile", "RUN a \\\n    b \\")).toBe("RUN a \\\n    b \\\n    ");
    expect(enter("Dockerfile", "RUN a \\\n    b")).toBe("RUN a \\\n    b\n");
  });

  test("XML indents inside an element", () => {
    expect(enter("a.xml", "<a>")).toBe("<a>\n  ");
  });

  test("indentString keeps the Makefile tab", () => {
    const s = stateFor("Makefile", "");
    expect(indentString(s, s.tabSize)).toBe("\t");
  });
});
