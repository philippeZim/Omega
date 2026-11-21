import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { WikiLink } from "./syntax";
import { livePreview, resolvePath, toggleWrap, wikiHref } from "./livePreview";

describe("resolvePath", () => {
  const from = "/home/me/notes/index.md";

  test("relative paths resolve against the file's folder", () => {
    expect(resolvePath("other.md", from)).toBe("/home/me/notes/other.md");
    expect(resolvePath("./sub/a.md", from)).toBe("/home/me/notes/sub/a.md");
    expect(resolvePath("../x/./y.png", from)).toBe("/home/me/x/y.png");
  });

  test(".. never climbs above the root", () => {
    expect(resolvePath("../../../../../a.md", from)).toBe("/a.md");
    expect(resolvePath("a.md", "/top.md")).toBe("/a.md");
  });

  test("absolute paths ignore fromPath (and work without one)", () => {
    expect(resolvePath("/etc//hosts", null)).toBe("/etc/hosts");
    expect(resolvePath("/a/../b", from)).toBe("/b");
  });

  test("strips the #fragment", () => {
    expect(resolvePath("other.md#Heading", from)).toBe("/home/me/notes/other.md");
  });

  test("decodes percent escapes", () => {
    expect(resolvePath("my%20file.md", from)).toBe("/home/me/notes/my file.md");
  });

  test("Windows drive paths keep their drive and use /", () => {
    expect(resolvePath("C:\\Users\\me\\a.md", null)).toBe("C:/Users/me/a.md");
    expect(resolvePath("D:/x/../y.md", from)).toBe("D:/y.md");
    expect(resolvePath("..\\img\\p.png", "C:/proj/docs/readme.md")).toBe("C:/proj/img/p.png");
  });

  test("URLs with a scheme are not file paths", () => {
    expect(resolvePath("https://example.com/a.md", from)).toBeNull();
    expect(resolvePath("mailto:me@example.com", from)).toBeNull();
    expect(resolvePath("file:///tmp/a", from)).toBeNull();
  });

  test("relative link from an unsaved file has no target", () => {
    expect(resolvePath("a.md", null)).toBeNull();
  });

  // #26: decodeURI threw URIError on a lone "%" (e.g. "100%.md"), so the link handler / image widget threw.
  test("a literal % that is not an escape does not throw", () => {
    expect(resolvePath("100%.md", from)).toBe("/home/me/notes/100%.md");
    expect(resolvePath("img/50% off.png", from)).toBe("/home/me/notes/img/50% off.png");
    expect(resolvePath("100%.md#Top", from)).toBe("/home/me/notes/100%.md");
  });
});

// ------------------------------------------------------------ formatting commands

/** Applies toggleWrap(marker) to `doc`, where the selection is written as [ … ]. */
function wrap(doc: string, marker: string): string {
  const from = doc.indexOf("["), to = doc.indexOf("]") - 1;
  const view = new EditorView({
    state: EditorState.create({ doc: doc.replace("[", "").replace("]", ""), selection: { anchor: from, head: to } }),
  });
  toggleWrap(marker)(view);
  const { state } = view;
  const r = state.selection.main;
  const out = state.doc.toString();
  view.destroy();
  return out.slice(0, r.from) + "[" + out.slice(r.from, r.to) + "]" + out.slice(r.to);
}

describe("toggleWrap", () => {
  test("wraps and unwraps", () => {
    expect(wrap("a [b] c", "*")).toBe("a *[b]* c");
    expect(wrap("a *[b]* c", "*")).toBe("a [b] c");
    expect(wrap("a **[b]** c", "**")).toBe("a [b] c");
    expect(wrap("a ~~[b]~~ c", "~~")).toBe("a [b] c");
  });

  // #41: italic on a bold word removed one "*" on each side, so bold turned into italic.
  test("italic on bold gives bold-italic and back", () => {
    expect(wrap("word **[bold]** x", "*")).toBe("word ***[bold]*** x");
    expect(wrap("word ***[bold]*** x", "*")).toBe("word **[bold]** x");
  });

  test("bold on italic / bold-italic", () => {
    expect(wrap("a *[b]* c", "**")).toBe("a ***[b]*** c");
    expect(wrap("a ***[b]*** c", "**")).toBe("a *[b]* c");
  });

  // #94: selecting *b* with its markers and pressing Italic gave **b**.
  test("markers inside the selection are unwrapped", () => {
    expect(wrap("a [*b*] c", "*")).toBe("a [b] c");
    expect(wrap("a [**b**] c", "**")).toBe("a [b] c");
    expect(wrap("a [***b***] c", "*")).toBe("a [**b**] c");
    expect(wrap("a [**b**] c", "*")).toBe("a *[**b**]* c");
    expect(wrap("a [**] c", "*")).toBe("a *[**]* c");
  });

  // #94: "_" inside a word is not emphasis, so it must not be removed.
  test("underscores inside a word are left alone", () => {
    expect(wrap("snake_[case]_x", "_")).toBe("snake__[case]__x");
    expect(wrap("snake[_case_]x", "_")).toBe("snake_[_case_]_x");
    expect(wrap("a _[b]_ c", "_")).toBe("a [b] c");
  });
});

// ------------------------------------------------------------ rendered links

/** Renders `doc` with the cursor on an extra last line; [text, data-href] of every rendered link. */
function links(doc: string): [string, string | undefined][] {
  const text = doc + "\n\nend";
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.length },
      extensions: [markdown({ base: markdownLanguage, extensions: [WikiLink] }), livePreview("/n/index.md")],
    }),
    parent: document.body,
  });
  // The initial parse has a time budget; under load it may stop before the reference definitions.
  forceParsing(view, text.length, 5000);
  const out = [...view.dom.querySelectorAll<HTMLElement>(".md-link")].map((e): [string, string | undefined] => [e.textContent!, e.dataset.href]);
  view.destroy();
  return out;
}

describe("rendered links", () => {
  test("inline link", () => {
    expect(links("[a](notes/a.md)")).toEqual([["a", "notes/a.md"]]);
  });

  // #43: the <…> brackets of a CommonMark angle destination ended up in the path.
  test("angle-bracket destination drops the brackets", () => {
    expect(links("[Angle](<notes/with space.md>)")).toEqual([["Angle", "notes/with space.md"]]);
    expect(links("[r][a]\n\n[a]: <notes/with space.md>")).toEqual([["r", "notes/with space.md"]]);
  });

  // #44: reference links were styled as links but had no target.
  test("reference links resolve their definition", () => {
    const defs = "\n\n[a]: notes/second.md\n[Big  Label]: b.md";
    expect(links("[r][a]" + defs)).toEqual([["r", "notes/second.md"]]);
    expect(links("[a][]" + defs)).toEqual([["a", "notes/second.md"]]);
    expect(links("[A]" + defs)).toEqual([["A", "notes/second.md"]]);
    expect(links("[x][big label]" + defs)).toEqual([["x", "b.md"]]);
  });

  test("brackets without a definition are plain text", () => {
    expect(links("see [x] and [y][z]")).toEqual([]);
  });

  // #44: [[wiki links]] showed as "[Wiki link]" with no target.
  test("wiki links", () => {
    expect(links("- [[Wiki link]]")).toEqual([["Wiki link", "Wiki link.md"]]);
    expect(links("[[notes/second|the second]]")).toEqual([["the second", "notes/second.md"]]);
    expect(links("[[Note#Part]] [[pic.png]]")).toEqual([["Note#Part", "Note.md#Part"], ["pic.png", "pic.png"]]);
  });

  test("a bracketed link text is not a wiki link", () => {
    expect(links("[[PDF]](file.pdf)")).toEqual([["[PDF]", "file.pdf"]]);
    expect(links("[[1]][r]\n\n[r]: u.md")).toEqual([["[1]", "u.md"]]);
  });
});

describe("wikiHref", () => {
  test("adds .md, keeps the fragment and a literal %", () => {
    expect(wikiHref("a b")).toBe("a b.md");
    expect(wikiHref("x.pdf")).toBe("x.pdf");
    expect(wikiHref("#Top")).toBe("#Top");
    expect(wikiHref("100%")).toBe("100%25.md");
  });
});

// ------------------------------------------------------------ blockquotes

/** Renders `doc` with the cursor on an extra last line; the --qd style of every quoted line ("" for level 1). */
function quoteLines(doc: string): string[] {
  const text = doc + "\n\nend";
  const view = new EditorView({
    state: EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [markdown({ base: markdownLanguage }), livePreview(null)] }),
    parent: document.body,
  });
  forceParsing(view, text.length, 5000);
  const out = [...view.dom.querySelectorAll<HTMLElement>(".cm-line.md-quote")].map((e) => e.style.getPropertyValue("--qd").trim());
  view.destroy();
  return out;
}

describe("blockquotes", () => {
  // #47: a nested quote got the same single-level styling as its parent.
  test("nested quote lines carry their depth", () => {
    expect(quoteLines("> A quote\n> > nested quote\n> > > deeper")).toEqual(["", "2", "3"]);
  });
});
