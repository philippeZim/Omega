import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { BlockMath, Highlight, InlineMath, WikiLink } from "./syntax";

const lang = markdown({ base: markdownLanguage, extensions: [Highlight, InlineMath, BlockMath, WikiLink] });

/** [node name, text] for every node of the given names. */
function nodes(doc: string, ...names: string[]): [string, string][] {
  const state = EditorState.create({ doc, extensions: [lang] });
  const tree = ensureSyntaxTree(state, doc.length, 5000)!;
  const out: [string, string][] = [];
  tree.iterate({
    enter: (n) => {
      if (names.includes(n.name)) out.push([n.name, doc.slice(n.from, n.to)]);
    },
  });
  return out;
}

describe("==highlight==", () => {
  test("basic, with marks", () => {
    expect(nodes("a ==marked== b", "Highlight", "HighlightMark")).toEqual([
      ["Highlight", "==marked=="],
      ["HighlightMark", "=="],
      ["HighlightMark", "=="],
    ]);
  });
  test("whitespace inside the delimiters is not a highlight", () => {
    expect(nodes("a == b == c", "Highlight")).toEqual([]);
  });
  // regression #31: the guard only looked forward, so the retry one char later made "===x===" a Highlight "==x===".
  test("=== is not a delimiter", () => {
    expect(nodes("a ===x=== b", "Highlight")).toEqual([]);
    expect(nodes("a ===x== b", "Highlight")).toEqual([]);
  });
  test("nests with emphasis", () => {
    expect(nodes("==**bold**==", "Highlight", "StrongEmphasis")).toEqual([
      ["Highlight", "==**bold**=="],
      ["StrongEmphasis", "**bold**"],
    ]);
  });
});

describe("$inline math$", () => {
  test("basic", () => {
    expect(nodes("see $a^2$ here", "InlineMath")).toEqual([["InlineMath", "$a^2$"]]);
  });
  test("money is not math (whitespace inside the dollars)", () => {
    expect(nodes("costs $5 and $6 total", "InlineMath")).toEqual([]);
    expect(nodes("$ x$", "InlineMath")).toEqual([]);
  });
  test("escaped dollars", () => {
    expect(nodes("\\$a$ b", "InlineMath")).toEqual([]);
    expect(nodes("$a\\$b$", "InlineMath")).toEqual([["InlineMath", "$a\\$b$"]]);
  });
  // regression #31: the guard only rejected at the first "$"; the retry at the second one parsed "$$y$$" as "$" + InlineMath "$y$" + "$".
  // Inline "$$" is not math at all: display math is only the $$ block at line start.
  test("$$ inline is not inline math", () => {
    expect(nodes("x $$y$$ z", "InlineMath")).toEqual([]);
    expect(nodes("x $$y$ z", "InlineMath")).toEqual([]);
  });
  test("unclosed", () => {
    expect(nodes("$abc", "InlineMath")).toEqual([]);
  });
  test("math content is not parsed as emphasis", () => {
    expect(nodes("$a*b*c$", "InlineMath", "Emphasis")).toEqual([["InlineMath", "$a*b*c$"]]);
  });
});

describe("$$block math$$", () => {
  test("multi-line block", () => {
    expect(nodes("text\n\n$$\nx^2\n$$\nafter", "BlockMath", "BlockMathMark")).toEqual([
      ["BlockMath", "$$\nx^2\n$$"],
      ["BlockMathMark", "$$"],
      ["BlockMathMark", "$$"],
    ]);
  });
  test("one-liner", () => {
    expect(nodes("$$ x^2 $$\n", "BlockMath")).toEqual([["BlockMath", "$$ x^2 $$"]]);
  });
  test("unclosed block runs to the end of the document", () => {
    expect(nodes("$$\na\nb", "BlockMath")).toEqual([["BlockMath", "$$\na\nb"]]);
  });
  test("text after the block is a paragraph again", () => {
    const n = nodes("$$\na\n$$\nafter", "BlockMath", "Paragraph");
    expect(n).toEqual([["BlockMath", "$$\na\n$$"], ["Paragraph", "after"]]);
  });
});

describe("[[wiki links]]", () => {
  test("node with marks", () => {
    expect(nodes("see [[a b|c]] x", "WikiLink", "WikiLinkMark", "Link")).toEqual([
      ["WikiLink", "[[a b|c]]"],
      ["WikiLinkMark", "[["],
      ["WikiLinkMark", "]]"],
    ]);
  });
  test("empty, unclosed or multi-line is not a wiki link", () => {
    expect(nodes("[[]] [[a\nb]] [[c", "WikiLink")).toEqual([]);
    expect(nodes("[[PDF]](file.pdf) [[1]][r]", "WikiLink")).toEqual([]);
  });
  test("[[text]](url) and [[text]][label] are whole links", () => {
    expect(nodes("[[PDF]](file.pdf) [[1]][r]", "Link", "URL", "LinkLabel")).toEqual([
      ["Link", "[[PDF]](file.pdf)"],
      ["URL", "file.pdf"],
      ["Link", "[[1]][r]"],
      ["LinkLabel", "[r]"],
    ]);
  });
});
