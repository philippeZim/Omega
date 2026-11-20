import { afterEach, describe, expect, test } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EDITOR_COMMANDS } from "./editorCommands";
import { dictionaries } from "./i18n/strings";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Creates a view; "|" marks cursors, "[…]" a selection. */
function make(src: string) {
  const ranges: { anchor: number; head: number }[] = [];
  let doc = "";
  let selStart = -1;
  for (const ch of src) {
    if (ch === "|") ranges.push({ anchor: doc.length, head: doc.length });
    else if (ch === "[") selStart = doc.length;
    else if (ch === "]") ranges.push({ anchor: selStart, head: doc.length });
    else doc += ch;
  }
  const selection = EditorSelection.create((ranges.length ? ranges : [{ anchor: 0, head: 0 }]).map((r) => EditorSelection.range(r.anchor, r.head)));
  view = new EditorView({ state: EditorState.create({ doc, selection, extensions: [EditorState.allowMultipleSelections.of(true)] }), parent: document.body });
  return view;
}

/** Doc with the selection marked the same way. */
function show(v: EditorView) {
  const { doc, selection } = v.state;
  let s = doc.toString();
  for (const r of [...selection.ranges].sort((a, b) => b.from - a.from)) s = r.empty ? s.slice(0, r.from) + "|" + s.slice(r.from) : s.slice(0, r.from) + "[" + s.slice(r.from, r.to) + "]" + s.slice(r.to);
  return s;
}

const run = (id: string, src: string) => {
  const v = make(src);
  const ok = EDITOR_COMMANDS.find((c) => c.id === id)!.run(v);
  return { ok, out: show(v), doc: v.state.doc.toString() };
};

describe("registry", () => {
  test("unique ids with labels", () => {
    const ids = EDITOR_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect((dictionaries.en as Record<string, string>)[`commands.cmd.${id}`], id).toBeTruthy();
  });
});

describe("custom editor commands", () => {
  test("cursorsAtLineEnds", () => {
    expect(run("editor.cursorsAtLineEnds", "[ab\ncd\ne]f")).toMatchObject({ ok: true, out: "ab|\ncd|\nef|" });
    expect(run("editor.cursorsAtLineEnds", "a|b").ok).toBe(false);
  });

  test("insertLineAbove keeps the indentation", () => {
    expect(run("editor.insertLineAbove", "x\n    fo|o").out).toBe("x\n    |\n    foo");
  });

  test("duplicate: the line without a selection, else the selection (selecting the copy)", () => {
    expect(run("editor.duplicate", "a|b\nc").out).toBe("ab\na|b\nc");
    expect(run("editor.duplicate", "x[ab]y").out).toBe("xab[ab]y");
  });

  test("joinLines drops the next line's indentation", () => {
    expect(run("editor.joinLines", "fo|o\n    bar\nbaz").out).toBe("foo| bar\nbaz");
    expect(run("editor.joinLines", "last|").out).toBe("last|");
  });

  test("joinLines joins every line of a multi-line selection and keeps it selected", () => {
    expect(run("editor.joinLines", "a[aa\nbbb\nc]cc\nddd").out).toBe("a[aa bbb c]cc\nddd");
    // Ending at the start of a line (Shift+Down) leaves that line alone.
    expect(run("editor.joinLines", "[aaa\nbbb\n]ccc").out).toBe("[aaa bbb\n]ccc");
    // A selection within one line still joins with the next line.
    expect(run("editor.joinLines", "[aa]a\nbbb").out).toBe("[aa]a bbb");
  });

  test("sortLines sorts the selected lines", () => {
    expect(run("editor.sortLines", "x[c\na\nb]").doc).toBe("a\nb\nxc");
    expect(run("editor.sortLines", "only|").doc).toBe("only");
    expect(run("editor.sortLines", "|").ok).toBe(false);
  });

  test("upper / lower case", () => {
    expect(run("editor.upperCase", "a[bc]d").out).toBe("a[BC]d");
    expect(run("editor.lowerCase", "[ÄB]c").out).toBe("[äb]c");
  });
});
