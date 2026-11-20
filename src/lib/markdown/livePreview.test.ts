import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { livePreview, resolvePath, toggleWrap } from "./livePreview";

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
});

// ------------------------------------------------------------ // ------------------------------------------------------------ rendered links


/** Renders `doc` with the cursor on an extra last line, returns the data-href of every rendered link. */
function hrefs(doc: string): string[] {
  const text = doc + "\n\nend";
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      selection: { anchor: text.length },
      extensions: [markdown({ base: markdownLanguage }), livePreview("/n/index.md")],
    }),
    parent: document.body,
  });
  const out = [...view.dom.querySelectorAll<HTMLElement>("[data-href]")].map((e) => e.dataset.href!);
  view.destroy();
  return out;
}

describe("rendered links", () => {
  test("plain destination", () => {
    expect(hrefs("[a](notes/a.md)")).toEqual(["notes/a.md"]);
  });

  // #43: the <…> brackets of a CommonMark angle destination ended up in the path.
  test("angle-bracket destination drops the brackets", () => {
    expect(hrefs("[Angle](<notes/with space.md>)")).toEqual(["notes/with space.md"]);
  });
});
